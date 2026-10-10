import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { CloudOperationError } from '../../../../src/domain/cloud-workflow';
import { OrganizationWebAccess, membershipKey, membershipSchema, type OrganizationWebSession } from '../../../cloud-auth';
import type { CloudStore, CloudTransaction } from '../../../cloud-store';
import { connectionStateSchema as stateSchema, connectionPageSchema as pageSchema } from '../../../../src/modules/aws/domain/connections';
import { directorySnapshotSchema } from '../../../../src/modules/aws/domain/directory';
import { bindingDigest, cliBindingSchema, cliReadSchema, type CliBinding } from './organization-cli-contract';

export const connectionConfigurationSchema = cliBindingSchema.omit({ actorId: true, connectionId: true }).extend({ configurationId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/), label: z.string().min(1).max(128) }).strict();
type Configuration = z.infer<typeof connectionConfigurationSchema>;
export const connectionActionSchema = z.object({ requestKey: z.uuid(), operation: z.enum(['login', 'verify', 'inspect', 'directory', 'disconnect', 'logout']), service: cliReadSchema.optional(), cursor: z.uuid().optional() }).strict().refine(value => (value.operation === 'inspect' ? Boolean(value.service) : value.service === undefined) && (value.operation === 'directory' || value.cursor === undefined));
export type ConnectionAction = z.infer<typeof connectionActionSchema>;
type RecordValue = { binding: CliBinding; configurationId: string; digest: string; createdAt: string; enabled: boolean; activeRequest?: { key: string; deadline: number } };
type RequestValue = { fingerprint: string; state: 'pending' | 'completed' | 'failed' | 'unknown'; result?: unknown; code?: string };
/** Authenticated private transport must bind a worker/lease to this exact immutable binding. */
export interface OrganizationWorkerTransport {
  invoke(binding: CliBinding, command: { id: string; operation: ConnectionAction['operation'] | 'status'; service?: z.infer<typeof cliReadSchema>; cursor?: string }, signal: AbortSignal): Promise<{ ok: true; result: unknown } | { ok: false; code: string }>;
}
const unavailable = () => new CloudOperationError(404, 'connection_unavailable', 'The connection is not available.');
const uncertain = () => new CloudOperationError(409, 'worker_request_uncertain', 'The worker result is unknown. Check the connection before starting a new request.');
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const recordKey = (id: string) => `organization-connection:${id}`;
const scope = (session: OrganizationWebSession) => [session.context.owner, session.context.workspaceId, session.identity.actorId];
function checkedResult(binding: CliBinding, operation: ConnectionAction['operation'] | 'status', result: unknown): unknown {
  if (operation === 'disconnect') return z.object({ disconnected: z.literal(true), cliCacheRetained: z.literal(true) }).strict().parse(result);
  if (operation === 'logout') return z.object({ disconnected: z.literal(true), remoteLogout: z.enum(['confirmed', 'unknown']) }).strict().parse(result);
  const value = operation === 'directory' ? directorySnapshotSchema.parse(result) : operation === 'inspect' ? pageSchema.parse(result) : stateSchema.parse(result);
  if ('scope' in value && (!binding.directory || value.scope.awsOrganizationId !== binding.directory.awsOrganizationId || value.scope.parentId !== binding.directory.parentId)) throw unavailable();
  if (value.connectionId !== binding.connectionId || value.accountId !== binding.accountId || value.region !== binding.region || ('roleName' in value && value.roleName !== binding.roleName)) throw unavailable();
  if ('verificationUri' in value && value.verificationUri) {
    const url = new URL(value.verificationUri), configured = new URL(binding.startUrl);
    const portalDevice = url.hostname === configured.hostname && /^\/start\/?$/.test(url.pathname) && url.hash === '#/device';
    if (url.protocol !== 'https:' || url.port || url.username || url.password || url.search || (url.hash && !portalDevice)
      || !((url.hostname === `device.sso.${binding.ssoRegion}.amazonaws.com` && url.pathname === '/') || (url.hostname === configured.hostname && /^\/start\/?$/.test(url.pathname)))) throw unavailable();
  }
  // Codes only travel through fresh status reads, never durable request replay records.
  if (operation !== 'status' && 'status' in value) { delete value.userCode; delete value.verificationUri; }
  return value;
}

export class OrganizationConnections {
  private readonly store: CloudStore;
  private readonly access: OrganizationWebAccess;
  private readonly transport: OrganizationWorkerTransport;
  private readonly configs: Configuration[];
  private readonly now: () => number;
  constructor(store: CloudStore, access: OrganizationWebAccess, transport: OrganizationWorkerTransport, configurations: unknown, now = Date.now) {
    this.store = store; this.access = access; this.transport = transport; this.now = now;
    this.configs = z.array(connectionConfigurationSchema).max(1000).parse(configurations);
    if (new Set(this.configs.map(value => JSON.stringify([value.organizationId, value.workspaceId, value.configurationId]))).size !== this.configs.length) throw new Error('Duplicate organization connection configuration');
  }
  private configuration(session: OrganizationWebSession, id: string) {
    const value = this.configs.find(item => session.context.owner.kind === 'organization' && item.organizationId === session.context.owner.organizationId && item.workspaceId === session.context.workspaceId && item.configurationId === id);
    if (!value) throw unavailable(); return value;
  }
  /** Trusted supervisor lifecycle checks only; this is not web authentication or a browser endpoint. */
  async workerAuthorization(input: unknown): Promise<{ revision: string }> {
    const binding = cliBindingSchema.parse(input), expected = bindingDigest(binding);
    return this.store.transact(async tx => {
      const record = await tx.get<RecordValue>(recordKey(binding.connectionId));
      const member = membershipSchema.safeParse(await tx.get(membershipKey(binding.organizationId, binding.workspaceId, binding.actorId)));
      if (!record?.enabled || record.digest !== expected || bindingDigest(record.binding) !== expected || !member.success || !member.data.active
        || member.data.actorId !== binding.actorId || member.data.organizationId !== binding.organizationId || member.data.workspaceId !== binding.workspaceId) throw unavailable();
      const config = this.configs.find(value => value.configurationId === record.configurationId && value.organizationId === binding.organizationId && value.workspaceId === binding.workspaceId);
      if (!config) throw unavailable();
      const { configurationId: _, label: __, ...scope } = config;
      if (bindingDigest({ ...scope, connectionId: binding.connectionId, actorId: binding.actorId }) !== expected) throw unavailable();
      return { revision: digest({ binding: expected, version: member.data.version, roles: member.data.roles }) };
    });
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
    if (bindingDigest(value.binding) !== value.digest || bindingDigest({ ...configuration, actorId: session.identity.actorId, connectionId: id }) !== value.digest) throw unavailable();
    return value;
  }
  private view(value: RecordValue) {
    const { binding } = value;
    return { id: binding.connectionId, configurationId: value.configurationId, accountId: binding.accountId, roleName: binding.roleName, region: binding.region, createdAt: value.createdAt, ...(binding.directory ? { directory: binding.directory } : {}) };
  }
  async list(session: OrganizationWebSession) {
    return this.store.transact(async tx => {
      await this.access.assertCurrentIn(tx, session);
      const ids = await tx.get<string[]>(`connection-index:${digest(scope(session))}`) ?? [];
      const items = [];
      for (const id of ids) { try { items.push(this.view(await this.owned(tx, session, id))); } catch (error) { if (!(error instanceof CloudOperationError && error.status === 404)) throw error; } }
      return { items, configurations: this.configs.filter(value => session.context.owner.kind === 'organization' && value.organizationId === session.context.owner.organizationId && value.workspaceId === session.context.workspaceId).map(value => ({ id: value.configurationId, label: value.label, accountId: value.accountId, roleName: value.roleName, region: value.region, ...(value.directory ? { directory: value.directory } : {}) })) };
    });
  }
  async create(session: OrganizationWebSession, input: unknown) {
    const request = z.object({ configurationId: z.string(), requestKey: z.uuid() }).strict().parse(input);
    const { configurationId, label: _, ...configuration } = this.configuration(session, request.configurationId);
    const binding = cliBindingSchema.parse({ ...configuration, actorId: session.identity.actorId, connectionId: randomUUID() });
    const value: RecordValue = { binding, configurationId, digest: bindingDigest(binding), enabled: true, createdAt: new Date(this.now()).toISOString() };
    const indexKey = `connection-index:${digest(scope(session))}`, retryKey = `connection-create:${digest([...scope(session), request.requestKey])}`, fingerprint = digest({ configurationId, ...configuration });
    return this.store.transact(async tx => {
      await this.access.assertCurrentIn(tx, session);
      const prior = await tx.get<{ fingerprint: string; id: string }>(retryKey);
      if (prior) { if (prior.fingerprint !== fingerprint) throw new CloudOperationError(409, 'request_key_conflict', 'Use a new request identifier.'); return this.view(await this.owned(tx, session, prior.id)); }
      const ids = await tx.get<string[]>(indexKey) ?? [];
      // Reuse this user's existing connection for this configuration, never another actor's.
      for (const id of ids) {
        const existing = await tx.get<RecordValue>(recordKey(id));
        if (existing?.enabled && existing.configurationId === configurationId && existing.binding.actorId === session.identity.actorId) {
          const owned = await this.owned(tx, session, id); tx.put(retryKey, { fingerprint, id }); return this.view(owned);
        }
      }
      if (ids.length >= 20) throw new CloudOperationError(429, 'connection_limit', 'The connection limit was reached.');
      await tx.get(recordKey(binding.connectionId));
      tx.put(recordKey(binding.connectionId), value); tx.put(indexKey, [...ids, binding.connectionId]); tx.put(retryKey, { fingerprint, id: binding.connectionId });
      return this.view(value);
    });
  }
  async status(session: OrganizationWebSession, id: string) {
    const value = await this.store.transact(tx => this.owned(tx, session, id));
    let response: Awaited<ReturnType<OrganizationWorkerTransport['invoke']>>;
    try { response = await this.invoke(value.binding, { id: randomUUID(), operation: 'status' }); } catch { throw new CloudOperationError(503, 'worker_unavailable', 'The connection worker is unavailable.'); }
    await this.store.transact(tx => this.owned(tx, session, id));
    if (!response.ok) throw new CloudOperationError(409, 'worker_unavailable', 'The connection worker is unavailable.');
    try { return checkedResult(value.binding, 'status', response.result); } catch { throw new CloudOperationError(502, 'invalid_worker_result', 'The worker response could not be verified.'); }
  }
  async perform(session: OrganizationWebSession, id: string, input: unknown) {
    const command = connectionActionSchema.parse(input), key = `connection-request:${digest([id, session.identity.actorId, command.requestKey])}`, fingerprint = digest(command);
    const accepted = await this.store.transact(async tx => {
      const connection = await this.owned(tx, session, id), prior = await tx.get<RequestValue>(key);
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
      const result = response.ok ? checkedResult(accepted.connection.binding, command.operation, response.result) : undefined;
      if (response.ok && command.operation === 'inspect' && (result as z.infer<typeof pageSchema>).operation !== command.service) throw uncertain();
      const failureCode = !response.ok && /^[a-z_]{1,64}$/.test(response.code) ? response.code : 'worker_rejected';
      await this.store.transact(async tx => {
        const connection = await this.owned(tx, session, id), request = await tx.get<RequestValue>(key);
        if (connection.activeRequest?.key !== key || connection.activeRequest.deadline <= this.now() || request?.state !== 'pending') throw uncertain();
        const { activeRequest: _, ...rest } = connection;
        tx.put(key, response.ok ? { fingerprint, state: 'completed', result } : { fingerprint, state: 'failed', code: failureCode }); tx.put(recordKey(id), rest);
      });
      if (!response.ok) throw new CloudOperationError(409, failureCode, 'The worker rejected this request.');
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
