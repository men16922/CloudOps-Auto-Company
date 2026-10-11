import { z } from 'zod';
import { directorySnapshotSchema, type DirectorySnapshot } from '../../../../packages/contracts/aws/directory';
import type { WebIdentity, WebIdentityClient } from '../identity/web-identity';
import { webScopeSchema, type WebScope } from '../../../../packages/contracts/web-config';
import { checkedDeviceLink, connectionListSchema, connectionObservationsSchema, connectionViewSchema, connectionStateSchema, connectionPageSchema, type ConnectionList, type ConnectionState, type ConnectionPage, type ConnectionCommand } from '../../../../packages/contracts/aws/connections';
import { inventoryResponseSchema, syncSummarySchema, type InventoryUnit, type SyncSummary } from '../../../../packages/contracts/aws/inventory';
import { alertStatusSchema, type AlertStatus } from '../../../../packages/contracts/aws/alerts';
import { reportResponseSchema, type ReportSnapshot } from '../../../../packages/contracts/aws/report';
import { savedViewListSchema, type SavedView, type SavedViewInput } from '../../../../packages/contracts/aws/saved-views';

export type ConnectionClientState = {
  identity: WebIdentity | null; list: ConnectionList; selectedId?: string; status?: ConnectionState; inspection?: ConnectionPage; directory?: DirectorySnapshot;
  /** Latest read result per service for the selected connection (fresh or from the host's local cache). */
  inventories: Partial<Record<ConnectionPage['operation'], ConnectionPage>>; observedFrom?: 'cache' | 'live'; cachedAt?: string;
  /** Multi-account/region inventory from the host's disk cache, grouped by service, and the last sync summary. */
  units: Partial<Record<ConnectionPage['operation'], InventoryUnit[]>>; sync?: SyncSummary;
  /** Assessments of finished syncs (host disk cache) for the trend report, and this user's saved views (server settings). */
  report?: ReportSnapshot[]; alerts?: AlertStatus; views: SavedView[];
  /** Last failed read per area (e.g. read_access_denied) while the session stayed usable; cleared by a successful read. */
  readErrors: Partial<Record<ConnectionPage['operation'] | 'directory', string>>;
  /** A finished live sync still has units the host has not cached yet; polling continues while it makes progress. */
  syncDraining: boolean;
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
  private value: ConnectionClientState = { identity: null, list: emptyList(), inventories: {}, readErrors: {}, units: {}, views: [], syncDraining: false, loading: false, busy: false, retryable: false };
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
  private stalledPolls = 0;
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
    this.value = { identity, list: emptyList(), inventories: {}, readErrors: {}, units: {}, views: [], syncDraining: false, busy: false, loading: false, retryable: false }; this.listeners.forEach(listener => listener());
  }
  private current(epoch: number) { if (this.closed || epoch !== this.epoch) throw new RequestError('obsolete_response'); }
  private async request(path: string, epoch: number, pending?: Pick<Pending, 'body' | 'key'>, limit = 1_000_000): Promise<unknown> {
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
      if (text.length > limit) throw new RequestError('invalid_response');
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
    // Authentication/ownership failures wipe observations; other failures keep the last read results visible.
    const wipe = !(error instanceof RequestError) || [401, 403, 404].includes(error.status);
    this.set({ error: error instanceof RequestError ? error.code : 'request_unknown', busy: false, loading: false, status: undefined, retryable,
      ...(wipe ? { inspection: undefined, directory: undefined, inventories: {}, readErrors: {}, units: {}, sync: undefined, report: undefined, alerts: undefined, views: [], syncDraining: false, observedFrom: undefined, cachedAt: undefined } : {}) });
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
      if (changed) this.set({ status: undefined, inspection: undefined, directory: undefined, inventories: {}, readErrors: {}, units: {}, sync: undefined, report: undefined, alerts: undefined, views: [], syncDraining: false, observedFrom: undefined, cachedAt: undefined });
      this.set({ list, loading: false, ...(!selected ? { selectedId: undefined, status: undefined, inspection: undefined, directory: undefined, inventories: {}, readErrors: {}, units: {}, sync: undefined, report: undefined, alerts: undefined, views: [], syncDraining: false, observedFrom: undefined, cachedAt: undefined } : {}) });
    } catch (error) { if (sequence === this.listSequence) this.fail(error, epoch); }
  }
  async select(id: string) {
    if (this.value.busy || !this.value.list.items.some(item => item.id === id)) return;
    this.pending = undefined;
    this.set({ selectedId: id, status: undefined, inspection: undefined, directory: undefined, inventories: {}, readErrors: {}, units: {}, sync: undefined, report: undefined, alerts: undefined, views: [], syncDraining: false, observedFrom: undefined, cachedAt: undefined, error: undefined, retryable: false });
    // Cached results first: a connected status starts the automatic refresh, which would otherwise block the cache load until it finishes.
    await this.loadObservations(); await this.refreshStatus();
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
        const portal = (host: string) => /^[a-z0-9-]+\.awsapps\.com$/.test(host);
        if (!checkedDeviceLink(status.verificationUri, status.userCode, portal, false)
          || (status.verificationUriComplete && !checkedDeviceLink(status.verificationUriComplete, status.userCode, portal, true))) throw new RequestError('invalid_response');
      } else if (status.verificationUriComplete) throw new RequestError('invalid_response');
      this.set({ status });
    } catch (error) {
      // No running worker yet (e.g. after a host restart) is the ordinary "sign in to AWS" state, not an error.
      if (sequence === this.statusSequence && error instanceof RequestError && error.code === 'worker_unavailable' && epoch === this.epoch) { this.set({ status: undefined }); return; }
      if (sequence === this.statusSequence) this.fail(error, epoch);
    }
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
  /** Last cached read results from the host (owned connection only). Fresh results already shown are never replaced. */
  async loadObservations() {
    const selected = this.value.list.items.find(item => item.id === this.value.selectedId);
    if (!selected || this.value.busy) return;
    const epoch = this.epoch;
    try {
      const cached = connectionObservationsSchema.parse(await this.request(`/${selected.id}/observations`, epoch)); this.current(epoch);
      if (selected.id !== this.value.selectedId) return;
      const pages = Object.values(cached.inventories).filter((page): page is ConnectionPage => Boolean(page));
      pages.forEach(page => this.match(page)); if (cached.directory) this.match(cached.directory);
      const inventories = { ...Object.fromEntries(pages.map(page => [page.operation, page])), ...this.value.inventories };
      const sync = cached.sync ? syncSummarySchema.safeParse(cached.sync) : undefined;
      this.set({ inventories, ...(!this.value.directory && cached.directory ? { directory: cached.directory } : {}),
        ...(pages.length || cached.directory ? { cachedAt: cached.savedAt, observedFrom: this.value.observedFrom ?? 'cache' } : {}),
        ...(sync?.success && sync.data.connectionId === selected.id ? { sync: sync.data } : {}) });
      await this.loadInventory(); await this.loadReport(); await this.loadViews(); await this.loadAlerts();
    } catch (error) { if (epoch === this.epoch && error instanceof RequestError && [401, 403, 404].includes(error.status)) this.fail(error, epoch); }
  }
  /** Trend snapshots recorded by the host after each finished sync (never calls a worker). */
  async loadReport() {
    const selected = this.value.list.items.find(item => item.id === this.value.selectedId);
    if (!selected) return;
    const epoch = this.epoch;
    try {
      const response = reportResponseSchema.parse(await this.request(`/${selected.id}/report`, epoch, undefined, 16_000_000)); this.current(epoch);
      if (selected.id === this.value.selectedId) this.set({ report: response.snapshots });
    } catch (error) { if (epoch === this.epoch && error instanceof RequestError && [401, 403].includes(error.status)) this.fail(error, epoch); }
  }
  /** E-mail alert status (masked recipients, recent outcomes) from the host; never calls a worker. */
  async loadAlerts() {
    const selected = this.value.list.items.find(item => item.id === this.value.selectedId);
    if (!selected) return;
    const epoch = this.epoch;
    try {
      const response = alertStatusSchema.parse(await this.request(`/${selected.id}/alerts`, epoch)); this.current(epoch);
      if (selected.id === this.value.selectedId) this.set({ alerts: response });
    } catch (error) { if (epoch === this.epoch && error instanceof RequestError && [401, 403].includes(error.status)) this.fail(error, epoch); }
  }
  /** Sends the server's fixed test message to the configured recipients. One click, one request; never retried automatically. */
  async testAlert(): Promise<string | undefined> {
    const selected = this.value.list.items.find(item => item.id === this.value.selectedId);
    if (!selected) return 'connection_unavailable';
    const epoch = this.epoch;
    try {
      const response = alertStatusSchema.parse(await this.request(`/${selected.id}/alerts`, epoch, { body: { operation: 'test' }, key: crypto.randomUUID() })); this.current(epoch);
      if (selected.id === this.value.selectedId) this.set({ alerts: response });
      return undefined;
    } catch (error) {
      if (epoch === this.epoch && error instanceof RequestError && [401, 403].includes(error.status)) this.fail(error, epoch);
      if (epoch === this.epoch) await this.loadAlerts();
      return error instanceof RequestError ? error.code : 'request_unknown';
    }
  }
  async loadViews() {
    const selected = this.value.list.items.find(item => item.id === this.value.selectedId);
    if (!selected) return;
    const epoch = this.epoch;
    try {
      const response = savedViewListSchema.parse(await this.request(`/${selected.id}/views`, epoch)); this.current(epoch);
      if (selected.id === this.value.selectedId) this.set({ views: response.items });
    } catch (error) { if (epoch === this.epoch && error instanceof RequestError && [401, 403].includes(error.status)) this.fail(error, epoch); }
  }
  /** Saves (same name replaces) or deletes a saved view. Independent of connection actions, so it never blocks or retries them. */
  async saveView(view: SavedViewInput) { return this.updateViews({ operation: 'save', view }); }
  async deleteView(id: string) { return this.updateViews({ operation: 'delete', id }); }
  private async updateViews(body: unknown) {
    const selected = this.value.list.items.find(item => item.id === this.value.selectedId);
    if (!selected) return false;
    const epoch = this.epoch;
    try {
      const response = savedViewListSchema.parse(await this.request(`/${selected.id}/views`, epoch, { body, key: crypto.randomUUID() })); this.current(epoch);
      if (selected.id === this.value.selectedId) this.set({ views: response.items });
      return true;
    } catch (error) {
      if (epoch === this.epoch && error instanceof RequestError && [401, 403].includes(error.status)) this.fail(error, epoch);
      return false;
    }
  }
  /** All cached inventory units of the selected connection (host disk cache; never calls a worker). */
  async loadInventory() {
    const selected = this.value.list.items.find(item => item.id === this.value.selectedId);
    if (!selected) return;
    const epoch = this.epoch;
    try {
      const response = inventoryResponseSchema.parse(await this.request(`/${selected.id}/inventory/all`, epoch, undefined, 32_000_000)); this.current(epoch);
      if (selected.id !== this.value.selectedId || response.service !== 'all') return;
      const units: ConnectionClientState['units'] = {};
      for (const unit of response.units) (units[unit.service] ??= []).push(unit);
      this.set({ units });
    } catch (error) { if (epoch === this.epoch && error instanceof RequestError && [401, 403, 404].includes(error.status)) this.fail(error, epoch); }
  }
  /** Progress of the running sync; newly cached units are reloaded. Polling never starts a sync, worker or login. */
  async pollSync() {
    const selected = this.value.list.items.find(item => item.id === this.value.selectedId);
    if (!selected) return;
    const epoch = this.epoch, previous = this.value.sync;
    try {
      const sync = syncSummarySchema.parse(await this.request(`/${selected.id}/sync`, epoch)); this.current(epoch);
      if (selected.id !== this.value.selectedId) return;
      if (sync.connectionId !== selected.id) throw new RequestError('invalid_response');
      // After the job ends, keep fetching its remaining units; stop after repeated polls without progress.
      this.stalledPolls = sync.state !== 'running' && sync.cachedUnits === previous?.cachedUnits && sync.jobId === previous?.jobId ? this.stalledPolls + 1 : 0;
      this.set({ sync, syncDraining: sync.live && sync.state !== 'running' && (sync.remaining ?? 0) > 0 && this.stalledPolls < 10 });
      if (sync.cachedUnits !== previous?.cachedUnits || sync.state !== previous?.state || sync.jobId !== previous?.jobId) await this.loadInventory();
      if (sync.state !== 'running' && previous?.state === 'running') await this.refreshStatus();
      if (sync.state !== 'running' && !sync.remaining && (previous?.state === 'running' || previous?.remaining)) { await this.loadReport(); await this.loadAlerts(); }
    } catch (error) {
      if (epoch !== this.epoch || error instanceof RequestError && error.code === 'sync_not_found') return;
      if (error instanceof RequestError && [401, 403].includes(error.status)) this.fail(error, epoch);
    }
  }
  /** Payer selection reuses this user's connection for the configuration or registers it; it grants nothing by itself. */
  async choosePayer(configurationId: string) {
    if (this.value.busy || !this.value.list.configurations.some(item => item.id === configurationId)) return;
    const existing = this.value.list.items.find(item => item.configurationId === configurationId);
    if (existing) { if (existing.id !== this.value.selectedId) await this.select(existing.id); return; }
    await this.create(configurationId);
  }
  /** One explicit click: choose the payer, then start Device Code login unless the session is already connected. */
  async loginPayer(configurationId: string) {
    await this.choosePayer(configurationId);
    const selected = this.value.list.items.find(item => item.id === this.value.selectedId);
    if (!selected || selected.configurationId !== configurationId || this.value.status?.status === 'connected') return;
    await this.perform({ operation: 'login' });
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
    this.set({ busy: true, loading: false, error: undefined, retryable: false, status: undefined });
    try {
      const result = await this.request(pending.path, epoch, pending); this.current(epoch);
      if (pending.operation === 'create') {
        const item = connectionViewSchema.parse(result);
        const configuration = this.value.list.configurations.find(config => config.id === (pending.body as { configurationId: string }).configurationId);
        if (!configuration || item.configurationId !== configuration.id || item.accountId !== configuration.accountId || item.roleName !== configuration.roleName || item.region !== configuration.region || JSON.stringify(item.directory) !== JSON.stringify(configuration.directory)) throw new RequestError('invalid_response');
        this.set({ list: { ...this.value.list, items: [...this.value.list.items.filter(row => row.id !== item.id), item] }, selectedId: item.id });
      } else if (pending.operation === 'directory') {
        const directory = directorySnapshotSchema.parse(result); this.match(directory); const { directory: _, ...readErrors } = this.value.readErrors; this.set({ directory, readErrors, observedFrom: 'live' });
      } else if (pending.operation === 'inspect') {
        const inspection = connectionPageSchema.parse(result); this.match(inspection);
        if (inspection.operation !== (pending.body as ConnectionCommand).service) throw new RequestError('invalid_response');
        const { [inspection.operation]: _, ...readErrors } = this.value.readErrors;
        this.set({ inspection, inventories: { ...this.value.inventories, [inspection.operation]: inspection }, readErrors, observedFrom: 'live' });
      } else if (pending.operation === 'sync') {
        const sync = syncSummarySchema.parse(result);
        if (sync.connectionId !== pending.connectionId) throw new RequestError('invalid_response');
        this.set({ sync });
      } else if (pending.operation === 'login' || pending.operation === 'verify') {
        const status = connectionStateSchema.parse(result); this.match(status); delete status.userCode; delete status.verificationUri; delete status.verificationUriComplete; this.set({ status });
      } else {
        const schema = pending.operation === 'disconnect' ? z.object({ disconnected: z.literal(true), cliCacheRetained: z.literal(true) }).strict() : z.object({ disconnected: z.literal(true), remoteLogout: z.enum(['confirmed', 'unknown']) }).strict();
        const value = schema.parse(result); this.set({ error: 'remoteLogout' in value && value.remoteLogout === 'unknown' ? 'logout_unknown' : undefined });
      }
      this.pending = undefined; this.set({ busy: false });
      await this.refreshStatus();
      // Saved views belong to the configuration, so a newly registered connection may already have some.
      if (pending.operation === 'create') await this.loadViews();
    } catch (error) {
      // A read that failed for one area (missing permission, throttling) keeps the session; record it and recheck the status.
      const area = pending.operation === 'inspect' ? (pending.body as ConnectionCommand).service : pending.operation === 'directory' ? 'directory' as const : undefined;
      if (area && epoch === this.epoch && error instanceof RequestError && error.code.startsWith('read_')) {
        this.pending = undefined; this.set({ busy: false, error: error.code, readErrors: { ...this.value.readErrors, [area]: error.code } }); await this.refreshStatus(); return;
      }
      // No running worker (e.g. the host restarted): the AWS session has ended. The host already recorded the request as unknown,
      // so replaying the same key cannot help; ask for a new AWS sign-in and keep the cached results.
      if (epoch === this.epoch && error instanceof RequestError && error.code === 'worker_unavailable' && pending.operation !== 'login' && pending.operation !== 'create') {
        this.pending = undefined; this.set({ busy: false, error: 'aws_session_required', retryable: false, status: undefined }); return;
      }
      this.fail(error, epoch, !(error instanceof RequestError && ([400, 401, 403, 404, 409].includes(error.status) || error.code === 'worker_unavailable')));
      if (epoch === this.epoch && error instanceof RequestError && ['directory_cursor_invalid', 'directory_cursor_expired', 'directory_scope_unverified'].includes(error.code)) await this.refreshStatus();
    }
  }
  close() { this.closed = true; this.epoch++; this.unsubscribe(); this.inflight.forEach(controller => controller.abort()); this.inflight.clear(); this.listeners.clear(); this.pending = undefined; }
}
