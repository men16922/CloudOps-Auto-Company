import { z } from 'zod';
import { directorySnapshotSchema, type DirectorySnapshot } from '../domain/directory';
import type { WebIdentity, WebIdentityClient } from '../../../platform/web-identity';
import { webScopeSchema, type WebScope } from '../../../platform/web-config';
import { connectionListSchema, connectionViewSchema, connectionStateSchema, connectionPageSchema, type ConnectionList, type ConnectionState, type ConnectionPage, type ConnectionCommand } from '../domain/connections';

export type ConnectionClientState = {
  identity: WebIdentity | null; list: ConnectionList; selectedId?: string; status?: ConnectionState; inspection?: ConnectionPage; directory?: DirectorySnapshot;
  busy: boolean; loading: boolean; error?: string; retryable: boolean;
};
type Pending = { path: string; body: unknown; key: string; connectionId?: string; operation: 'create' | ConnectionCommand['operation'] };
class RequestError extends Error {
  readonly code: string; readonly status: number;
  constructor(code: string, status = 0) { super(code); this.code = code; this.status = status; }
}
const emptyList = (): ConnectionList => ({ items: [], configurations: [] });

/** In-memory, scope-bound client. Neither identity tokens nor account results enter browser storage. */
export class OrganizationConnectionClient {
  private value: ConnectionClientState = { identity: null, list: emptyList(), loading: false, busy: false, retryable: false };
  private readonly listeners = new Set<() => void>();
  private readonly inflight = new Set<AbortController>();
  private readonly identityClient: WebIdentityClient;
  private readonly fetcher: typeof fetch;
  private readonly base: string;
  private unsubscribe: () => void;
  private epoch = 0;
  private statusSequence = 0;
  private listSequence = 0;
  private pending?: Pending;
  private closed = false;
  private acceptingIdentity = true;
  constructor(identityClient: WebIdentityClient, scope: WebScope, fetcher: typeof fetch = fetch) {
    const value = webScopeSchema.parse(scope); this.identityClient = identityClient; this.fetcher = fetcher.bind(globalThis);
    this.base = `/api/organizations/v1/${encodeURIComponent(value.organizationId)}/workspaces/${encodeURIComponent(value.workspaceId)}/aws/connections`;
    this.unsubscribe = identityClient.subscribe(identity => {
      if (this.closed || (!this.acceptingIdentity && identity)) return;
      if (identity?.key !== this.value.identity?.key) { this.clear(identity); if (identity) void this.refresh(); }
      else if (identity) this.set({ identity });
    });
  }
  getSnapshot = () => this.value;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private set(value: Partial<ConnectionClientState>) { if (this.closed) return; this.value = { ...this.value, ...value }; this.listeners.forEach(listener => listener()); }
  private clear(identity: WebIdentity | null) {
    this.epoch++; this.statusSequence++; this.listSequence++; this.inflight.forEach(controller => controller.abort()); this.inflight.clear(); this.pending = undefined;
    this.value = { identity, list: emptyList(), busy: false, loading: false, retryable: false }; this.listeners.forEach(listener => listener());
  }
  private current(epoch: number) { if (this.closed || epoch !== this.epoch) throw new RequestError('obsolete_response'); }
  private async request(path: string, epoch: number, pending?: Pending): Promise<unknown> {
    this.current(epoch); const identity = this.value.identity; if (!identity) throw new RequestError('web_sign_in_required', 401);
    const controller = new AbortController(); this.inflight.add(controller);
    const timer = setTimeout(() => controller.abort(), 35_000);
    try {
      let token: string;
      try { token = await this.identityClient.tokenFor(identity.key); } catch { throw new RequestError('web_sign_in_required', 401); }
      this.current(epoch);
      const response = await this.fetcher(`${this.base}${path}`, { method: pending ? 'POST' : 'GET', signal: controller.signal, credentials: 'omit', cache: 'no-store', redirect: 'error',
        headers: { Authorization: `Bearer ${token}`, ...(pending ? { 'Content-Type': 'application/json', 'Idempotency-Key': pending.key } : {}) }, ...(pending ? { body: JSON.stringify(pending.body) } : {}) });
      const text = await response.text(); this.current(epoch);
      if (text.length > 1_000_000) throw new RequestError('invalid_response');
      let body: unknown; try { body = JSON.parse(text); } catch { throw new RequestError('invalid_response', response.status); }
      if (!response.ok) {
        const code = z.object({ code: z.string().regex(/^[a-z_]{1,64}$/) }).safeParse(body);
        throw new RequestError(code.success ? code.data.code : 'request_failed', response.status);
      }
      return body;
    } finally { clearTimeout(timer); this.inflight.delete(controller); }
  }
  private fail(error: unknown, epoch: number, retryable = false) {
    if (this.closed || this.epoch !== epoch) return;
    if (error instanceof RequestError && [401, 403].includes(error.status)) {
      this.clear(this.value.identity); this.set({ error: error.code }); return;
    }
    this.set({ error: error instanceof RequestError ? error.code : 'request_unknown', busy: false, loading: false, status: undefined, inspection: undefined, directory: undefined, retryable });
  }
  async signIn() {
    this.acceptingIdentity = true;
    const epoch = this.epoch, previousKey = this.value.identity?.key;
    try { await this.identityClient.signIn(); if (previousKey && previousKey === this.value.identity?.key) await this.refresh(); } catch { this.fail(new RequestError('sign_in_failed'), epoch); }
  }
  async signOut() {
    this.acceptingIdentity = false;
    this.clear(null); const epoch = this.epoch;
    try { await this.identityClient.signOut(); } catch { this.fail(new RequestError('sign_out_failed'), epoch); }
  }
  async refresh() {
    if (!this.value.identity || this.value.busy) return;
    const epoch = this.epoch, sequence = ++this.listSequence; this.set({ loading: true, error: undefined });
    try {
      const list = connectionListSchema.parse(await this.request('', epoch)); this.current(epoch);
      if (sequence !== this.listSequence) return;
      const selected = list.items.find(item => item.id === this.value.selectedId);
      const changed = selected && JSON.stringify(selected) !== JSON.stringify(this.value.list.items.find(item => item.id === this.value.selectedId));
      if (changed) this.set({ status: undefined, inspection: undefined, directory: undefined });
      this.set({ list, loading: false, ...(!selected ? { selectedId: undefined, status: undefined, inspection: undefined, directory: undefined } : {}) });
    } catch (error) { if (sequence === this.listSequence) this.fail(error, epoch); }
  }
  async select(id: string) {
    if (this.value.busy || !this.value.list.items.some(item => item.id === id)) return;
    this.pending = undefined;
    this.set({ selectedId: id, status: undefined, inspection: undefined, directory: undefined, error: undefined, retryable: false }); await this.refreshStatus();
  }
  async refreshStatus() {
    const selected = this.value.list.items.find(item => item.id === this.value.selectedId);
    if (!selected || this.value.busy) return;
    const epoch = this.epoch, sequence = ++this.statusSequence;
    try {
      const status = connectionStateSchema.parse(await this.request(`/${selected.id}/status`, epoch)); this.current(epoch);
      if (sequence !== this.statusSequence || selected.id !== this.value.selectedId) return;
      this.match(status);
      if (status.verificationUri) {
        const url = new URL(status.verificationUri);
        // Identity Center portals use <start>/#/device; any other fragment is refused.
        const portalDevice = /^[a-z0-9-]+\.awsapps\.com$/.test(url.hostname) && /^\/start\/?$/.test(url.pathname) && url.hash === '#/device';
        if (url.protocol !== 'https:' || url.search || (url.hash && !portalDevice) || url.port || url.username || url.password || !(/^device\.sso\.[a-z0-9-]+\.amazonaws\.com$/.test(url.hostname) && url.pathname === '/' || /^[a-z0-9-]+\.awsapps\.com$/.test(url.hostname) && /^\/start\/?$/.test(url.pathname))) throw new RequestError('invalid_response');
      }
      this.set({ status, ...(status.status !== 'connected' ? { inspection: undefined, directory: undefined } : {}) });
    } catch (error) { if (sequence === this.statusSequence) this.fail(error, epoch); }
  }
  private match(result: ConnectionState | ConnectionPage | DirectorySnapshot) {
    const selected = this.value.list.items.find(item => item.id === this.value.selectedId);
    if (!selected || result.connectionId !== selected.id || result.accountId !== selected.accountId || result.region !== selected.region || ('roleName' in result && result.roleName !== selected.roleName)) throw new RequestError('invalid_response');
    if ('scope' in result && (!selected.directory || result.scope.awsOrganizationId !== selected.directory.awsOrganizationId || result.scope.parentId !== selected.directory.parentId)) throw new RequestError('invalid_response');
  }
  async create(configurationId: string) {
    if (this.value.busy || !this.value.list.configurations.some(item => item.id === configurationId)) return;
    await this.dispatch({ path: '', body: { configurationId }, key: crypto.randomUUID(), operation: 'create' });
  }
  async perform(command: ConnectionCommand) {
    const id = this.value.selectedId;
    if (this.value.busy || !id || !this.value.list.items.some(item => item.id === id)) return;
    if (command.operation === 'directory' && command.cursor) {
      const view = this.value.directory;
      const allowed = view ? [...view.navigation.path.map(item => item.cursor), ...(view.accounts.status === 'collected' ? [view.accounts.nextCursor] : []), ...(view.organizationalUnits.status === 'collected' ? [view.organizationalUnits.nextCursor, ...view.organizationalUnits.items.map(item => item.browseCursor)] : [])] : [];
      if (!allowed.includes(command.cursor)) return;
    }
    await this.dispatch({ path: `/${id}/actions`, body: command, key: crypto.randomUUID(), connectionId: id, operation: command.operation });
  }
  async retry() { if (this.pending && this.value.retryable && !this.value.busy) await this.dispatch(this.pending); }
  private async dispatch(pending: Pending) {
    const epoch = this.epoch; this.statusSequence++; this.listSequence++; this.pending = pending;
    this.set({ busy: true, loading: false, error: undefined, retryable: false, status: undefined, inspection: undefined, directory: undefined });
    try {
      const result = await this.request(pending.path, epoch, pending); this.current(epoch);
      if (pending.operation === 'create') {
        const item = connectionViewSchema.parse(result);
        const configuration = this.value.list.configurations.find(config => config.id === (pending.body as { configurationId: string }).configurationId);
        if (!configuration || item.configurationId !== configuration.id || item.accountId !== configuration.accountId || item.roleName !== configuration.roleName || item.region !== configuration.region || JSON.stringify(item.directory) !== JSON.stringify(configuration.directory)) throw new RequestError('invalid_response');
        this.set({ list: { ...this.value.list, items: [...this.value.list.items.filter(row => row.id !== item.id), item] }, selectedId: item.id });
      } else if (pending.operation === 'directory') {
        const directory = directorySnapshotSchema.parse(result); this.match(directory); this.set({ directory });
      } else if (pending.operation === 'inspect') {
        const inspection = connectionPageSchema.parse(result); this.match(inspection);
        if (inspection.operation !== (pending.body as ConnectionCommand).service) throw new RequestError('invalid_response');
        this.set({ inspection });
      } else if (pending.operation === 'login' || pending.operation === 'verify') {
        const status = connectionStateSchema.parse(result); this.match(status); delete status.userCode; delete status.verificationUri; this.set({ status });
      } else {
        const schema = pending.operation === 'disconnect' ? z.object({ disconnected: z.literal(true), cliCacheRetained: z.literal(true) }).strict() : z.object({ disconnected: z.literal(true), remoteLogout: z.enum(['confirmed', 'unknown']) }).strict();
        const value = schema.parse(result); this.set({ error: 'remoteLogout' in value && value.remoteLogout === 'unknown' ? 'logout_unknown' : undefined });
      }
      this.pending = undefined; this.set({ busy: false });
      await this.refreshStatus();
    } catch (error) {
      this.fail(error, epoch, !(error instanceof RequestError && [400, 401, 403, 404, 409].includes(error.status)));
      if (epoch === this.epoch && error instanceof RequestError && ['directory_cursor_invalid', 'directory_cursor_expired', 'directory_scope_unverified'].includes(error.code)) await this.refreshStatus();
    }
  }
  close() { this.closed = true; this.epoch++; this.unsubscribe(); this.inflight.forEach(controller => controller.abort()); this.inflight.clear(); this.listeners.clear(); this.pending = undefined; }
}
