import { randomUUID } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import { z } from 'zod';
import { CloudOperationError } from '../../../../packages/contracts/errors';
import { cliBindingSchema, bindingDigest, type CliBinding } from '../../../../packages/worker-protocol/cli-contract';
import { workerCommandSchema } from '../../../../packages/worker-protocol/commands';
import { OrganizationConnections, type OrganizationWorkerTransport } from '../connections/connections';
import type { CloudStore } from '../storage/store';
import type { ObservationCache } from '../connections/observation-cache';
import type { OrganizationWebAccess } from '../identity/web-access';
import { OrganizationWorkerRouter } from './router';
import { OrganizationWorkerLeases, workerLeaseHandle, workerReadyReceiptSchema, type WorkerLeaseReason, type WorkerReadyReceipt, type WorkerRetirementReceipt } from './leases';
import { workerLeaseHandleSchema, type WorkerLeaseHandle } from '../../../../packages/worker-protocol/lease-handle';

export type WorkerAllocation = Readonly<{ binding: CliBinding; handle: WorkerLeaseHandle }>;
export type ProvisionedOrganizationWorker = { input: Writable; output: Readable; receipt: WorkerReadyReceipt };
/** Trusted infrastructure only. Both operations are keyed by the complete immutable allocation.
 * fenceAndStop MUST prevent pending/late creation of this lease ID and revoke cache access before attesting.
 * A request timeout, a sent kill signal or an absent local pipe is not a termination receipt.
 */
export interface OrganizationWorkerProvisioner {
  provision(allocation: WorkerAllocation, signal: AbortSignal): Promise<ProvisionedOrganizationWorker>;
  fenceAndStop(allocation: WorkerAllocation, signal: AbortSignal): Promise<WorkerRetirementReceipt>;
}
export type WorkerAuthorization = (binding: CliBinding, signal: AbortSignal) => Promise<{ revision: string }>;
type Entry = WorkerAllocation & { revision: string; router: OrganizationWorkerRouter; abort: AbortController;
  ready: boolean; stopping: boolean; cleanup?: Promise<boolean> };
type WorkerReply = Awaited<ReturnType<OrganizationWorkerTransport['invoke']>>;
const unavailable = () => new CloudOperationError(503, 'worker_unavailable', 'The isolated connection worker is unavailable.');
const revisionSchema = z.object({ revision: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const equalHandle = (a: WorkerLeaseHandle, b: WorkerLeaseHandle) => JSON.stringify(a) === JSON.stringify(b);
const allocationCopy = (value: WorkerAllocation): WorkerAllocation => ({ binding: cliBindingSchema.parse(value.binding), handle: workerLeaseHandleSchema.parse(value.handle) });

/** Abort the wait even if an infrastructure adapter ignores its signal. Never expose its raw exception. */
function bounded<T>(value: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(unavailable()); };
    value.then(result => { signal.removeEventListener('abort', abort); signal.aborted ? reject(unavailable()) : resolve(result); },
      () => { signal.removeEventListener('abort', abort); reject(unavailable()); });
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
  });
}

/** Private transport behind OrganizationConnections, which owns durable command reservations/replay.
 * No default provisioner, shared-host CLI, credential lookup or automatic takeover exists here.
 */
export class OrganizationWorkerSupervisor implements OrganizationWorkerTransport {
  readonly id = randomUUID();
  private readonly leases: OrganizationWorkerLeases;
  private readonly provisioner?: OrganizationWorkerProvisioner;
  private readonly authorize: WorkerAuthorization;
  private readonly timeoutMs: number;
  private readonly entries = new Map<string, Entry>();
  private readonly cleanups = new Set<Promise<boolean>>();
  private readonly requests = new Set<Promise<WorkerReply>>();
  private readonly shutdown = new AbortController();
  private timer?: ReturnType<typeof setInterval>;
  private maintenance?: Promise<void>;
  constructor(options: { leases: OrganizationWorkerLeases; authorize: WorkerAuthorization; provisioner?: OrganizationWorkerProvisioner;
    operationTimeoutMs?: number; heartbeatIntervalMs?: number }) {
    this.leases = options.leases; this.provisioner = options.provisioner; this.authorize = options.authorize;
    this.timeoutMs = z.number().int().min(100).max(25_000).parse(options.operationTimeoutMs ?? 25_000);
    const interval = z.union([z.literal(0), z.number().int().min(100).max(5000)]).parse(options.heartbeatIntervalMs ?? 5000);
    // Zero is for an explicitly managed lifecycle loop/tests. Call maintain() within the lease lifetime.
    if (interval) { this.timer = setInterval(() => { void this.maintain().catch(() => undefined); }, interval); this.timer.unref(); }
  }
  private signal(parent?: AbortSignal, entry?: Entry) {
    return AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(this.timeoutMs), ...(parent ? [parent] : []), ...(entry ? [entry.abort.signal] : [])]);
  }
  private async permission(binding: CliBinding, signal: AbortSignal) {
    if (signal.aborted) throw unavailable();
    return revisionSchema.parse(await bounded(Promise.resolve().then(() => this.authorize(cliBindingSchema.parse(binding), signal)), signal)).revision;
  }
  private async guard(entry: Entry, signal: AbortSignal, ready = true) {
    if (entry.stopping || signal.aborted || this.entries.get(entry.binding.connectionId) !== entry) throw unavailable();
    if (await this.permission(entry.binding, signal) !== entry.revision) throw unavailable();
    const pending = ready ? this.leases.assertActive(entry.binding, entry.handle) : this.leases.assertOwned(entry.binding, entry.handle);
    await bounded(pending, signal);
    if (entry.stopping || signal.aborted) throw unavailable();
  }
  private async retireAllocation(allocation: WorkerAllocation): Promise<boolean> {
    if (!this.provisioner) return false;
    // Cleanup must outlive request/shutdown cancellation, but it still has its own deadline.
    const signal = AbortSignal.timeout(this.timeoutMs);
    try {
      const receipt = await bounded(Promise.resolve().then(() => this.provisioner!.fenceAndStop(allocationCopy(allocation), signal)), signal);
      await bounded(this.leases.retire(allocation.binding, allocation.handle, receipt), signal); return true;
    } catch { return false; } // Unknown remains durable; never manufacture a successful receipt.
  }
  private trackCleanup(cleanup: Promise<boolean>): Promise<boolean> {
    this.cleanups.add(cleanup);
    void cleanup.then(() => this.cleanups.delete(cleanup), () => this.cleanups.delete(cleanup));
    return cleanup;
  }
  private release(entry: Entry, reason: WorkerLeaseReason): Promise<boolean> {
    if (entry.cleanup) return entry.cleanup;
    entry.stopping = true; entry.ready = false; entry.abort.abort(); entry.router.close();
    if (this.entries.get(entry.binding.connectionId) === entry) this.entries.delete(entry.binding.connectionId);
    entry.cleanup = (async () => {
      let quarantined = false;
      try { await bounded(this.leases.quarantine(entry.binding, entry.handle, reason), AbortSignal.timeout(this.timeoutMs)); quarantined = true; } catch { /* Still stop the owned physical allocation. */ }
      const retired = await this.retireAllocation(entry); return quarantined && retired;
    })();
    return this.trackCleanup(entry.cleanup);
  }
  private async acquire(binding: CliBinding, id: string, signal: AbortSignal): Promise<Entry> {
    if (!this.provisioner || signal.aborted) throw unavailable();
    const revision = await this.permission(binding, signal);
    const claim = await bounded(this.leases.claim(binding, this.id, id), signal), handle = workerLeaseHandle(claim.lease);
    if (!claim.created) {
      const existing = this.entries.get(binding.connectionId);
      if (!existing?.ready || existing.stopping || !equalHandle(existing.handle, handle)) throw unavailable();
      return existing;
    }
    const entry: Entry = { binding, handle, revision, ready: false, stopping: false, router: new OrganizationWorkerRouter(), abort: new AbortController() };
    this.entries.set(binding.connectionId, entry);
    const ownSignal = this.signal(signal, entry);
    try {
      await this.guard(entry, ownSignal, false);
      const provisioning = Promise.resolve().then(() => {
        if (ownSignal.aborted) throw unavailable();
        return this.provisioner!.provision(allocationCopy(entry), ownSignal);
      });
      // Either outcome can confirm a previously pending infrastructure intent after cancellation.
      // The driver may reject readiness because it was fenced, while still having created/started a resource.
      const reconcile = () => { if (entry.stopping) void this.trackCleanup(this.retireAllocation(entry)); };
      void provisioning.then(reconcile, reconcile);
      const supplied = await bounded(provisioning, ownSignal), receipt = workerReadyReceiptSchema.parse(supplied.receipt);
      const { ready: _, ...receiptHandle } = receipt;
      if (!equalHandle(receiptHandle, handle) || !(supplied.input instanceof Writable) || !(supplied.output instanceof Readable)) throw unavailable();
      await this.guard(entry, ownSignal, false);
      await bounded(entry.router.attach(binding, supplied.input, supplied.output, async () => { await this.release(entry, 'transport_lost'); }, handle), ownSignal);
      await this.guard(entry, ownSignal, false);
      await bounded(this.leases.ready(binding, handle, receipt), ownSignal);
      entry.ready = true;
      await this.guard(entry, ownSignal);
      return entry;
    } catch {
      await this.release(entry, 'provisioning_uncertain'); throw unavailable();
    }
  }
  invoke(input: CliBinding, inputCommand: Parameters<OrganizationWorkerTransport['invoke']>[1], callerSignal: AbortSignal): Promise<WorkerReply> {
    const request = this.invokeOwned(input, inputCommand, callerSignal); this.requests.add(request);
    void request.then(() => this.requests.delete(request), () => this.requests.delete(request));
    return request;
  }
  private async invokeOwned(input: CliBinding, inputCommand: Parameters<OrganizationWorkerTransport['invoke']>[1], callerSignal: AbortSignal): Promise<WorkerReply> {
    const binding = cliBindingSchema.parse(input), command = workerCommandSchema.parse(inputCommand), signal = this.signal(callerSignal);
    if (signal.aborted || !this.provisioner) throw unavailable();
    const entry = command.operation === 'login' ? await this.acquire(binding, command.id, signal) : this.entries.get(binding.connectionId);
    if (!entry || entry.handle.bindingDigest !== bindingDigest(binding)) throw unavailable();
    const ownSignal = this.signal(signal, entry);
    try {
      await this.guard(entry, ownSignal);
      const reply = await bounded(entry.router.invoke(binding, command, ownSignal), ownSignal);
      await this.guard(entry, ownSignal);
      return reply;
    } catch {
      await this.release(entry, 'transport_lost'); throw unavailable();
    }
  }
  /** Heartbeats recheck current membership/configuration; they never provision, log in or dispatch CLI reads. */
  maintain(): Promise<void> {
    if (this.maintenance) return this.maintenance;
    this.maintenance = Promise.all([...this.entries.values()].map(async entry => {
      const signal = this.signal(undefined, entry);
      try {
        await this.guard(entry, signal, entry.ready);
        await bounded(this.leases.renew(entry.binding, entry.handle), signal);
        await this.guard(entry, signal, entry.ready);
      } catch { await this.release(entry, 'revoked'); }
    })).then(() => undefined).finally(() => { this.maintenance = undefined; });
    return this.maintenance;
  }
  /** Trusted lifecycle/admin only, never an HTTP fallback. Explicitly reconcile an abandoned generation. */
  async stop(input: unknown): Promise<void> {
    const binding = cliBindingSchema.parse(input), entry = this.entries.get(binding.connectionId);
    if (entry) {
      if (entry.handle.bindingDigest !== bindingDigest(binding) || !await this.release(entry, 'shutdown')) throw unavailable();
      return;
    }
    const lease = await this.leases.read(binding); if (!lease || lease.state === 'retired') return;
    const handle = workerLeaseHandle(lease);
    await this.leases.quarantine(binding, handle, 'shutdown');
    if (!await this.retireAllocation({ binding, handle })) throw unavailable();
  }
  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer); this.timer = undefined; this.shutdown.abort();
    const closing = [...this.cleanups, ...[...this.entries.values()].map(entry => this.release(entry, 'shutdown'))];
    await Promise.allSettled([...this.requests]);
    const results = await Promise.all([...closing, ...this.cleanups]);
    if (results.some(result => !result)) throw unavailable();
  }
}

/** Company composition: identity/store are supplied by the host; no provider SDK or infrastructure default. */
export function createOrganizationWorkerRuntime(options: { store: CloudStore; access: OrganizationWebAccess; configurations: unknown;
  provisioner?: OrganizationWorkerProvisioner; now?: () => number; lifetimeMs?: number; operationTimeoutMs?: number; heartbeatIntervalMs?: number; observations?: ObservationCache }) {
  const leases = new OrganizationWorkerLeases(options.store, { now: options.now, lifetimeMs: options.lifetimeMs });
  let supervisor: OrganizationWorkerSupervisor;
  // Validate configurations before creating a lifecycle timer. Calls cannot arrive before this factory returns.
  const connections = new OrganizationConnections(options.store, options.access, { invoke: (...args) => supervisor.invoke(...args) }, options.configurations, options.now, options.observations);
  supervisor = new OrganizationWorkerSupervisor({ leases, authorize: binding => connections.workerAuthorization(binding), provisioner: options.provisioner,
    operationTimeoutMs: options.operationTimeoutMs, heartbeatIntervalMs: options.heartbeatIntervalMs });
  return { connections, supervisor, leases };
}
