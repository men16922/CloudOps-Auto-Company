import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { VerifiedCloudContext } from '../../../../src/domain/cloud-operations';
import { CloudOperationError } from '../../../../src/domain/cloud-workflow';
import { assertCliOwner, checkedCliIdentity, cliBindingSchema, cliFailure, cliReadSchema, DeviceInstructionParser, type CliBinding, type CliIdentity, type CliLoginState, type CliRuntime } from './organization-cli-contract';
import { OrganizationDirectory } from './organization-directory';
import type { DirectorySnapshot } from '../../../../src/modules/aws/domain/directory';

const pageSchema = z.object({ Items: z.array(z.object({ name: z.string().min(1).max(1024), runtime: z.string().max(100).nullable().optional(), modified: z.string().max(100).optional(), state: z.string().max(100).optional() }).strict()).max(100), HasMore: z.boolean() }).strict();
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
  constructor(binding: unknown, runtime: CliRuntime, now = Date.now) {
    this.binding = Object.freeze(cliBindingSchema.parse(binding)); this.runtime = runtime; this.now = now;
    this.state = this.base('disconnected'); this.directoryBrowser = new OrganizationDirectory(this.binding, runtime, now);
  }
  private base(status: CliLoginState['status']): CliLoginState {
    return { status, connectionId: this.binding.connectionId, accountId: this.binding.accountId, roleName: this.binding.roleName, region: this.binding.region };
  }
  private invalidate(status: CliLoginState['status'], code?: string) {
    this.generation++; this.identity = undefined; this.directoryBrowser.clear();
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
    this.identity = undefined; this.directoryBrowser.clear();
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
  async inspect(context: VerifiedCloudContext, input: unknown) {
    const operation = cliReadSchema.parse(input);
    assertCliOwner(context, this.binding); this.expire();
    const pinned = this.identity;
    if (this.state.status !== 'connected' || !pinned) throw cliFailure('connection_unavailable', 401);
    const { controller, generation } = this.claim(context);
    let result: z.infer<typeof pageSchema> | undefined;
    await this.track(controller, async () => {
      try {
        const before = checkedCliIdentity((await this.runtime.run('identity', controller.signal)).stdout, this.binding);
        this.current(generation, controller); if (!sameIdentity(before, pinned)) throw cliFailure('identity_changed', 403);
        const raw = await this.runtime.run(operation, controller.signal);
        this.current(generation, controller);
        const after = checkedCliIdentity((await this.runtime.run('identity', controller.signal)).stdout, this.binding);
        this.current(generation, controller); if (!sameIdentity(after, pinned)) throw cliFailure('identity_changed', 403);
        try { result = pageSchema.parse(JSON.parse(raw.stdout)); } catch { throw cliFailure('invalid_read_result'); }
      } catch (error) { this.failure(error, generation); throw error instanceof CloudOperationError ? error : cliFailure(); }
    });
    if (!result) throw cliFailure();
    return { connectionId: this.binding.connectionId, accountId: this.binding.accountId, region: this.binding.region, operation, collectedAt: new Date(this.now()).toISOString(), items: result.Items, hasMore: result.HasMore };
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
