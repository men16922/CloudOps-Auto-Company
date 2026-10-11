import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { CloudOperationError } from '../../../../packages/contracts/errors';
import { runbookCatalog, runbookCommandSchema, runbookExecutionSchema, runbookStates, type RunbookExecution, type RunbookRequestView, type RunbookState, type RunbookTarget } from '../../../../packages/contracts/aws/runbooks';
import type { CloudStore } from '../storage/store';
import type { OrganizationWebSession } from '../identity/web-access';
import type { OrganizationConnections } from '../connections/connections';

/** Server policy. Two-person approval is the default; self-approval exists only for single-operator verification. */
export const runbookPolicySchema = z.object({ allowSelfApproval: z.boolean().default(false) }).strict();
type Policy = z.infer<typeof runbookPolicySchema>;
type State = typeof runbookStates[number];
type Event = { at: string; action: string; by: string; note?: string };
type RequestRecord = {
  id: string; organizationId: string; workspaceId: string; configurationId: string; requester: string; runbook: keyof typeof runbookCatalog; target: RunbookTarget;
  reason: string; changeRef?: string; createdAt: string; state: State;
  decision?: { by: string; at: string; approved: boolean; note?: string };
  /** The requester's connection that started the execution (status is read back through it). */
  execution?: Partial<RunbookExecution> & { connectionId: string };
  events: Event[];
};
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const recordKey = (id: string) => `organization-runbook:${id}`;
const succeeded = new Set(['Success', 'CompletedWithSuccess']), failed = new Set(['Failed', 'TimedOut', 'CompletedWithFailure', 'Rejected', 'ChangeCalendarOverrideRejected']);
const denied = (code: string, message = 'This runbook action is not allowed.') => new CloudOperationError(403, code, message);

/** Runbook requests of one payer configuration (team queue): request → approval by another member → execution by the requester on
 * their own runbook permission set → status followed until it ends. Records are ordinary store records, not an immutable audit log. */
export class RunbookService {
  private readonly store: CloudStore;
  private readonly connections: OrganizationConnections;
  private readonly policy: Policy;
  private readonly now: () => number;
  private readonly followers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Gap between status reads of a running execution (tests shorten it). */
  followIntervalMs = 5_000;
  private closed = false;
  constructor(store: CloudStore, connections: OrganizationConnections, policy: unknown = {}, now = Date.now) {
    this.store = store; this.connections = connections; this.policy = runbookPolicySchema.parse(policy); this.now = now;
  }
  private indexKey(session: OrganizationWebSession, configurationId: string) { return `organization-runbook-index:${digest([session.context.owner, session.context.workspaceId, configurationId])}`; }
  private view(record: RequestRecord, actor: string): RunbookRequestView {
    const person = (id: string) => ({ self: id === actor, label: id.slice(-6) });
    const { connectionId: _, ...execution } = record.execution ?? { connectionId: '' };
    return { id: record.id, runbook: record.runbook, target: record.target, reason: record.reason, ...(record.changeRef ? { changeRef: record.changeRef } : {}), requester: person(record.requester),
      createdAt: record.createdAt, state: record.state, ...(record.decision ? { decision: { ...record.decision, by: person(record.decision.by) } } : {}),
      ...(record.execution ? { execution } : {}), events: record.events.map(event => ({ ...event, by: person(event.by) })) };
  }
  async state(session: OrganizationWebSession, connectionId: string): Promise<RunbookState> {
    const connection = await this.connections.ownedConnection(session, connectionId), actor = session.identity.actorId, roles = session.context.roles;
    const records = await this.store.transact(async tx => {
      const ids = await tx.get<string[]>(this.indexKey(session, connection.configurationId)) ?? [];
      return (await Promise.all(ids.slice(0, 100).map(id => tx.get<RequestRecord>(recordKey(id))))).filter((value): value is RequestRecord => Boolean(value));
    });
    const runbooks = connection.binding.runbooks;
    return { enabled: Boolean(runbooks), allowed: runbooks?.allowed ?? [], canRequest: Boolean(runbooks) && roles.includes('operator'), canApprove: roles.includes('reviewer'),
      selfApproval: this.policy.allowSelfApproval, requests: records.map(record => this.view(record, actor)) };
  }
  async command(session: OrganizationWebSession, connectionId: string, input: unknown): Promise<RunbookState> {
    const { requestKey, ...rest } = z.object({ requestKey: z.uuid() }).loose().parse(input), command = runbookCommandSchema.parse(rest);
    const connection = await this.connections.ownedConnection(session, connectionId), actor = session.identity.actorId, roles = session.context.roles;
    const retryKey = `organization-runbook-request:${digest([session.context.owner, session.context.workspaceId, actor, requestKey])}`, fingerprint = digest(command);
    const prior = await this.store.transact(tx => tx.get<{ fingerprint: string }>(retryKey));
    if (prior) { if (prior.fingerprint !== fingerprint) throw new CloudOperationError(409, 'request_key_conflict', 'Use a new request identifier.'); return this.state(session, connectionId); }
    const at = new Date(this.now()).toISOString();
    if (command.operation === 'request') {
      const runbooks = connection.binding.runbooks;
      if (!runbooks) throw new CloudOperationError(409, 'runbooks_not_configured', 'Runbooks are not configured for this payer.');
      if (!roles.includes('operator')) throw denied('runbook_operator_required', 'Requesting a runbook needs the operator role.');
      if (!runbooks.allowed.includes(command.runbook)) throw denied('runbook_not_allowed');
      const target = await this.checkedTarget(connection, command.runbook, command.target);
      const record: RequestRecord = { id: randomUUID(), organizationId: connection.binding.organizationId, workspaceId: connection.binding.workspaceId, configurationId: connection.configurationId,
        requester: actor, runbook: command.runbook, target, reason: command.reason, ...(command.changeRef ? { changeRef: command.changeRef } : {}), createdAt: at, state: 'pending',
        events: [{ at, action: 'requested', by: actor }] };
      await this.store.transact(async tx => {
        const index = this.indexKey(session, connection.configurationId), ids = await tx.get<string[]>(index) ?? [];
        // A concurrent retry with the same key may have created the request first.
        if (await tx.get(retryKey) || await tx.get(recordKey(record.id))) return;
        tx.put(recordKey(record.id), record); tx.put(index, [record.id, ...ids].slice(0, 200)); tx.put(retryKey, { fingerprint });
      });
      return this.state(session, connectionId);
    }
    const update = (change: (record: RequestRecord) => RequestRecord | undefined) => this.store.transact(async tx => {
      const record = await tx.get<RequestRecord>(recordKey(command.requestId));
      if (await tx.get(retryKey)) throw new CloudOperationError(409, 'request_key_conflict', 'Use a new request identifier.');
      if (!record || record.organizationId !== connection.binding.organizationId || record.workspaceId !== connection.binding.workspaceId || record.configurationId !== connection.configurationId) {
        throw new CloudOperationError(404, 'runbook_request_not_found', 'The runbook request was not found.');
      }
      const next = change(record);
      if (next) tx.put(recordKey(record.id), next);
      tx.put(retryKey, { fingerprint });
      return next ?? record;
    });
    if (command.operation === 'approve' || command.operation === 'reject') {
      if (!roles.includes('reviewer')) throw denied('runbook_reviewer_required', 'Approving needs the reviewer role.');
      await update(record => {
        if (record.state !== 'pending') throw new CloudOperationError(409, 'runbook_request_not_pending', 'The request is no longer pending.');
        if (record.requester === actor && !this.policy.allowSelfApproval) throw denied('self_approval_not_allowed', 'Another member must approve this request.');
        const approved = command.operation === 'approve';
        return { ...record, state: approved ? 'approved' : 'rejected', decision: { by: actor, at, approved, ...(command.note ? { note: command.note } : {}) },
          events: [...record.events, { at, action: approved ? 'approved' : 'rejected', by: actor, ...(command.note ? { note: command.note } : {}) }].slice(-50) };
      });
    } else if (command.operation === 'cancel') {
      await update(record => {
        if (record.requester !== actor) throw denied('runbook_requester_required', 'Only the requester can cancel.');
        if (record.state !== 'pending' && record.state !== 'approved') throw new CloudOperationError(409, 'runbook_request_closed', 'The request can no longer be cancelled.');
        return { ...record, state: 'cancelled', events: [...record.events, { at, action: 'cancelled', by: actor }].slice(-50) };
      });
    } else if (command.operation === 'execute') {
      if (!roles.includes('operator') || !connection.binding.runbooks) throw denied('runbook_operator_required', 'Executing a runbook needs the operator role.');
      const reserved = await update(record => {
        if (record.requester !== actor) throw denied('runbook_requester_required', 'Only the requester runs an approved request.');
        if (record.state !== 'approved') throw new CloudOperationError(409, 'runbook_request_not_approved', 'The request is not approved.');
        return { ...record, state: 'starting', execution: { connectionId }, events: [...record.events, { at, action: 'starting', by: actor }].slice(-50) };
      });
      await this.start(reserved, connection, actor);
    } else {
      const record = await update(() => undefined);
      if (record.state === 'running' && record.execution?.executionId) await this.poll(record.id);
    }
    return this.state(session, connectionId);
  }
  /** EC2 targets must be an instance the requester's own sync saw in that account and region; other runbooks run on the payer itself. */
  private async checkedTarget(connection: Awaited<ReturnType<OrganizationConnections['ownedConnection']>>, runbook: keyof typeof runbookCatalog, target: RunbookTarget): Promise<RunbookTarget> {
    if (runbookCatalog[runbook].target === 'none') {
      if (target.accountId !== connection.binding.accountId || target.region !== connection.binding.region || target.instanceId) throw new CloudOperationError(400, 'invalid_runbook_target', 'This runbook runs on the payer account and region.');
      return { accountId: target.accountId, region: target.region };
    }
    if (!target.instanceId) throw new CloudOperationError(400, 'invalid_runbook_target', 'Choose an EC2 instance.');
    const instance = (await this.connections.cachedUnits(connection.scope)).filter(unit => unit.service === 'ec2' && unit.accountId === target.accountId && unit.region === target.region)
      .flatMap(unit => unit.items).find(item => item.id === target.instanceId);
    if (!instance) throw new CloudOperationError(409, 'runbook_target_not_synced', 'The instance is not in your synced inventory. Sync first.');
    return { accountId: target.accountId, region: target.region, instanceId: target.instanceId, name: instance.name.slice(0, 256) };
  }
  private async patch(id: string, change: (record: RequestRecord) => RequestRecord) {
    return this.store.transact(async tx => { const record = await tx.get<RequestRecord>(recordKey(id)); if (!record) return undefined; const next = change(record); tx.put(recordKey(id), next); return next; });
  }
  /** One start, never retried: a rejected start is closed (or reopened when the worker was only busy), a lost reply stays unknown. */
  private async start(record: RequestRecord, connection: Awaited<ReturnType<OrganizationConnections['ownedConnection']>>, actor: string) {
    const at = () => new Date(this.now()).toISOString(), event = (action: string, note?: string): Event => ({ at: at(), action, by: actor, ...(note ? { note } : {}) });
    // Nothing is sent unless the requester's AWS session is live; a missing session reopens the approved request.
    const status = await this.connections.workerCall(connection.binding.connectionId, { id: randomUUID(), operation: 'status' }).catch(() => undefined);
    const live = status?.response.ok && z.object({ status: z.string() }).loose().safeParse(status.response.result).data?.status === 'connected';
    if (!live) {
      await this.patch(record.id, value => ({ ...value, state: 'approved', execution: undefined, events: [...value.events, event('start-blocked', 'aws_session_required')].slice(-50) }));
      throw new CloudOperationError(409, 'aws_session_required', 'Sign in to AWS before running the runbook.');
    }
    try {
      if (record.target.instanceId) await this.checkedTarget(connection, record.runbook, record.target);
      const { response } = await this.connections.workerCall(connection.binding.connectionId, { id: randomUUID(), operation: 'runbook-start',
        runbook: { id: record.runbook, accountId: record.target.accountId, region: record.target.region, ...(record.target.instanceId ? { instanceId: record.target.instanceId } : {}) } });
      if (!response.ok) {
        const code = /^[a-z_]{1,64}$/.test(response.code) ? response.code : 'worker_rejected';
        await this.patch(record.id, value => code === 'connection_busy'
          ? { ...value, state: 'approved', execution: undefined, events: [...value.events, event('start-busy')].slice(-50) }
          : { ...value, state: 'failed', execution: { connectionId: connection.binding.connectionId, failure: code }, events: [...value.events, event('start-failed', code)].slice(-50) });
        throw new CloudOperationError(409, code, 'The runbook could not be started.');
      }
      const started = z.object({ executionId: runbookExecutionSchema.shape.executionId }).strict().parse(response.result);
      await this.patch(record.id, value => ({ ...value, state: 'running', execution: { connectionId: connection.binding.connectionId, executionId: started.executionId, status: 'InProgress', startedAt: at() },
        events: [...value.events, event('started')].slice(-50) }));
      this.follow(record.id);
    } catch (error) {
      if (error instanceof CloudOperationError && (error.status === 409 || error.code === 'runbook_target_not_synced')) {
        if (error.code === 'runbook_target_not_synced') await this.patch(record.id, value => ({ ...value, state: 'approved', execution: undefined, events: [...value.events, event('start-blocked', error.code)].slice(-50) }));
        throw error;
      }
      await this.patch(record.id, value => ({ ...value, state: 'unknown', events: [...value.events, event('start-unknown')].slice(-50) }));
      throw new CloudOperationError(409, 'runbook_start_unknown', 'Whether the runbook started is unknown. Check the execution in AWS before requesting again.');
    }
  }
  /** Reads the execution status once through the requester's connection and records it; ends the request on a final status. */
  private async poll(id: string): Promise<boolean> {
    const record = await this.store.transact(tx => tx.get<RequestRecord>(recordKey(id)));
    if (!record || record.state !== 'running' || !record.execution?.executionId) return true;
    const { response } = await this.connections.workerCall(record.execution.connectionId, { id: randomUUID(), operation: 'runbook-status',
      execution: { id: record.execution.executionId, accountId: record.target.accountId, region: record.target.region } });
    if (!response.ok) return false;
    const execution = runbookExecutionSchema.parse(response.result), at = new Date(this.now()).toISOString();
    const state: State = succeeded.has(execution.status) ? 'succeeded' : execution.status === 'Cancelled' ? 'cancelled' : failed.has(execution.status) ? 'failed' : 'running';
    await this.patch(id, value => ({ ...value, state, execution: { ...value.execution!, ...execution },
      events: state === 'running' ? value.events : [...value.events, { at, action: state, by: value.requester, ...(execution.failure ? { note: execution.failure } : {}) }].slice(-50) }));
    return state !== 'running';
  }
  private follow(id: string) {
    if (this.closed || this.followers.has(id)) return;
    const started = this.now();
    const schedule = () => { const timer = setTimeout(() => void step(), this.followIntervalMs); timer.unref(); this.followers.set(id, timer); };
    const step = async () => {
      let done = false;
      try { done = await this.poll(id); } catch { done = true; }
      this.followers.delete(id);
      if (!done && !this.closed && this.now() - started < 30 * 60_000) schedule();
    };
    schedule();
  }
  close() { this.closed = true; this.followers.forEach(timer => clearTimeout(timer)); this.followers.clear(); }
}
