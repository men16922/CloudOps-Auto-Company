import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { VerifiedCloudContext } from '../../../../src/domain/cloud-operations';
import { CloudOperationError } from '../../../../src/domain/cloud-workflow';
import { assertCliOwner, checkedCliIdentity, cliBindingSchema, cliFailure, cliReadSchema, DeviceInstructionParser, metricQueries, readQuerySchema, taggedResourceTypes, type CliBinding, type CliIdentity, type CliLoginState, type CliOperation, type CliRead, type CliRuntime, type CliTarget, type ReadQuery } from './organization-cli-contract';
import { OrganizationSync, sessionCodes } from './organization-sync';
import { eksVersions, withEksSupport, type EksVersion } from './organization-lifecycle';
import type { SyncJob } from '../../../../src/modules/aws/domain/inventory';
import { OrganizationDirectory } from './organization-directory';
import type { DirectorySnapshot } from '../../../../src/modules/aws/domain/directory';
import { connectionItemSchema, connectionMetricIds } from '../../../../src/modules/aws/domain/connections';

const itemSchema = connectionItemSchema.extend({ name: z.string().min(1).max(1024) });
const pageSchema = z.object({ Items: z.array(itemSchema).max(100), HasMore: z.boolean() }).strict();
type Page = z.infer<typeof pageSchema>;
type Item = z.infer<typeof itemSchema>;
const metricRowsSchema = z.object({ Items: z.array(z.object({ id: z.enum(connectionMetricIds), name: z.string().max(1024).nullable(), latest: z.number().finite().nullable(),
  max: z.number().finite().nullable(), min: z.number().finite().nullable(), sum: z.number().finite().nullable() }).strict()).max(5000), HasMore: z.boolean() }).strict();
// JMESPath projections return null for absent fields; for these results null and absent mean the same.
const withoutNulls = (value: unknown) => value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).filter(([, field]) => field !== null)) : value;
function parsedPage(raw: string): Page {
  try { const value = JSON.parse(raw) as { Items?: unknown }; return pageSchema.parse({ ...value, Items: Array.isArray(value.Items) ? value.Items.map(withoutNulls) : value.Items }); } catch { throw cliFailure('invalid_read_result'); }
}
function parsedItem(raw: string): Item { try { return itemSchema.parse(withoutNulls(JSON.parse(raw))); } catch { throw cliFailure('invalid_read_result'); } }
/** Keeps the worst ten resources per standard metric. Several nodes/brokers of one cluster collapse to the cluster's worst value. */
function metricPage(raw: string): Page {
  let rows: z.infer<typeof metricRowsSchema>;
  try { rows = metricRowsSchema.parse(JSON.parse(raw)); } catch { throw cliFailure('invalid_read_result'); }
  const items: Item[] = [];
  for (const metric of metricQueries) {
    const worse = (left: number, right: number) => metric.worst === 'min' ? Math.min(left, right) : Math.max(left, right), grouped = new Map<string, { value: number; peak: number }>();
    for (const row of rows.Items) {
      const peak = metric.worst === 'min' ? row.min : metric.worst === 'sum' ? row.sum : row.max;
      if (row.id !== metric.id || row.latest === null || peak === null) continue;
      // A series with data but no resolvable resource label must not read as "no data".
      if (!row.name || !metric.label.test(row.name)) throw cliFailure('invalid_read_result');
      const prior = grouped.get(row.name);
      grouped.set(row.name, prior ? { value: worse(prior.value, row.latest), peak: worse(prior.peak, peak) } : { value: row.latest, peak });
    }
    items.push(...[...grouped].sort((left, right) => metric.worst === 'min' ? left[1].peak - right[1].peak : right[1].peak - left[1].peak).slice(0, 10)
      .map(([name, value]) => ({ name, metric: metric.id, value: value.value, peak: value.peak, ...(metric.dimension === 'InstanceId' ? { id: name } : {}) })));
  }
  return { Items: items, HasMore: rows.HasMore };
}
const readFailure = (code: string) => cliFailure(['sso_denied', 'access_denied'].includes(code) ? 'read_access_denied' : code === 'cli_throttled' ? 'read_throttled'
  : code === 'invalid_read_result' ? 'read_invalid_result' : code === 'cli_timeout' ? 'read_timeout' : code === 'service_not_enabled' ? 'read_not_enabled' : code === 'service_not_subscribed' ? 'read_not_subscribed' : 'read_failed',
  code === 'access_denied' || code === 'sso_denied' ? 403 : code.startsWith('service_not_') ? 409 : 502);
const strictParse = <T>(schema: z.ZodType<T>, raw: string) => { try { return schema.parse(JSON.parse(raw)); } catch { throw cliFailure('invalid_read_result'); } };
const guardDutyIds = z.object({ Items: z.array(z.string().regex(/^[a-f0-9]{32}$/)).max(50).nullable(), HasMore: z.boolean() }).strict();
const taggedPage = z.object({ Items: z.array(z.object({ arn: z.string().max(2048), tags: z.array(z.string().min(1).max(128)).max(80) }).strict()).max(100).nullable(), HasMore: z.boolean() }).strict();
type TaggedType = typeof taggedResourceTypes[number];
const taggedTypes: Partial<Record<CliRead, TaggedType>> = { lambda: 'lambda:function', dynamodb: 'dynamodb:table', elasticache: 'elasticache:cluster' };
/** The resource name at the end of a tagging-API ARN, per resource type. */
const arnName: Record<TaggedType, RegExp> = { 'lambda:function': /:function:([^:/]+)$/, 'dynamodb:table': /:table\/([^/]+)$/, 'elasticache:cluster': /:cluster:([^:/]+)$/ };
/** EKS cluster details stop here so identity checks still finish well inside the host's operation timeout. */
const eksDetailBudgetMs = 12_000;
const sameIdentity = (a: CliIdentity, b: CliIdentity) => a.accountId === b.accountId && a.arn === b.arn && a.userId === b.userId;

/** One worker belongs to exactly one connection/user. Its runtime must have an isolated OS/cache. */
export class OrganizationCliWorker {
  readonly binding: Readonly<CliBinding>;
  private readonly runtime: CliRuntime;
  private readonly now: () => number;
  private state: CliLoginState;
  private identity?: CliIdentity;
  private readonly directoryBrowser: OrganizationDirectory;
  private generation = 0;
  private deadline = 0;
  private loggingOut = false;
  private closed = false;
  private running?: { controller: AbortController; done: Promise<void> };
  private sync?: OrganizationSync;
  constructor(binding: unknown, runtime: CliRuntime, now = Date.now) {
    this.binding = Object.freeze(cliBindingSchema.parse(binding)); this.runtime = runtime; this.now = now;
    this.state = this.base('disconnected'); this.directoryBrowser = new OrganizationDirectory(this.binding, runtime, now);
  }
  private base(status: CliLoginState['status']): CliLoginState {
    return { status, connectionId: this.binding.connectionId, accountId: this.binding.accountId, roleName: this.binding.roleName, region: this.binding.region };
  }
  private invalidate(status: CliLoginState['status'], code?: string) {
    this.generation++; this.identity = undefined; this.directoryBrowser.clear(); this.discardSync();
    this.state = { ...this.base(status), ...(code ? { code } : {}) };
    this.running?.controller.abort();
  }
  private expire() {
    if (['connected', 'starting', 'awaiting-user', 'verifying'].includes(this.state.status) && this.now() >= this.deadline) this.invalidate('expired', 'connection_expired');
  }
  status(context: VerifiedCloudContext): CliLoginState {
    assertCliOwner(context, this.binding); this.expire(); return structuredClone(this.state);
  }
  private claim(context: VerifiedCloudContext, forLogout = false) {
    assertCliOwner(context, this.binding); this.expire();
    if (this.closed) throw cliFailure('worker_closed', 503);
    if (this.running || (this.loggingOut && !forLogout)) throw cliFailure('connection_busy', 409);
    const controller = new AbortController(), generation = ++this.generation;
    return { controller, generation };
  }
  private current(generation: number, controller: AbortController) {
    this.expire();
    if (generation !== this.generation || controller.signal.aborted) throw cliFailure('connection_unavailable', 401);
  }
  private failure(error: unknown, generation: number) {
    if (this.generation !== generation) return;
    const code = error instanceof CloudOperationError ? error.code : 'cli_failed';
    this.identity = undefined; this.directoryBrowser.clear(); this.discardSync();
    this.state = { ...this.base(code === 'sso_denied' ? 'denied' : code === 'sso_expired' || code === 'cli_timeout' ? 'expired' : 'failed'), code };
  }
  private track(controller: AbortController, task: () => Promise<void>) {
    const job = { controller, done: Promise.resolve() };
    this.running = job;
    job.done = Promise.resolve().then(task).finally(() => { if (this.running === job) this.running = undefined; });
    return job.done;
  }
  start(context: VerifiedCloudContext): CliLoginState {
    const { controller, generation } = this.claim(context);
    this.identity = undefined; this.directoryBrowser.clear(); this.deadline = this.now() + 600_000;
    this.state = { ...this.base('starting'), jobId: randomUUID(), deadline: new Date(this.deadline).toISOString() };
    const parser = new DeviceInstructionParser(this.binding);
    let showedInstructions = false;
    void this.track(controller, async () => {
      try {
        await this.runtime.run('login', controller.signal, chunk => {
          this.current(generation, controller);
          const instructions = parser.feed(chunk);
          if (instructions) { showedInstructions = true; this.state = { ...this.state, ...instructions, status: 'awaiting-user' }; }
        });
        this.current(generation, controller);
        if (!showedInstructions) throw cliFailure('invalid_device_output');
        this.state = { ...this.base('verifying'), jobId: this.state.jobId, deadline: this.state.deadline };
        const identity = checkedCliIdentity((await this.runtime.run('identity', controller.signal)).stdout, this.binding);
        this.current(generation, controller); this.identity = identity; this.deadline = this.now() + 1_800_000;
        this.state = { ...this.base('connected'), deadline: new Date(this.deadline).toISOString() };
      } catch (error) { controller.abort(); this.failure(error, generation); }
    });
    return structuredClone(this.state);
  }
  /** Reuse only this worker's own SSO cache, still requiring an exact account/SSO role check. */
  async verify(context: VerifiedCloudContext): Promise<CliLoginState> {
    const { controller, generation } = this.claim(context);
    this.deadline = this.now() + 30_000; this.identity = undefined; this.directoryBrowser.clear(); this.state = this.base('verifying');
    await this.track(controller, async () => {
      try {
        const identity = checkedCliIdentity((await this.runtime.run('identity', controller.signal)).stdout, this.binding);
        this.current(generation, controller); this.identity = identity; this.deadline = this.now() + 1_800_000;
        this.state = { ...this.base('connected'), deadline: new Date(this.deadline).toISOString() };
      } catch (error) { this.failure(error, generation); throw error instanceof CloudOperationError ? error : cliFailure(); }
    });
    return this.status(context);
  }
  /** One fixed read. EKS adds its version-support list and per-cluster details; metrics run one fixed SEARCH request. */
  private async read(operation: CliRead, signal: AbortSignal, check: () => void, started: number, target?: CliTarget): Promise<Page> {
    const run = async (command: CliOperation, input?: ReadQuery) => { const result = await this.runtime.run(command, signal, undefined, input, target); check(); return result.stdout; };
    if (operation === 'metrics') return metricPage(await run('metrics', { kind: 'metrics', end: new Date(this.now()).toISOString() }));
    if (operation === 'automation') return parsedPage(await run('automation', { kind: 'automation', since: new Date(this.now() - 7 * 86_400_000).toISOString() }));
    if (operation === 'guardduty') {
      // One detector per account and region; none means GuardDuty is not enabled there.
      const detectorId = strictParse(guardDutyIds, await run('guardduty-detectors')).Items?.[0];
      if (!detectorId) throw cliFailure('service_not_enabled');
      const found = strictParse(guardDutyIds, await run('guardduty-findings', { kind: 'guardduty-findings', detectorId }));
      if (!found.Items?.length) return { Items: [], HasMore: found.HasMore };
      return { Items: parsedPage(await run('guardduty-details', { kind: 'guardduty-details', detectorId, findingIds: found.Items })).Items, HasMore: found.HasMore };
    }
    if (operation === 'apigateway') {
      const rest = parsedPage(await run('apigateway-rest')), http = parsedPage(await run('apigateway-http')), items = [...rest.Items, ...http.Items];
      return { Items: items.slice(0, 100), HasMore: rest.HasMore || http.HasMore || items.length > 100 };
    }
    const page = parsedPage(await run(operation)), taggedType = taggedTypes[operation];
    if (taggedType && page.Items.length) {
      // The tagging API returns every tagged (or previously tagged) resource, so a resource missing from a complete page has no tags.
      // Without a complete page the tags stay unknown; a failed tagging read never fails the inventory read itself.
      try {
        const tagged = strictParse(taggedPage, await run('tagged-resources', { kind: 'tags', resourceType: taggedType })), byName = new Map<string, string[]>();
        for (const entry of tagged.Items ?? []) { const name = arnName[taggedType].exec(entry.arn)?.[1]; if (name) byName.set(name, entry.tags); }
        return { ...page, Items: page.Items.map(item => { const tags = byName.get(item.name) ?? (tagged.HasMore ? undefined : []); return tags ? { ...item, tags } : item; }) };
      } catch (error) { if (signal.aborted || !(error instanceof CloudOperationError) || error.code === 'connection_unavailable' || sessionCodes.has(error.code)) throw error; return page; }
    }
    if (operation !== 'eks' || !page.Items.length) return page;
    // Support status and end dates come from AWS (no built-in version calendar). Their absence leaves support unknown.
    let versions = new Map<string, EksVersion>();
    try { versions = eksVersions(await run('eks-versions')); }
    catch (error) { if (signal.aborted || !(error instanceof CloudOperationError) || error.code === 'connection_unavailable') throw error; }
    const details = new Map<string, Item>();
    for (const item of page.Items) {
      const query = readQuerySchema.safeParse({ kind: 'eks-cluster', name: item.name });
      if (!query.success) continue;
      if (this.now() - started > eksDetailBudgetMs || details.size >= 20) break;
      const detail = parsedItem(await run('eks-cluster', query.data));
      if (detail.name === item.name) details.set(item.name, detail);
    }
    return { Items: page.Items.map(item => { const detail = details.get(item.name); return detail ? withEksSupport(detail, versions) : item; }),
      HasMore: page.HasMore || details.size < page.Items.length };
  }
  async inspect(context: VerifiedCloudContext, input: unknown) {
    const operation = cliReadSchema.parse(input);
    assertCliOwner(context, this.binding); this.expire();
    const pinned = this.identity;
    if (this.state.status !== 'connected' || !pinned) throw cliFailure('connection_unavailable', 401);
    const { controller, generation } = this.claim(context), started = this.now();
    let result: Page | undefined;
    await this.track(controller, async () => {
      try {
        const before = checkedCliIdentity((await this.runtime.run('identity', controller.signal)).stdout, this.binding);
        this.current(generation, controller); if (!sameIdentity(before, pinned)) throw cliFailure('identity_changed', 403);
        let page: Page | undefined, readError: CloudOperationError | undefined;
        try { page = await this.read(operation, controller.signal, () => this.current(generation, controller), started); } catch (error) {
          // A service-level failure (e.g. a missing IAM permission for one API) with an unchanged session affects only that read.
          if (controller.signal.aborted || generation !== this.generation || !(error instanceof CloudOperationError) || error.code === 'connection_unavailable') throw error;
          readError = error;
        }
        this.current(generation, controller);
        const after = checkedCliIdentity((await this.runtime.run('identity', controller.signal)).stdout, this.binding);
        this.current(generation, controller); if (!sameIdentity(after, pinned)) throw cliFailure('identity_changed', 403);
        if (readError) throw readFailure(readError.code);
        result = page;
      } catch (error) {
        if (!(error instanceof CloudOperationError && error.code.startsWith('read_'))) this.failure(error, generation);
        throw error instanceof CloudOperationError ? error : cliFailure();
      }
    });
    if (!result) throw cliFailure();
    return { connectionId: this.binding.connectionId, accountId: this.binding.accountId, region: this.binding.region, operation, collectedAt: new Date(this.now()).toISOString(), items: result.Items, hasMore: result.HasMore };
  }
  private discardSync() { this.sync = undefined; }
  /** Explicit user action: one background sync at a time. It occupies this worker until it ends, like a login. */
  startSync(context: VerifiedCloudContext): SyncJob {
    assertCliOwner(context, this.binding); this.expire();
    const pinned = this.identity;
    if (this.state.status !== 'connected' || !pinned) throw cliFailure('connection_unavailable', 401);
    const { controller, generation } = this.claim(context), check = () => this.current(generation, controller);
    const sync = new OrganizationSync({ binding: this.binding, pinned, now: this.now, readFailure: code => readFailure(code),
      run: async (operation, input, target) => { const result = await this.runtime.run(operation, controller.signal, undefined, input, target); check(); return result.stdout; },
      read: async (service, target) => { const page = await this.read(service, controller.signal, check, this.now(), target); return { items: page.Items, hasMore: page.HasMore }; } });
    this.sync = sync;
    void this.track(controller, async () => {
      try {
        const before = checkedCliIdentity((await this.runtime.run('identity', controller.signal)).stdout, this.binding);
        check(); if (!sameIdentity(before, pinned)) throw cliFailure('identity_changed', 403);
        await sync.run();
      } catch (error) {
        const code = error instanceof CloudOperationError ? error.code : 'cli_failed';
        sync.job.state = code === 'connection_expired' || this.state.status === 'expired' ? 'expired' : controller.signal.aborted ? 'cancelled' : 'failed'; sync.job.code = code;
        // Only a session-level failure ends the AWS session; e.g. a denied Organizations read fails just this sync.
        if (this.sync === sync && !controller.signal.aborted && (!(error instanceof CloudOperationError) || sessionCodes.has(code))) this.failure(error, generation);
      } finally { sync.job.finishedAt = new Date(this.now()).toISOString(); }
    });
    return structuredClone(sync.job);
  }
  /** Progress and unit references of this worker's current sync (cleared by logout, expiry or a session failure). */
  syncStatus(context: VerifiedCloudContext): SyncJob {
    assertCliOwner(context, this.binding); this.expire();
    if (!this.sync) throw cliFailure('sync_not_found', 404);
    return structuredClone(this.sync.job);
  }
  syncUnit(context: VerifiedCloudContext, id: string) {
    assertCliOwner(context, this.binding); this.expire();
    const unit = this.sync?.units.get(id);
    if (!unit) throw cliFailure('sync_unit_not_found', 404);
    return { connectionId: this.binding.connectionId, jobId: this.sync!.job.jobId, unitId: id, unit: structuredClone(unit) };
  }
  async directory(context: VerifiedCloudContext, cursor?: string): Promise<DirectorySnapshot> {
    assertCliOwner(context, this.binding); this.expire();
    if (!this.binding.directory) throw cliFailure('directory_not_configured', 409);
    const pinned = this.identity;
    if (this.state.status !== 'connected' || !pinned) throw cliFailure('connection_unavailable', 401);
    if (this.running) throw cliFailure('connection_busy', 409);
    const selection = this.directoryBrowser.prepare(cursor);
    const { controller, generation } = this.claim(context);
    const timer = setTimeout(() => controller.abort(), 25_000); timer.unref();
    let result: DirectorySnapshot | undefined;
    try {
      await this.track(controller, async () => {
        try {
          const before = checkedCliIdentity((await this.runtime.run('identity', controller.signal)).stdout, this.binding);
          this.current(generation, controller); if (!sameIdentity(before, pinned)) throw cliFailure('identity_changed', 403);
          const snapshot = await this.directoryBrowser.collect(selection, controller.signal);
          this.current(generation, controller);
          const after = checkedCliIdentity((await this.runtime.run('identity', controller.signal)).stdout, this.binding);
          this.current(generation, controller); if (!sameIdentity(after, pinned)) throw cliFailure('identity_changed', 403);
          result = snapshot;
        } catch (error) {
          if (error instanceof CloudOperationError && (error.code.startsWith('directory_cursor_') || error.code === 'directory_scope_unverified')) this.directoryBrowser.clear();
          else this.failure(error, generation);
          throw error instanceof CloudOperationError ? error : cliFailure();
        }
      });
    } finally { clearTimeout(timer); }
    if (!result) throw cliFailure();
    return result;
  }
  disconnect(context: VerifiedCloudContext) {
    assertCliOwner(context, this.binding); this.invalidate(this.running ? 'cancelled' : 'disconnected');
    return { disconnected: true as const, cliCacheRetained: true as const };
  }
  /** Logout affects this isolated worker's profiles; never call it on a shared host cache. */
  async logout(context: VerifiedCloudContext) {
    assertCliOwner(context, this.binding);
    if (this.loggingOut || this.closed) throw cliFailure('connection_busy', 409);
    this.loggingOut = true; const previous = this.running;
    this.invalidate('disconnected');
    // Wait for the owned child to exit before clearing its cache. No concurrent new login.
    try {
      if (previous) await previous.done.catch(() => undefined);
      const { controller, generation } = this.claim(context, true);
      let confirmed = false;
      await this.track(controller, async () => {
        try { await this.runtime.run('logout', controller.signal); if (generation === this.generation) confirmed = true; }
        catch { /* Disconnection is local; failed remote/cache logout remains unknown. */ }
      });
      return { disconnected: true as const, remoteLogout: confirmed ? 'confirmed' as const : 'unknown' as const };
    } finally { this.loggingOut = false; }
  }
  /** Await child cleanup on worker shutdown; never resume pending operations after a restart. */
  async close() { this.closed = true; this.invalidate('disconnected'); await this.running?.done.catch(() => undefined); }
}
