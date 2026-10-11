import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { CloudStore } from '../storage/store';
import { CloudOperationError } from '../../../../packages/contracts/errors';
import { bindingDigest, cliBindingSchema, type CliBinding } from '../../../../packages/worker-protocol/cli-contract';
import { leaseIdentity, workerLeaseHandleSchema, type WorkerLeaseHandle } from '../../../../packages/worker-protocol/lease-handle';

const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const workerLeaseReasonSchema = z.enum(['expired', 'clock_changed', 'provisioning_uncertain', 'transport_lost', 'shutdown', 'revoked']);
const workerLeaseSchema = z.object({
  schemaVersion: z.literal(1), ...leaseIdentity, state: z.enum(['provisioning', 'ready', 'unknown', 'retired']),
  createdAt: time, observedAt: time, expiresAt: time, lossReason: workerLeaseReasonSchema.optional(), retiredAt: time.optional(),
}).strict().superRefine((value, ctx) => {
  if (!workerLeaseHandleSchema.safeParse(handleOf(value)).success || value.observedAt < value.createdAt || value.expiresAt <= value.createdAt
    || (value.state === 'unknown' || value.state === 'retired') !== Boolean(value.lossReason)
    || (value.state === 'retired') !== (value.retiredAt !== undefined)
    || value.retiredAt !== undefined && (value.retiredAt < value.createdAt || value.retiredAt > value.observedAt)) ctx.addIssue({ code: 'custom', message: 'Invalid worker lease lifecycle.' });
});
export type WorkerLease = z.infer<typeof workerLeaseSchema>;
export type WorkerLeaseReason = z.infer<typeof workerLeaseReasonSchema>;
/** Trusted provisioner receipts only. Never deserialize these from a browser or worker reply. */
export const workerReadyReceiptSchema = z.object({ ...leaseIdentity, ready: z.literal(true) }).strict();
const workerRetirementReceiptSchema = z.object({ ...leaseIdentity, stopped: z.literal(true), cacheAccessRevoked: z.literal(true) }).strict();
export type WorkerReadyReceipt = z.infer<typeof workerReadyReceiptSchema>;
export type WorkerRetirementReceipt = z.infer<typeof workerRetirementReceiptSchema>;
const claimSchema = z.object({ bindingDigest: z.string().regex(/^[a-f0-9]{64}$/), supervisorId: z.uuid(), handle: workerLeaseHandleSchema }).strict()
  .refine(value => value.bindingDigest === value.handle.bindingDigest && value.supervisorId === value.handle.supervisorId);
const keyOf = (binding: CliBinding) => `organization-worker-lease:${binding.connectionId}`;
const failure = (code: string, status = 409) => new CloudOperationError(status, code, 'The isolated worker lease could not be confirmed.');
function handleOf(value: WorkerLeaseHandle): WorkerLeaseHandle {
  return { connectionId: value.connectionId, bindingDigest: value.bindingDigest, supervisorId: value.supervisorId, generation: value.generation,
    leaseId: value.leaseId, resourceKey: value.resourceKey, cacheKey: value.cacheKey };
}
export function workerLeaseHandle(value: WorkerLease): WorkerLeaseHandle { return workerLeaseHandleSchema.parse(handleOf(workerLeaseSchema.parse(value))); }
const same = (left: WorkerLeaseHandle, right: WorkerLeaseHandle) => JSON.stringify(handleOf(left)) === JSON.stringify(handleOf(right));
type Outcome<T> = { value: T; error?: never } | { error: string; value?: never };
function unwrap<T>(result: Outcome<T>): T { if (result.error) throw failure(result.error); return result.value as T; }

/** Durable allocation control only. This class cannot launch a CLI/process, route a command or prove OS/cache isolation. */
export class OrganizationWorkerLeases {
  private readonly store: CloudStore;
  private readonly now: () => number;
  private readonly lifetime: number;
  constructor(store: CloudStore, options: { now?: () => number; lifetimeMs?: number } = {}) {
    this.store = store; this.now = options.now ?? Date.now; this.lifetime = z.number().int().min(10_000).max(300_000).parse(options.lifetimeMs ?? 60_000);
  }
  private clock() {
    const value = time.safeParse(this.now());
    if (!value.success || value.data > Number.MAX_SAFE_INTEGER - this.lifetime) throw failure('worker_clock_invalid');
    return value.data;
  }
  private stored(raw: unknown, binding: CliBinding): WorkerLease | undefined {
    if (raw === undefined) return undefined;
    const parsed = workerLeaseSchema.safeParse(raw);
    if (!parsed.success) throw failure('invalid_worker_lease', 500);
    if (parsed.data.connectionId !== binding.connectionId || parsed.data.bindingDigest !== bindingDigest(binding)) throw failure('worker_binding_mismatch', 403);
    return parsed.data;
  }
  private observe(lease: WorkerLease, now: number): WorkerLease {
    const active = lease.state === 'ready' || lease.state === 'provisioning';
    const reason = active && (now < lease.observedAt ? 'clock_changed' : now >= lease.expiresAt ? 'expired' : undefined);
    return workerLeaseSchema.parse({ ...lease, observedAt: Math.max(now, lease.observedAt), ...(reason ? { state: 'unknown', lossReason: reason } : {}) });
  }
  /** A status read can quarantine an expired lease, but never allocate, renew or replace it. */
  async read(input: unknown): Promise<WorkerLease | undefined> {
    const binding = cliBindingSchema.parse(input), key = keyOf(binding);
    return this.store.transact(async tx => {
      const lease = this.stored(await tx.get(key), binding); if (!lease) return undefined;
      const next = this.observe(lease, this.clock());
      if (JSON.stringify(next) !== JSON.stringify(lease)) tx.put(key, next);
      return next;
    });
  }
  /** Only an explicit login/provision request may call claim. Replays always return created:false. */
  async claim(input: unknown, supervisorId: string, requestId: string): Promise<{ lease: WorkerLease; created: boolean }> {
    const binding = cliBindingSchema.parse(input); z.uuid().parse(supervisorId); z.uuid().parse(requestId);
    const key = keyOf(binding), requestKey = `organization-worker-claim:${binding.connectionId}:${requestId}`, digest = bindingDigest(binding), nonce = randomUUID();
    const result = await this.store.transact<Outcome<{ lease: WorkerLease; created: boolean }>>(async tx => {
      const raw = await tx.get(key), request = await tx.get(requestKey);
      const stored = this.stored(raw, binding), now = this.clock(), lease = stored ? this.observe(stored, now) : undefined;
      const finish = (value: Outcome<{ lease: WorkerLease; created: boolean }>) => {
        if (lease && JSON.stringify(lease) !== JSON.stringify(stored)) tx.put(key, lease);
        return value;
      };
      if (request !== undefined) {
        const replay = claimSchema.safeParse(request);
        if (!replay.success) return finish({ error: 'invalid_worker_claim' });
        if (replay.data.bindingDigest !== digest || replay.data.supervisorId !== supervisorId) return finish({ error: 'worker_claim_conflict' });
        if (!lease || !same(replay.data.handle, lease)) return finish({ error: 'worker_claim_superseded' });
        return finish({ value: { lease, created: false } });
      }
      if (lease && lease.state !== 'retired') {
        if (lease.state === 'unknown') return finish({ error: 'worker_lease_unknown' });
        if (lease.supervisorId !== supervisorId) return finish({ error: 'worker_leased_elsewhere' });
        if (lease.state === 'provisioning') return finish({ error: 'worker_provisioning' });
        // A new login on this process's ready worker reuses the worker, never its provisioning command.
        tx.put(key, lease); tx.put(requestKey, { bindingDigest: digest, supervisorId, handle: handleOf(lease) });
        return { value: { lease, created: false } };
      }
      // A retirement attestation does not make a regressed wall clock trustworthy for a new generation.
      if (lease && now < lease.observedAt) return finish({ error: 'worker_clock_invalid' });
      if (lease?.generation === Number.MAX_SAFE_INTEGER) return finish({ error: 'worker_generation_exhausted' });
      const next = workerLeaseSchema.parse({ schemaVersion: 1, connectionId: binding.connectionId, bindingDigest: digest, supervisorId,
        generation: (lease?.generation ?? 0) + 1, leaseId: nonce, resourceKey: `worker-${nonce}`, cacheKey: `cache-${nonce}`,
        state: 'provisioning', createdAt: now, observedAt: now, expiresAt: now + this.lifetime });
      // Resource creation happens after this commit, only when created=true. No external work in this callback.
      tx.put(key, next); tx.put(requestKey, { bindingDigest: digest, supervisorId, handle: handleOf(next) });
      return { value: { lease: next, created: true } };
    });
    return unwrap(result);
  }
  private async change(input: unknown, inputHandle: unknown, transition: (lease: WorkerLease, now: number) => { lease: WorkerLease; error?: string }) {
    const binding = cliBindingSchema.parse(input), handle = workerLeaseHandleSchema.parse(inputHandle), key = keyOf(binding);
    if (handle.connectionId !== binding.connectionId || handle.bindingDigest !== bindingDigest(binding)) throw failure('worker_binding_mismatch', 403);
    const result = await this.store.transact<Outcome<WorkerLease>>(async tx => {
      const prior = this.stored(await tx.get(key), binding);
      if (!prior || !same(prior, handle)) return { error: 'worker_lease_fenced' };
      const now = this.clock(), observed = this.observe(prior, now), changed = transition(observed, now), next = workerLeaseSchema.parse(changed.lease);
      if (JSON.stringify(next) !== JSON.stringify(prior)) tx.put(key, next);
      return changed.error ? { error: changed.error } : { value: next };
    });
    // Errors are raised after commit so expiry/quarantine is durable even when a caller is rejected.
    return unwrap(result);
  }
  async assertActive(binding: unknown, handle: unknown): Promise<WorkerLease> {
    return this.change(binding, handle, lease => ({ lease, ...(lease.state !== 'ready' ? { error: 'worker_lease_not_ready' } : {}) }));
  }
  async assertOwned(binding: unknown, handle: unknown): Promise<WorkerLease> {
    return this.change(binding, handle, lease => ({ lease, ...(!['provisioning', 'ready'].includes(lease.state) ? { error: 'worker_lease_unknown' } : {}) }));
  }
  async renew(binding: unknown, handle: unknown): Promise<WorkerLease> {
    return this.change(binding, handle, (lease, now) => lease.state === 'ready' || lease.state === 'provisioning'
      ? { lease: { ...lease, expiresAt: now + this.lifetime } } : { lease, error: 'worker_lease_unknown' });
  }
  async ready(binding: unknown, handle: unknown, inputReceipt: unknown): Promise<WorkerLease> {
    return this.change(binding, handle, lease => {
      if (lease.state !== 'provisioning' && lease.state !== 'ready') return { lease, error: 'worker_lease_unknown' };
      const receipt = workerReadyReceiptSchema.safeParse(inputReceipt);
      if (!receipt.success || !same(receipt.data, lease)) return { lease: { ...lease, state: 'unknown', lossReason: 'provisioning_uncertain' }, error: 'worker_receipt_mismatch' };
      return { lease: { ...lease, state: 'ready' } };
    });
  }
  async quarantine(binding: unknown, handle: unknown, reason: WorkerLeaseReason): Promise<WorkerLease> {
    workerLeaseReasonSchema.parse(reason);
    return this.change(binding, handle, lease => ({ lease: lease.state === 'provisioning' || lease.state === 'ready' ? { ...lease, state: 'unknown', lossReason: reason } : lease }));
  }
  /** A private provisioner must verify both termination and cache-access revocation before supplying this receipt. */
  async retire(binding: unknown, handle: unknown, inputReceipt: unknown): Promise<WorkerLease> {
    return this.change(binding, handle, (lease, now) => {
      const receipt = workerRetirementReceiptSchema.safeParse(inputReceipt);
      if (!receipt.success || !same(receipt.data, lease)) return { lease, error: 'worker_retirement_unconfirmed' };
      if (lease.state === 'retired') return { lease };
      if (lease.state !== 'unknown') return { lease, error: 'worker_retirement_not_requested' };
      return { lease: { ...lease, state: 'retired', retiredAt: Math.max(now, lease.observedAt) } };
    });
  }
}
