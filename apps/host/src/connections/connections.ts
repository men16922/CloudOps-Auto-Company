import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { CloudOperationError } from '../../../../packages/contracts/errors';
import { OrganizationWebAccess, membershipKey, membershipSchema, type OrganizationWebSession } from '../identity/web-access';
import type { CloudStore, CloudTransaction } from '../storage/store';
import type { ObservationCache } from './observation-cache';
import { checkedDeviceLink, connectionStateSchema as stateSchema, connectionPageSchema as pageSchema } from '../../../../packages/contracts/aws/connections';
import { directorySnapshotSchema } from '../../../../packages/contracts/aws/directory';
import { inventoryUnitSchema, syncJobSchema, syncSummarySchema, type InventoryUnit, type SyncJob } from '../../../../packages/contracts/aws/inventory';
import { reportSnapshotSchema, type ReportSnapshot } from '../../../../packages/contracts/aws/report';
import { savedViewCommandSchema, savedViewSchema, type SavedView } from '../../../../packages/contracts/aws/saved-views';
import { bindingDigest, cliBindingSchema, cliReadSchema, type CliBinding } from '../../../../packages/worker-protocol/cli-contract';
import { reportSnapshot, retainSnapshots } from './report-snapshots';
import type { workerCommandSchema } from '../../../../packages/worker-protocol/commands';

/** Deployment policy. `requireLoginNameMatch`: the AWS (Identity Center) session name must equal the signed web login name. Off by default. */
export const identityPolicySchema = z.object({ requireLoginNameMatch: z.boolean().default(false) }).strict();
export const connectionConfigurationSchema = cliBindingSchema.omit({ actorId: true, connectionId: true, loginName: true }).extend({ configurationId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/), label: z.string().min(1).max(128) }).strict();
type Configuration = z.infer<typeof connectionConfigurationSchema>;
const connectionActionSchema = z.object({ requestKey: z.uuid(), operation: z.enum(['login', 'verify', 'inspect', 'directory', 'disconnect', 'logout', 'sync']), service: cliReadSchema.optional(), cursor: z.uuid().optional() }).strict().refine(value => (value.operation === 'inspect' ? Boolean(value.service) : value.service === undefined) && (value.operation === 'directory' || value.cursor === undefined));
type ConnectionAction = z.infer<typeof connectionActionSchema>;
/** Scheduled sync on the user's own delegated AWS session (no shared or service credentials). */
export const syncScheduleSchema = z.object({ syncEveryMinutes: z.number().int().min(30).max(1440) }).strict();
type SyncSchedule = z.infer<typeof syncScheduleSchema>;
type RecordValue = { binding: CliBinding; configurationId: string; digest: string; createdAt: string; enabled: boolean; activeRequest?: { key: string; deadline: number } };
type RequestValue = { fingerprint: string; state: 'pending' | 'completed' | 'failed' | 'unknown'; result?: unknown; code?: string };
type WorkerCommand = z.infer<typeof workerCommandSchema>;
/** Authenticated private transport must bind a worker/lease to this exact immutable binding. */
export interface OrganizationWorkerTransport {
  invoke(binding: CliBinding, command: WorkerCommand, signal: AbortSignal): Promise<{ ok: true; result: unknown } | { ok: false; code: string }>;
}
const unavailable = () => new CloudOperationError(404, 'connection_unavailable', 'The connection is not available.');
const uncertain = () => new CloudOperationError(409, 'worker_request_uncertain', 'The worker result is unknown. Check the connection before starting a new request.');
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const recordKey = (id: string) => `organization-connection:${id}`;
const scope = (session: OrganizationWebSession) => [session.context.owner, session.context.workspaceId, session.identity.actorId];
const unitKey = (unit: Pick<InventoryUnit, 'accountId' | 'region' | 'service'>) => `${unit.accountId}|${unit.region}|${unit.service}`;
const withoutUnits = ({ units: _, ...job }: SyncJob) => job;
function checkedJob(binding: CliBinding, result: unknown) {
  const job = syncJobSchema.parse(result);
  if (job.connectionId !== binding.connectionId || job.mode !== (binding.inventory?.config ? 'config' : 'direct')) throw unavailable();
  return job;
}
/** A unit must be the one the job listed (same id/account/region/service) and belong to an account the job enumerated within its scope. */
function checkedUnit(binding: CliBinding, job: SyncJob, ref: SyncJob['units'][number], result: unknown) {
  const value = z.object({ connectionId: z.uuid(), jobId: z.uuid(), unitId: z.uuid(), unit: inventoryUnitSchema }).strict().parse(result);
  if (value.connectionId !== binding.connectionId || value.jobId !== job.jobId || value.unitId !== ref.id || unitKey(value.unit) !== unitKey(ref)
    || !job.accounts.some(account => account.accountId === value.unit.accountId) || value.unit.items.length !== ref.count) throw unavailable();
  return value.unit;
}
function checkedResult(binding: CliBinding, operation: ConnectionAction['operation'] | 'status', result: unknown): unknown {
  if (operation === 'sync') return checkedJob(binding, result);
  if (operation === 'disconnect') return z.object({ disconnected: z.literal(true), cliCacheRetained: z.literal(true) }).strict().parse(result);
  if (operation === 'logout') return z.object({ disconnected: z.literal(true), remoteLogout: z.enum(['confirmed', 'unknown']) }).strict().parse(result);
  const value = operation === 'directory' ? directorySnapshotSchema.parse(result) : operation === 'inspect' ? pageSchema.parse(result) : stateSchema.parse(result);
  if ('scope' in value && (!binding.directory || value.scope.awsOrganizationId !== binding.directory.awsOrganizationId || value.scope.parentId !== binding.directory.parentId)) throw unavailable();
  if (value.connectionId !== binding.connectionId || value.accountId !== binding.accountId || value.region !== binding.region || ('roleName' in value && value.roleName !== binding.roleName)) throw unavailable();
  if ('verificationUri' in value && value.verificationUri) {
    const configured = new URL(binding.startUrl).hostname, region = (host: string) => host !== `device.sso.${binding.ssoRegion}.amazonaws.com` && host.startsWith('device.sso.');
    const portal = (host: string) => host === configured;
    if (region(new URL(value.verificationUri).hostname) || !checkedDeviceLink(value.verificationUri, value.userCode, portal, false)) throw unavailable();
    if (value.verificationUriComplete && (region(new URL(value.verificationUriComplete).hostname) || !checkedDeviceLink(value.verificationUriComplete, value.userCode, portal, true))) throw unavailable();
  } else if ('verificationUriComplete' in value && value.verificationUriComplete) throw unavailable();
  // Codes only travel through fresh status reads, never durable request replay records.
  if (operation !== 'status' && 'status' in value) { delete value.userCode; delete value.verificationUri; delete value.verificationUriComplete; }
  return value;
}

export class OrganizationConnections {
  private readonly store: CloudStore;
  private readonly access: OrganizationWebAccess;
  private readonly transport: OrganizationWorkerTransport;
  private readonly configs: Configuration[];
  private readonly now: () => number;
  private readonly cache?: ObservationCache;
  /** Gap between host-side fetch steps of a running sync (tests shorten it). */
  followIntervalMs = 3_000;
  private readonly followers = new Map<string, ReturnType<typeof setTimeout>>();
  private closed = false;
  /** Server setting: sync each connection on this interval while its user's AWS session (worker) is alive. */
  private readonly schedule?: SyncSchedule;
  /** Connections whose AWS session this process has seen connected; a scheduled sync never starts a worker or login. */
  private readonly sessions = new Map<string, RecordValue>();
  private readonly requireLoginNameMatch: boolean;
  private scheduler?: ReturnType<typeof setInterval>;
  constructor(store: CloudStore, access: OrganizationWebAccess, transport: OrganizationWorkerTransport, configurations: unknown, now = Date.now, observations?: ObservationCache, options: { schedule?: unknown; identityPolicy?: unknown } = {}) {
    this.requireLoginNameMatch = identityPolicySchema.parse(options.identityPolicy ?? {}).requireLoginNameMatch;
    this.store = store; this.access = access; this.transport = transport; this.now = now; this.cache = observations;
    this.schedule = options.schedule === undefined ? undefined : syncScheduleSchema.parse(options.schedule);
    if (this.schedule && this.cache) { this.scheduler = setInterval(() => { void this.runSchedule().catch(() => undefined); }, 60_000); this.scheduler.unref(); }
    this.configs = z.array(connectionConfigurationSchema).max(1000).parse(configurations);
    if (new Set(this.configs.map(value => JSON.stringify([value.organizationId, value.workspaceId, value.configurationId]))).size !== this.configs.length) throw new Error('Duplicate organization connection configuration');
  }
  /** The server-built binding of one user's connection. With the identity policy on, the verified web login name is part of it, so the
   * worker can refuse an AWS session approved by a different person; without a signed login name the connection is not created. */
  private bindingFor<T extends object>(session: OrganizationWebSession, configuration: T, connectionId: string) {
    const loginName = session.identity.loginName;
    if (this.requireLoginNameMatch && !loginName) throw new CloudOperationError(403, 'web_login_name_missing', 'The web login carries no user name to match with the AWS user.');
    return { ...configuration, actorId: session.identity.actorId, connectionId, ...(this.requireLoginNameMatch ? { loginName } : {}) };
  }
  private configuration(session: OrganizationWebSession, id: string) {
    const value = this.configs.find(item => session.context.owner.kind === 'organization' && item.organizationId === session.context.owner.organizationId && item.workspaceId === session.context.workspaceId && item.configurationId === id);
    if (!value) throw unavailable(); return value;
  }
  /** Trusted supervisor lifecycle checks only; this is not web authentication or a browser endpoint. */
  async workerAuthorization(input: unknown): Promise<{ revision: string }> {
    const binding = cliBindingSchema.parse(input);
    return this.store.transact(async tx => (await this.authorized(tx, binding)).revision);
  }
  /** The stored connection, its owner's active membership and the server configuration still match this exact binding. */
  private async authorized(tx: CloudTransaction, binding: CliBinding): Promise<{ record: RecordValue; revision: { revision: string } }> {
    const expected = bindingDigest(binding);
    const record = await tx.get<RecordValue>(recordKey(binding.connectionId));
    const member = membershipSchema.safeParse(await tx.get(membershipKey(binding.organizationId, binding.workspaceId, binding.actorId)));
    if (!record?.enabled || record.digest !== expected || bindingDigest(record.binding) !== expected || !member.success || !member.data.active
      || member.data.actorId !== binding.actorId || member.data.organizationId !== binding.organizationId || member.data.workspaceId !== binding.workspaceId) throw unavailable();
    const config = this.configs.find(value => value.configurationId === record.configurationId && value.organizationId === binding.organizationId && value.workspaceId === binding.workspaceId);
    if (!config) throw unavailable();
    const { configurationId: _, label: __, ...scope } = config;
    // With the identity policy on, the stored (and per-request re-verified) login name is part of the expected binding; without one the connection is refused.
    if (this.requireLoginNameMatch && !binding.loginName) throw unavailable();
    if (bindingDigest({ ...scope, connectionId: binding.connectionId, actorId: binding.actorId, ...(this.requireLoginNameMatch ? { loginName: binding.loginName } : {}) }) !== expected) throw unavailable();
    return { record, revision: { revision: digest({ binding: expected, version: member.data.version, roles: member.data.roles }) } };
  }
  private async invoke(binding: CliBinding, command: Parameters<OrganizationWorkerTransport['invoke']>[1]) {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([Promise.resolve().then(() => this.transport.invoke(binding, command, controller.signal)), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(uncertain()); }, 30_000); timer.unref();
      })]);
    } finally { if (timer) clearTimeout(timer); }
  }
  private async owned(tx: CloudTransaction, session: OrganizationWebSession, id: string) {
    await this.access.assertCurrentIn(tx, session);
    const value = await tx.get<RecordValue>(recordKey(z.uuid().parse(id)));
    if (!value || !value.enabled || value.binding.actorId !== session.identity.actorId || session.context.owner.kind !== 'organization'
      || value.binding.organizationId !== session.context.owner.organizationId || value.binding.workspaceId !== session.context.workspaceId) throw unavailable();
    const { configurationId: _, label: __, ...configuration } = this.configuration(session, value.configurationId);
    if (bindingDigest(value.binding) !== value.digest || bindingDigest(this.bindingFor(session, configuration, id)) !== value.digest) throw unavailable();
    return value;
  }
  private view(value: RecordValue) {
    const { binding } = value;
    return { id: binding.connectionId, configurationId: value.configurationId, accountId: binding.accountId, roleName: binding.roleName, region: binding.region, createdAt: value.createdAt, startUrl: binding.startUrl, ...(binding.directory ? { directory: binding.directory } : {}), ...(binding.inventory?.requiredTags ? { requiredTags: binding.inventory.requiredTags } : {}) };
  }
  async list(session: OrganizationWebSession) {
    return this.store.transact(async tx => {
      await this.access.assertCurrentIn(tx, session);
      const ids = await tx.get<string[]>(`connection-index:${digest(scope(session))}`) ?? [];
      const items = [];
      for (const id of ids) { try { items.push(this.view(await this.owned(tx, session, id))); } catch (error) { if (!(error instanceof CloudOperationError && error.status === 404)) throw error; } }
      return { items, ...(this.schedule ? { syncEveryMinutes: this.schedule.syncEveryMinutes } : {}), configurations: this.configs.filter(value => session.context.owner.kind === 'organization' && value.organizationId === session.context.owner.organizationId && value.workspaceId === session.context.workspaceId).map(value => ({ id: value.configurationId, label: value.label, accountId: value.accountId, roleName: value.roleName, region: value.region, ...(value.directory ? { directory: value.directory } : {}) })) };
    });
  }
  async create(session: OrganizationWebSession, input: unknown) {
    const request = z.object({ configurationId: z.string(), requestKey: z.uuid() }).strict().parse(input);
    const { configurationId, label: _, ...configuration } = this.configuration(session, request.configurationId);
    const binding = cliBindingSchema.parse(this.bindingFor(session, configuration, randomUUID()));
    const value: RecordValue = { binding, configurationId, digest: bindingDigest(binding), enabled: true, createdAt: new Date(this.now()).toISOString() };
    const indexKey = `connection-index:${digest(scope(session))}`, retryKey = `connection-create:${digest([...scope(session), request.requestKey])}`, fingerprint = digest({ configurationId, ...configuration });
    return this.store.transact(async tx => {
      await this.access.assertCurrentIn(tx, session);
      const prior = await tx.get<{ fingerprint: string; id: string }>(retryKey);
      if (prior) { if (prior.fingerprint !== fingerprint) throw new CloudOperationError(409, 'request_key_conflict', 'Use a new request identifier.'); return this.view(await this.owned(tx, session, prior.id)); }
      const ids = await tx.get<string[]>(indexKey) ?? [];
      // Reuse this user's existing connection for this configuration, never another actor's. A connection whose
      // binding no longer matches the current trusted configuration (e.g. a changed directory scope) is retired:
      // it is disabled so worker authorization fails closed, and a new connection is registered.
      const stale: Array<{ id: string; record: RecordValue }> = [];
      for (const id of ids) {
        const existing = await tx.get<RecordValue>(recordKey(id));
        if (existing?.enabled && existing.configurationId === configurationId && existing.binding.actorId === session.identity.actorId) {
          if (bindingDigest(existing.binding) === bindingDigest(this.bindingFor(session, configuration, id)) && existing.digest === bindingDigest(existing.binding)) {
            const owned = await this.owned(tx, session, id); tx.put(retryKey, { fingerprint, id }); return this.view(owned);
          }
          stale.push({ id, record: existing });
        }
      }
      const kept = ids.filter(id => !stale.some(item => item.id === id));
      if (kept.length >= 20) throw new CloudOperationError(429, 'connection_limit', 'The connection limit was reached.');
      await tx.get(recordKey(binding.connectionId));
      for (const item of stale) tx.put(recordKey(item.id), { ...item.record, enabled: false });
      tx.put(recordKey(binding.connectionId), value); tx.put(indexKey, [...kept, binding.connectionId]); tx.put(retryKey, { fingerprint, id: binding.connectionId });
      return this.view(value);
    });
  }
  private readonly locks = new Map<string, Promise<unknown>>();
  /** One sync status/fetch at a time per connection (concurrent polls would only duplicate unit fetches). */
  private locked<T>(id: string, task: () => Promise<T>): Promise<T> {
    const run = (this.locks.get(id) ?? Promise.resolve()).then(task, task); const settled = run.then(() => undefined, () => undefined);
    this.locks.set(id, settled); void settled.then(() => { if (this.locks.get(id) === settled) this.locks.delete(id); });
    return run;
  }
  private async cachedSync(value: RecordValue) {
    const cached = await this.cache?.loadSync(this.cacheScope(value)).catch(() => undefined);
    const summary = cached ? syncSummarySchema.safeParse(cached.summary) : undefined;
    // A summary written by an earlier connection of the same configuration is shown as this connection's last (non-live) sync.
    return summary?.success ? { summary: { ...summary.data, connectionId: value.binding.connectionId, live: false }, fetched: summary.data.connectionId === value.binding.connectionId ? cached!.fetched : [] } : undefined;
  }
  /** One bounded step of a running sync: finished units are fetched, verified and written to the disk cache. `check` rechecks
   * that the caller may still use the connection after every worker reply. Never starts a worker, login or sync. */
  private async advance(value: RecordValue, check: () => Promise<unknown>) {
    const scope = this.cacheScope(value), cached = await this.cachedSync(value);
    let response: Awaited<ReturnType<OrganizationWorkerTransport['invoke']>> | undefined;
    try { response = await this.invoke(value.binding, { id: randomUUID(), operation: 'sync-status' }); } catch { response = undefined; }
    await check();
    if (!response?.ok) return { live: false as const, cached: cached?.summary };
    let job: SyncJob; try { job = checkedJob(value.binding, response.result); } catch { throw new CloudOperationError(502, 'invalid_worker_result', 'The worker response could not be verified.'); }
    const fetched = new Set(cached?.summary.jobId === job.jobId ? cached.fetched : []);
    let budget = 40;
    for (const ref of job.units) {
      if (fetched.has(ref.id)) continue;
      if (budget-- <= 0) break;
      const reply = await this.invoke(value.binding, { id: randomUUID(), operation: 'sync-unit', unit: ref.id }).catch(() => undefined);
      if (!reply?.ok) break;
      let unit: InventoryUnit; try { unit = checkedUnit(value.binding, job, ref, reply.result); } catch { throw new CloudOperationError(502, 'invalid_worker_result', 'The worker response could not be verified.'); }
      await this.cache?.saveUnit(scope, unitKey(unit), job.jobId, unit);
      fetched.add(ref.id);
    }
    await check();
    // A complete sync replaces the cached picture: keys it did not produce (e.g. a region without tagged VPCs now) are removed.
    const finished = (job.state === 'completed' || job.state === 'partial') && job.units.every(ref => fetched.has(ref.id));
    if (finished && job.state === 'completed') await this.cache?.pruneUnits(scope, new Set(job.units.map(unitKey)));
    // A finished sync (complete or with per-unit failures) is assessed once from its own units for the trend report.
    if (finished) await this.recordSnapshot(value, job).catch(() => undefined);
    const summary = { ...withoutUnits(job), cachedUnits: fetched.size, remaining: job.units.filter(ref => !fetched.has(ref.id)).length, live: true };
    await this.cache?.saveSync(scope, summary, [...fetched]);
    return { live: true as const, summary, finished };
  }
  /** Progress of the worker's sync for the owner; without a running worker the last cached summary is returned. */
  async syncStatus(session: OrganizationWebSession, id: string) {
    const value = await this.store.transact(tx => this.owned(tx, session, id));
    const result = await this.locked(id, () => this.advance(value, () => this.store.transact(tx => this.owned(tx, session, id))));
    if (result.live) { if (!result.finished) this.follow(value); return result.summary; }
    if (result.cached) return result.cached;
    throw new CloudOperationError(404, 'sync_not_found', 'No sync has been run for this connection.');
  }
  /** After a sync starts, the host keeps fetching its results into the disk cache until the job is done, so the browser may leave
   * the page. Every step rechecks the connection, membership and configuration like a worker heartbeat; it stops when the job ends,
   * the worker is gone, access is revoked, after 6 hours, or on shutdown. It never starts a worker, login or sync. */
  private follow(value: RecordValue) {
    const id = value.binding.connectionId;
    if (this.closed || !this.cache || this.followers.has(id)) return;
    const started = this.now(); let misses = 0;
    const schedule = () => { const timer = setTimeout(() => void step(), this.followIntervalMs); timer.unref(); this.followers.set(id, timer); };
    const step = async () => {
      let done = false;
      try {
        const result = await this.locked(id, () => this.advance(value, () => this.workerAuthorization(value.binding)));
        if (result.live) { misses = 0; done = result.finished; } else misses += 1;
      } catch { misses += 1; }
      this.followers.delete(id);
      if (!done && misses < 5 && !this.closed && this.now() - started < 6 * 3_600_000) schedule();
    };
    schedule();
  }
  /** For other host services (runbooks): the owned connection, its configuration and cache scope. Never calls a worker. */
  async ownedConnection(session: OrganizationWebSession, id: string) {
    const value = await this.store.transact(tx => this.owned(tx, session, id));
    return { binding: value.binding, configurationId: value.configurationId, scope: this.cacheScope(value) };
  }
  /** Cached inventory units of a cache scope (validated; for checking runbook targets against what the requester synced). */
  async cachedUnits(scope: readonly string[]) {
    return (await this.cache?.loadUnits(scope).catch(() => []) ?? []).flatMap(entry => { const unit = inventoryUnitSchema.safeParse(entry.unit); return unit.success && entry.key === unitKey(unit.data) ? [unit.data] : []; });
  }
  /** A worker call for another host service on a stored connection, rechecked like a heartbeat (record, membership, configuration). */
  async workerCall(connectionId: string, command: WorkerCommand) {
    const value = await this.store.transact(async tx => {
      const record = await tx.get<RecordValue>(recordKey(z.uuid().parse(connectionId)));
      if (!record) throw unavailable();
      return (await this.authorized(tx, record.binding)).record;
    });
    let response: Awaited<ReturnType<OrganizationWorkerTransport['invoke']>>;
    try { response = await this.invoke(value.binding, command); } catch (error) { if (error instanceof CloudOperationError && error.code === 'worker_request_uncertain') throw error; throw new CloudOperationError(503, 'worker_unavailable', 'The connection worker is unavailable.'); }
    await this.store.transact(async tx => this.authorized(tx, value.binding));
    return { binding: value.binding, response };
  }
  /** Host shutdown: stop the scheduler and following syncs. */
  async close() { this.closed = true; if (this.scheduler) clearInterval(this.scheduler); this.followers.forEach(timer => clearTimeout(timer)); this.followers.clear(); }
  /** Cached units of one service (or `all`) across accounts/regions (owned connection only; never calls a worker). */
  async inventory(session: OrganizationWebSession, id: string, service: unknown) {
    const checkedService = service === 'all' ? 'all' as const : cliReadSchema.parse(service), value = await this.store.transact(tx => this.owned(tx, session, id));
    const cached = await this.cache?.loadUnits(this.cacheScope(value)).catch(() => []) ?? [];
    const units: InventoryUnit[] = [];
    for (const entry of cached) {
      const unit = inventoryUnitSchema.safeParse(entry.unit);
      if (unit.success && (checkedService === 'all' || unit.data.service === checkedService) && entry.key === unitKey(unit.data)) units.push(unit.data);
    }
    units.sort((left, right) => unitKey(left).localeCompare(unitKey(right)));
    return { service: checkedService, units: units.slice(0, 6000), truncated: units.length > 6000 };
  }
  private async recordSnapshot(value: RecordValue, job: SyncJob) {
    if (!this.cache) return;
    const scope = this.cacheScope(value), history = (await this.cache.loadReport(scope)).flatMap(item => { const parsed = reportSnapshotSchema.safeParse(item); return parsed.success ? [parsed.data] : []; });
    if (history.some(item => item.jobId === job.jobId)) return;
    const units: InventoryUnit[] = [];
    for (const entry of await this.cache.loadUnits(scope)) {
      const unit = inventoryUnitSchema.safeParse(entry.unit);
      if (entry.jobId === job.jobId && unit.success && entry.key === unitKey(unit.data)) units.push(unit.data);
    }
    await this.cache.saveReport(scope, retainSnapshots([...history, reportSnapshot(job, units, value.binding.inventory?.requiredTags)], this.now()));
  }
  /** Trend snapshots of finished syncs (owned connection only; disk cache; never calls a worker). */
  async report(session: OrganizationWebSession, id: string) {
    const value = await this.store.transact(tx => this.owned(tx, session, id));
    const snapshots: ReportSnapshot[] = [];
    for (const item of await this.cache?.loadReport(this.cacheScope(value)).catch(() => []) ?? []) { const parsed = reportSnapshotSchema.safeParse(item); if (parsed.success) snapshots.push(parsed.data); }
    return { snapshots: retainSnapshots(snapshots, this.now()) };
  }
  private viewsKey(session: OrganizationWebSession, value: RecordValue) { return `organization-views:${digest([...scope(session), value.configurationId])}`; }
  /** This user's saved views for the connection's configuration (server-side settings; never browser storage). */
  async views(session: OrganizationWebSession, id: string) {
    return this.store.transact(async tx => {
      const value = await this.owned(tx, session, id), stored = await tx.get<{ items: unknown[] }>(this.viewsKey(session, value));
      return { items: (stored?.items ?? []).flatMap(item => { const parsed = savedViewSchema.safeParse(item); return parsed.success ? [parsed.data] : []; }) };
    });
  }
  /** Save (upsert by name) or delete one saved view. The request key makes a retried request return the same list. */
  async updateViews(session: OrganizationWebSession, id: string, input: unknown) {
    const { requestKey, ...rest } = z.object({ requestKey: z.uuid() }).loose().parse(input), command = savedViewCommandSchema.parse(rest);
    const retryKey = `organization-views-request:${digest([...scope(session), requestKey])}`, fingerprint = digest(command);
    return this.store.transact(async tx => {
      const value = await this.owned(tx, session, id), key = this.viewsKey(session, value), prior = await tx.get<{ fingerprint: string }>(retryKey);
      const items = ((await tx.get<{ items: unknown[] }>(key))?.items ?? []).flatMap(item => { const parsed = savedViewSchema.safeParse(item); return parsed.success ? [parsed.data] : []; });
      if (prior) { if (prior.fingerprint !== fingerprint) throw new CloudOperationError(409, 'request_key_conflict', 'Use a new request identifier.'); return { items }; }
      let next: SavedView[];
      if (command.operation === 'delete') next = items.filter(item => item.id !== command.id);
      else {
        const existing = items.find(item => item.view.name === command.view.name), updatedAt = new Date(this.now()).toISOString();
        if (!existing && items.length >= 30) throw new CloudOperationError(429, 'view_limit', 'The saved view limit was reached.');
        const saved: SavedView = { id: existing?.id ?? randomUUID(), updatedAt, view: command.view };
        next = [...items.filter(item => item.id !== saved.id), saved].sort((a, b) => a.view.name.localeCompare(b.view.name));
      }
      tx.put(key, { items: next }); tx.put(retryKey, { fingerprint });
      return { items: next };
    });
  }
  /** Results stay with the user and the payer configuration, so signing in again, re-registering the connection or changing the
   * server scope keeps showing the last synced picture until the user syncs again (users never share an entry). */
  private cacheScope(value: RecordValue) { return [value.binding.organizationId, value.binding.workspaceId, value.binding.actorId, value.configurationId]; }
  /** Owned connection only; cached values must still pass the same binding checks as fresh results. Never calls a worker. */
  async observations(session: OrganizationWebSession, id: string) {
    const value = await this.store.transact(tx => this.owned(tx, session, id));
    const cached = await this.cache?.load(this.cacheScope(value)).catch(() => undefined);
    const inventories: Record<string, unknown> = {};
    const sync = await this.cachedSync(value);
    if (!cached) return { inventories, ...(sync ? { sync: sync.summary } : {}) };
    for (const [service, page] of Object.entries(cached.inventories)) {
      if (!cliReadSchema.safeParse(service).success) continue;
      try { const checked = checkedResult(value.binding, 'inspect', page) as z.infer<typeof pageSchema>; if (checked.operation === service) inventories[service] = checked; } catch { /* stale or foreign entry is dropped */ }
    }
    let directory: unknown;
    if (cached.directory !== undefined && value.binding.directory) { try { directory = checkedResult(value.binding, 'directory', cached.directory); } catch { directory = undefined; } }
    return { savedAt: cached.savedAt, ...(directory ? { directory } : {}), inventories, ...(sync ? { sync: sync.summary } : {}) };
  }
  async status(session: OrganizationWebSession, id: string) {
    const value = await this.store.transact(tx => this.owned(tx, session, id));
    let response: Awaited<ReturnType<OrganizationWorkerTransport['invoke']>>;
    try { response = await this.invoke(value.binding, { id: randomUUID(), operation: 'status' }); } catch { throw new CloudOperationError(503, 'worker_unavailable', 'The connection worker is unavailable.'); }
    await this.store.transact(tx => this.owned(tx, session, id));
    if (!response.ok) throw new CloudOperationError(409, 'worker_unavailable', 'The connection worker is unavailable.');
    let state: z.infer<typeof stateSchema>;
    try { state = checkedResult(value.binding, 'status', response.result) as z.infer<typeof stateSchema>; } catch { throw new CloudOperationError(502, 'invalid_worker_result', 'The worker response could not be verified.'); }
    this.remember(value, state.status);
    return state;
  }
  private remember(value: RecordValue, status: string) {
    if (status === 'connected') this.sessions.set(value.binding.connectionId, value); else this.sessions.delete(value.binding.connectionId);
  }
  /** One scheduler pass: start a sync for each connection with a live AWS session whose last sync is older than the interval.
   * Each start rechecks the connection, membership and configuration and reserves the connection like a user request. */
  async runSchedule() {
    if (!this.schedule || this.closed) return;
    for (const [id, value] of [...this.sessions]) {
      const cached = await this.cachedSync(value), last = cached?.summary.finishedAt ?? cached?.summary.startedAt;
      if (cached?.summary.state === 'running' || last && this.now() - Date.parse(last) < this.schedule.syncEveryMinutes * 60_000) continue;
      try { await this.run(id, value.binding.actorId, { requestKey: randomUUID(), operation: 'sync' }, async tx => (await this.authorized(tx, value.binding)).record); }
      catch (error) { if (!(error instanceof CloudOperationError && error.code === 'connection_busy')) this.sessions.delete(id); }
    }
  }
  async perform(session: OrganizationWebSession, id: string, input: unknown) {
    return this.run(id, session.identity.actorId, connectionActionSchema.parse(input), tx => this.owned(tx, session, id));
  }
  /** One reserved worker request on a connection. `check` re-authorizes the caller (web session, or the scheduler's binding check). */
  private async run(id: string, actorId: string, command: ConnectionAction, check: (tx: CloudTransaction) => Promise<RecordValue>) {
    const key = `connection-request:${digest([id, actorId, command.requestKey])}`, fingerprint = digest(command);
    const accepted = await this.store.transact(async tx => {
      const connection = await check(tx), prior = await tx.get<RequestValue>(key);
      if (command.operation === 'directory' && !connection.binding.directory) throw new CloudOperationError(409, 'directory_not_configured', 'The organization directory scope is not configured.');
      if (prior) { if (prior.fingerprint !== fingerprint) throw new CloudOperationError(409, 'request_key_conflict', 'Use a new request identifier.'); return { connection, replay: prior }; }
      if (connection.activeRequest) {
        if (connection.activeRequest.deadline > this.now()) throw new CloudOperationError(409, 'connection_busy', 'Another request is in progress.');
        const previous = await tx.get<RequestValue>(connection.activeRequest.key);
        if (previous?.state === 'pending') tx.put(connection.activeRequest.key, { ...previous, state: 'unknown' });
      }
      tx.put(key, { fingerprint, state: 'pending' }); tx.put(recordKey(id), { ...connection, activeRequest: { key, deadline: this.now() + 60_000 } });
      return { connection, replay: undefined };
    });
    if (accepted.replay) {
      if (accepted.replay.state === 'completed') return accepted.replay.result;
      if (accepted.replay.state === 'failed') throw new CloudOperationError(409, accepted.replay.code ?? 'worker_rejected', 'The worker rejected this request.');
      throw uncertain();
    }
    try {
      const response = await this.invoke(accepted.connection.binding, { id: command.requestKey, operation: command.operation, ...(command.service ? { service: command.service } : {}), ...(command.cursor ? { cursor: command.cursor } : {}) });
      const checked = response.ok ? checkedResult(accepted.connection.binding, command.operation, response.result) : undefined;
      // A started sync is stored and returned as its summary (unit contents are fetched later through syncStatus).
      const result = command.operation === 'sync' && checked ? { ...withoutUnits(checked as SyncJob), cachedUnits: 0, live: true } : checked;
      if (response.ok && command.operation === 'inspect' && (result as z.infer<typeof pageSchema>).operation !== command.service) throw uncertain();
      const failureCode = !response.ok && /^[a-z_]{1,64}$/.test(response.code) ? response.code : 'worker_rejected';
      await this.store.transact(async tx => {
        const connection = await check(tx), request = await tx.get<RequestValue>(key);
        if (connection.activeRequest?.key !== key || connection.activeRequest.deadline <= this.now() || request?.state !== 'pending') throw uncertain();
        const { activeRequest: _, ...rest } = connection;
        tx.put(key, response.ok ? { fingerprint, state: 'completed', result } : { fingerprint, state: 'failed', code: failureCode }); tx.put(recordKey(id), rest);
      });
      if (!response.ok) throw new CloudOperationError(409, failureCode, 'The worker rejected this request.');
      const cacheScope = this.cacheScope(accepted.connection);
      if (this.cache && result && (command.operation === 'directory' || command.operation === 'inspect')) {
        // Cache writes are outside store transactions and never fail the user's read.
        const kind = command.operation === 'directory' ? 'directory' as const : `inventory:${command.service}` as const;
        await this.cache.save(cacheScope, kind, result, new Date(this.now()).toISOString()).catch(() => undefined);
        if (command.operation === 'inspect') {
          // A single read is the connection's own account/region: it also refreshes that unit of the multi-account inventory.
          const page = result as z.infer<typeof pageSchema>, unit = { accountId: page.accountId, region: page.region, service: page.operation, collectedAt: page.collectedAt, hasMore: page.hasMore, items: page.items, source: 'direct' as const };
          await this.cache.saveUnit(cacheScope, unitKey(unit), 'inspect', unit).catch(() => undefined);
        }
      }
      if (command.operation === 'sync') await this.cache?.saveSync(cacheScope, result, []).catch(() => undefined);
      if (command.operation === 'sync') this.follow(accepted.connection);
      if (command.operation === 'login' || command.operation === 'verify') this.remember(accepted.connection, (result as z.infer<typeof stateSchema>).status);
      if (command.operation === 'logout' || command.operation === 'disconnect') this.sessions.delete(id);
      return result;
    } catch (error) {
      await this.store.transact(async tx => {
        const request = await tx.get<RequestValue>(key), connection = await tx.get<RecordValue>(recordKey(id));
        if (request?.state === 'pending') tx.put(key, { fingerprint, state: 'unknown' });
        if (connection?.activeRequest?.key === key) { const { activeRequest: _, ...rest } = connection; tx.put(recordKey(id), rest); }
      });
      if (error instanceof CloudOperationError) throw error;
      throw uncertain();
    }
  }
}
