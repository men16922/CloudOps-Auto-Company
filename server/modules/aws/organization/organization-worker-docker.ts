import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { CloudStore, CloudTransaction } from '../../../cloud-store';
import type { OrganizationWorkerProvisioner, WorkerAllocation, ProvisionedOrganizationWorker } from './organization-worker-supervisor';
import { OrganizationWorkerLeases, workerLeaseHandleSchema, type WorkerRetirementReceipt } from './organization-worker-leases';
import { checkedAllocation, dockerConfigDigest, dockerContainerIdSchema, dockerWorkerConfigSchema, dockerWorkerFailure,
  type DockerWorkerEngine, type DockerWorkerConfig, type DockerWorkerPipe } from './organization-worker-docker-contract';

const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const step = z.object({ id: z.uuid(), state: z.enum(['pending', 'confirmed', 'unknown']), startedAt: time, finishedAt: time.optional() }).strict()
  .refine(value => (value.state === 'pending') === (value.finishedAt === undefined) && (value.finishedAt === undefined || value.finishedAt >= value.startedAt));
const recordSchema = z.object({ schemaVersion: z.literal(1), handle: workerLeaseHandleSchema, configDigest: z.string().regex(/^[a-f0-9]{64}$/),
  fenced: z.boolean(), retired: z.boolean(), create: step.optional(), start: step.optional(), remove: step.optional(), containerId: dockerContainerIdSchema.optional(),
}).strict().superRefine((value, ctx) => {
  if (Boolean(value.containerId) !== (value.create?.state === 'confirmed') || value.start && !value.containerId
    || value.retired && (!value.fenced || value.create && value.create.state !== 'confirmed' || value.start && value.start.state !== 'confirmed')) {
    ctx.addIssue({ code: 'custom', message: 'Invalid infrastructure lifecycle.' });
  }
});
type RecordValue = z.infer<typeof recordSchema>;
type Phase = 'create' | 'start' | 'remove';
const keyOf = (allocation: WorkerAllocation) => `organization-worker-docker:${allocation.handle.leaseId}`;

/** Durable local-container driver. Infrastructure is injected; transaction callbacks never call Docker or the filesystem. */
export class DockerOrganizationWorkerProvisioner implements OrganizationWorkerProvisioner {
  private readonly store: CloudStore;
  private readonly leases: OrganizationWorkerLeases;
  private readonly engine: DockerWorkerEngine;
  private readonly config: DockerWorkerConfig;
  private readonly now: () => number;
  private readonly pipes = new Map<string, DockerWorkerPipe>();
  constructor(options: { store: CloudStore; leases: OrganizationWorkerLeases; config: unknown; engine: DockerWorkerEngine; now?: () => number }) {
    this.store = options.store; this.leases = options.leases; this.config = dockerWorkerConfigSchema.parse(options.config); this.engine = options.engine;
    this.now = options.now ?? Date.now;
  }
  private empty(allocation: WorkerAllocation): RecordValue {
    return { schemaVersion: 1, handle: allocation.handle, configDigest: dockerConfigDigest(this.config), fenced: false, retired: false };
  }
  private async read(tx: CloudTransaction, allocation: WorkerAllocation) {
    const raw = await tx.get(keyOf(allocation)); if (raw === undefined) return undefined;
    const parsed = recordSchema.safeParse(raw);
    if (!parsed.success || JSON.stringify(parsed.data.handle) !== JSON.stringify(allocation.handle) || parsed.data.configDigest !== dockerConfigDigest(this.config)) throw dockerWorkerFailure();
    return parsed.data;
  }
  private check(signal: AbortSignal) { if (signal.aborted) throw dockerWorkerFailure(); }
  private async guard(allocation: WorkerAllocation, signal: AbortSignal) {
    this.check(signal); await this.leases.assertOwned(allocation.binding, allocation.handle);
    await this.store.transact(async tx => { const value = await this.read(tx, allocation); if (!value || value.fenced || value.retired) throw dockerWorkerFailure(); });
    this.check(signal);
  }
  private async begin(allocation: WorkerAllocation, phase: Phase): Promise<string> {
    const id = randomUUID();
    await this.store.transact(async tx => {
      const value = await this.read(tx, allocation); if (!value || value.retired || phase !== 'remove' && value.fenced) throw dockerWorkerFailure();
      if (phase !== 'remove' && value[phase] || phase === 'remove' && value.remove?.state === 'pending') throw dockerWorkerFailure();
      if (phase === 'start' && (value.create?.state !== 'confirmed' || !value.containerId)) throw dockerWorkerFailure();
      tx.put(keyOf(allocation), recordSchema.parse({ ...value, [phase]: { id, state: 'pending', startedAt: time.parse(this.now()) } }));
    });
    return id;
  }
  private async finish(allocation: WorkerAllocation, phase: Phase, id: string, state: 'confirmed' | 'unknown', containerId?: string) {
    await this.store.transact(async tx => {
      const value = await this.read(tx, allocation); if (!value || value[phase]?.id !== id || value[phase]?.state !== 'pending') throw dockerWorkerFailure();
      tx.put(keyOf(allocation), recordSchema.parse({ ...value, [phase]: { ...value[phase], state, finishedAt: Math.max(value[phase]!.startedAt, time.parse(this.now())) }, ...(containerId ? { containerId } : {}) }));
    });
  }
  private async mutation<T>(allocation: WorkerAllocation, phase: Phase, run: () => Promise<T>, idOf?: (value: T) => string) {
    const id = await this.begin(allocation, phase);
    try { const value = await run(); await this.finish(allocation, phase, id, 'confirmed', idOf?.(value)); return value; }
    catch { await this.finish(allocation, phase, id, 'unknown').catch(() => undefined); throw dockerWorkerFailure(); }
  }
  async provision(input: WorkerAllocation, signal: AbortSignal): Promise<ProvisionedOrganizationWorker> {
    const allocation = checkedAllocation(input); this.check(signal); await this.leases.assertOwned(allocation.binding, allocation.handle);
    await this.store.transact(async tx => {
      if (await this.read(tx, allocation)) throw dockerWorkerFailure();
      tx.put(keyOf(allocation), this.empty(allocation));
    });
    await this.engine.prepare(checkedAllocation(allocation), signal); await this.guard(allocation, signal);
    const containerId = await this.mutation(allocation, 'create', async () => dockerContainerIdSchema.parse(await this.engine.create(checkedAllocation(allocation), signal)), value => value);
    await this.guard(allocation, signal);
    if (await this.engine.inspect(containerId, checkedAllocation(allocation), signal) !== 'created') throw dockerWorkerFailure();
    await this.guard(allocation, signal);
    await this.mutation(allocation, 'start', () => this.engine.start(containerId, signal));
    await this.guard(allocation, signal);
    if (await this.engine.inspect(containerId, checkedAllocation(allocation), signal) !== 'running') throw dockerWorkerFailure();
    await this.guard(allocation, signal);
    const pipe = await this.engine.attach(containerId, signal);
    try {
      await this.guard(allocation, signal); this.pipes.set(allocation.handle.leaseId, pipe);
      return { input: pipe.input, output: pipe.output, receipt: { ...allocation.handle, ready: true } };
    } catch { await pipe.close(); throw dockerWorkerFailure(); }
  }
  async fenceAndStop(input: WorkerAllocation, signal: AbortSignal): Promise<WorkerRetirementReceipt> {
    const allocation = checkedAllocation(input); this.check(signal);
    const snapshot = await this.store.transact(async tx => {
      const value = await this.read(tx, allocation) ?? this.empty(allocation), next = { ...value, fenced: true };
      tx.put(keyOf(allocation), next); return next;
    });
    const pipe = this.pipes.get(allocation.handle.leaseId); let pipeClosed = true;
    try { await pipe?.close(); this.pipes.delete(allocation.handle.leaseId); }
    catch { pipeClosed = false; } // Still attempt removal of the known container; retain the local pipe for explicit cleanup.
    if (!snapshot.retired) {
      // Even an absent container is insufficient when an earlier create/start might still reach the daemon.
      if (snapshot.containerId) {
        this.check(signal);
        const state = await this.engine.inspect(snapshot.containerId, checkedAllocation(allocation), signal);
        if (state !== 'absent') await this.mutation(allocation, 'remove', () => this.engine.remove(snapshot.containerId!, signal));
        if (await this.engine.inspect(snapshot.containerId, checkedAllocation(allocation), signal) !== 'absent') throw dockerWorkerFailure();
      }
      if (!pipeClosed || snapshot.create && snapshot.create.state !== 'confirmed' || snapshot.start && snapshot.start.state !== 'confirmed') throw dockerWorkerFailure();
      await this.store.transact(async tx => {
        const value = await this.read(tx, allocation);
        if (!value?.fenced || value.create && value.create.state !== 'confirmed' || value.start && value.start.state !== 'confirmed' || value.remove?.state === 'pending') throw dockerWorkerFailure();
        tx.put(keyOf(allocation), recordSchema.parse({ ...value, retired: true }));
      });
    }
    if (!pipeClosed) throw dockerWorkerFailure();
    this.check(signal); return { ...allocation.handle, stopped: true, cacheAccessRevoked: true };
  }
}
