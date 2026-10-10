import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteCloudStore } from './cloud-sqlite-store';
import type { CloudStore } from './cloud-store';
import { CloudOperationError } from '../src/domain/cloud-workflow';
import { bindingDigest, type CliBinding } from './modules/aws/organization/organization-cli-contract';
import { OrganizationWorkerLeases, workerLeaseHandle, type WorkerLease } from './modules/aws/organization/organization-worker-leases';

const errorCode = (code: string) => (error: unknown) => error instanceof CloudOperationError && error.code === code;
const keyOf = (binding: CliBinding) => `organization-worker-lease:${binding.connectionId}`;
const claimKey = (binding: CliBinding, request: string) => `organization-worker-claim:${binding.connectionId}:${request}`;
const readyReceipt = (lease: WorkerLease) => ({ ...workerLeaseHandle(lease), ready: true });
const retirementReceipt = (lease: WorkerLease) => ({ ...workerLeaseHandle(lease), stopped: true, cacheAccessRevoked: true });
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'cloudops-worker-leases-')), path = join(directory, 'leases.sqlite');
  const first = new SqliteCloudStore(path), second = new SqliteCloudStore(path);
  let now = 1_800_000_000_000;
  const binding: CliBinding = { connectionId: randomUUID(), organizationId: 'synthetic-org', workspaceId: 'workspace-a', actorId: 'employee-a',
    startUrl: 'https://synthetic-example.awsapps.com/start', ssoRegion: 'us-east-1', region: 'ap-northeast-2', accountId: '123456789012', roleName: 'ReadOnlyAccess',
    directory: { awsOrganizationId: 'o-synthetic1', parentId: 'r-demo' } };
  const options = { now: () => now, lifetimeMs: 10_000 };
  const leases = new OrganizationWorkerLeases(first, options), other = new OrganizationWorkerLeases(second, options);
  t.after(async () => { first.close(); second.close(); await rm(directory, { recursive: true, force: true }); });
  const supervisor = randomUUID(), contender = randomUUID();
  const allocate = () => leases.claim(binding, supervisor, randomUUID());
  const activate = async () => { const { lease } = await allocate(); return leases.ready(binding, workerLeaseHandle(lease), readyReceipt(lease)); };
  const write = (key: string, value: unknown) => first.transact(async tx => { await tx.get(key); tx.put(key, value); });
  return { path, first, second, binding, options, leases, other, supervisor, contender, allocate, activate, write,
    now: () => now, advance: (ms: number) => { now += ms; }, setNow: (value: number) => { now = value; } };
}

test('status never allocates; two SQLite owners can commit only one worker claim', async t => {
  const s = await fixture(t);
  assert.equal(await s.leases.read(s.binding), undefined);
  assert.equal(await s.first.transact(tx => tx.get(keyOf(s.binding))), undefined);
  const results = await Promise.allSettled([
    s.leases.claim(s.binding, s.supervisor, randomUUID()), s.other.claim(s.binding, s.contender, randomUUID()),
  ]);
  const won = results.filter(result => result.status === 'fulfilled');
  assert.equal(won.length, 1); assert.equal(won[0].value.created, true);
  const lost = results.find(result => result.status === 'rejected'); assert.ok(lost);
  assert.ok(errorCode('worker_leased_elsewhere')(lost.reason));
  const lease = await s.other.read(s.binding); assert.equal(lease?.generation, 1); assert.equal(lease?.state, 'provisioning');
  await assert.rejects(s.leases.assertActive(s.binding, workerLeaseHandle(lease!)), errorCode('worker_lease_not_ready'));
});

test('same request races and a process reopen never acknowledge a second provisioning dispatch', async t => {
  const s = await fixture(t), request = randomUUID();
  const results = await Promise.all([s.leases.claim(s.binding, s.supervisor, request), s.other.claim(s.binding, s.supervisor, request)]);
  assert.deepEqual(results.map(result => result.created).sort(), [false, true]);
  assert.deepEqual(results[0].lease, results[1].lease);
  const reopened = new SqliteCloudStore(s.path);
  try {
    const restored = new OrganizationWorkerLeases(reopened, s.options);
    assert.equal((await restored.claim(s.binding, s.supervisor, request)).created, false);
    await assert.rejects(restored.claim(s.binding, s.contender, request), errorCode('worker_claim_conflict'));
    await assert.rejects(restored.claim(s.binding, s.supervisor, randomUUID()), errorCode('worker_provisioning'));
  } finally { reopened.close(); }
});

test('every immutable binding field is checked even when connection IDs match', async t => {
  const s = await fixture(t), lease = await s.activate(), handle = workerLeaseHandle(lease);
  const changes: Partial<CliBinding>[] = [
    { actorId: 'employee-b' }, { organizationId: 'other-org' }, { workspaceId: 'other-workspace' }, { accountId: '999999999999' },
    { region: 'us-west-2' }, { ssoRegion: 'us-west-2' }, { roleName: 'AdministratorAccess' }, { startUrl: 'https://other.awsapps.com/start' },
    { directory: { awsOrganizationId: 'o-otherorg12', parentId: 'r-demo' } }, { directory: { awsOrganizationId: 'o-synthetic1', parentId: 'r-other' } }, { directory: undefined },
  ];
  for (const change of changes) {
    const foreign = { ...s.binding, ...change };
    await assert.rejects(s.other.read(foreign), errorCode('worker_binding_mismatch'));
    await assert.rejects(s.other.claim(foreign, s.supervisor, randomUUID()), errorCode('worker_binding_mismatch'));
    await assert.rejects(s.other.renew(foreign, handle), errorCode('worker_binding_mismatch'));
  }
  assert.deepEqual(await s.leases.read(s.binding), lease);
});

test('ready reuse and status checks do not renew a lease; only an explicit heartbeat extends it', async t => {
  const s = await fixture(t), lease = await s.activate(), handle = workerLeaseHandle(lease);
  s.advance(4000);
  const reused = await s.other.claim(s.binding, s.supervisor, randomUUID());
  assert.equal(reused.created, false); assert.equal(reused.lease.expiresAt, lease.expiresAt);
  assert.equal((await s.leases.assertActive(s.binding, handle)).expiresAt, lease.expiresAt);
  assert.equal((await s.leases.read(s.binding))?.expiresAt, lease.expiresAt);
  const renewed = await s.other.renew(s.binding, handle); assert.equal(renewed.expiresAt, s.now() + 10_000);
  s.setNow(lease.expiresAt); assert.equal((await s.leases.assertActive(s.binding, handle)).state, 'ready');
});

test('exact expiry rejects renewal and late ready receipts while preserving quarantine across reopen', async t => {
  const s = await fixture(t), request = randomUUID(), { lease } = await s.leases.claim(s.binding, s.supervisor, request), handle = workerLeaseHandle(lease);
  s.setNow(lease.expiresAt);
  await assert.rejects(s.other.ready(s.binding, handle, readyReceipt(lease)), errorCode('worker_lease_unknown'));
  await assert.rejects(s.leases.renew(s.binding, handle), errorCode('worker_lease_unknown'));
  const reopened = new SqliteCloudStore(s.path);
  try {
    const restored = new OrganizationWorkerLeases(reopened, s.options), value = await restored.read(s.binding);
    assert.equal(value?.state, 'unknown'); assert.equal(value?.lossReason, 'expired');
    assert.equal((await restored.claim(s.binding, s.supervisor, request)).created, false);
    await assert.rejects(restored.claim(s.binding, s.contender, randomUUID()), errorCode('worker_lease_unknown'));
  } finally { reopened.close(); }
});

test('a different supervisor incarnation cannot adopt ready or expired resources after restart', async t => {
  const s = await fixture(t), lease = await s.activate();
  await assert.rejects(s.other.claim(s.binding, s.contender, randomUUID()), errorCode('worker_leased_elsewhere'));
  s.setNow(lease.expiresAt);
  await assert.rejects(s.other.claim(s.binding, s.contender, randomUUID()), errorCode('worker_lease_unknown'));
  assert.equal((await s.leases.read(s.binding))?.lossReason, 'expired');
  assert.equal((await s.leases.read(s.binding))?.generation, 1);
});

test('a clock rollback quarantines active work and catching up never revives the generation', async t => {
  const s = await fixture(t), lease = await s.activate(), handle = workerLeaseHandle(lease);
  s.advance(1000); await s.leases.assertActive(s.binding, handle); s.advance(-1);
  await assert.rejects(s.other.assertActive(s.binding, handle), errorCode('worker_lease_not_ready'));
  const value = await s.leases.read(s.binding); assert.equal(value?.lossReason, 'clock_changed');
  assert.equal(value?.observedAt, lease.createdAt + 1000);
  s.advance(1); await assert.rejects(s.leases.renew(s.binding, handle), errorCode('worker_lease_unknown'));
});

test('a retired generation cannot be replaced while the trusted clock is behind its last observation', async t => {
  const s = await fixture(t), lease = await s.activate(), handle = workerLeaseHandle(lease);
  s.advance(1000); await s.leases.quarantine(s.binding, handle, 'shutdown');
  await s.leases.retire(s.binding, handle, retirementReceipt(lease)); s.advance(-1);
  await assert.rejects(s.other.claim(s.binding, s.contender, randomUUID()), errorCode('worker_clock_invalid'));
  assert.equal((await s.leases.read(s.binding))?.generation, 1);
  s.advance(1); assert.equal((await s.other.claim(s.binding, s.contender, randomUUID())).lease.generation, 2);
});

test('ready receipts must attest the complete allocation identity and never resurrect uncertain provisioning', async t => {
  const s = await fixture(t);
  const changes = [{ ready: false }, { generation: 2 }, { supervisorId: randomUUID() }, { connectionId: randomUUID() },
    { bindingDigest: 'a'.repeat(64) }, { resourceKey: `worker-${randomUUID()}` }, { cacheKey: `cache-${randomUUID()}` }, { token: 'synthetic-private-token' }];
  for (const change of changes) {
    const binding = { ...s.binding, connectionId: randomUUID() }, { lease } = await s.leases.claim(binding, s.supervisor, randomUUID()), handle = workerLeaseHandle(lease);
    await assert.rejects(s.other.ready(binding, handle, { ...readyReceipt(lease), ...change }), errorCode('worker_receipt_mismatch'));
    assert.equal((await s.leases.read(binding))?.lossReason, 'provisioning_uncertain');
    await assert.rejects(s.leases.ready(binding, handle, readyReceipt(lease)), errorCode('worker_lease_unknown'));
  }
});

test('retirement requires quarantine plus generation-matched stop and cache-revocation receipts', async t => {
  const s = await fixture(t), lease = await s.activate(), handle = workerLeaseHandle(lease), receipt = retirementReceipt(lease);
  await assert.rejects(s.leases.retire(s.binding, handle, receipt), errorCode('worker_retirement_not_requested'));
  await s.leases.quarantine(s.binding, handle, 'revoked');
  for (const invalid of [{ ...receipt, stopped: false }, { ...receipt, cacheAccessRevoked: false }, { ...receipt, generation: 2 },
    { ...receipt, supervisorId: s.contender }, { ...receipt, cacheKey: `cache-${randomUUID()}` }, { ...receipt, extra: true }]) {
    await assert.rejects(s.other.retire(s.binding, handle, invalid), errorCode('worker_retirement_unconfirmed'));
    assert.equal((await s.leases.read(s.binding))?.state, 'unknown');
  }
  const retired = await s.leases.retire(s.binding, handle, receipt); assert.equal(retired.state, 'retired'); assert.equal(retired.lossReason, 'revoked');
  assert.deepEqual(await s.other.retire(s.binding, handle, receipt), retired);
});

test('confirmed retirement issues fresh resource/cache keys and fences every old-generation mutation', async t => {
  const s = await fixture(t), request = randomUUID(), { lease } = await s.leases.claim(s.binding, s.supervisor, request), handle = workerLeaseHandle(lease);
  await s.leases.ready(s.binding, handle, readyReceipt(lease));
  await s.leases.quarantine(s.binding, handle, 'shutdown'); await s.leases.retire(s.binding, handle, retirementReceipt(lease));
  const replay = await s.other.claim(s.binding, s.supervisor, request); assert.equal(replay.created, false); assert.equal(replay.lease.state, 'retired');
  const next = await s.other.claim(s.binding, s.contender, randomUUID()); assert.equal(next.created, true); assert.equal(next.lease.generation, 2);
  assert.notEqual(next.lease.leaseId, lease.leaseId); assert.notEqual(next.lease.resourceKey, lease.resourceKey); assert.notEqual(next.lease.cacheKey, lease.cacheKey);
  for (const stale of [() => s.leases.renew(s.binding, handle), () => s.leases.assertActive(s.binding, handle),
    () => s.leases.ready(s.binding, handle, readyReceipt(lease)), () => s.leases.quarantine(s.binding, handle, 'transport_lost'),
    () => s.leases.retire(s.binding, handle, retirementReceipt(lease))]) await assert.rejects(stale, errorCode('worker_lease_fenced'));
  await assert.rejects(s.leases.claim(s.binding, s.supervisor, request), errorCode('worker_claim_superseded'));
  assert.deepEqual(await s.leases.read(s.binding), next.lease);
});

test('two contenders after retirement still create only one new generation', async t => {
  const s = await fixture(t), lease = await s.activate(), handle = workerLeaseHandle(lease);
  await s.leases.quarantine(s.binding, handle, 'shutdown'); await s.leases.retire(s.binding, handle, retirementReceipt(lease));
  const results = await Promise.allSettled([s.leases.claim(s.binding, s.supervisor, randomUUID()), s.other.claim(s.binding, s.contender, randomUUID())]);
  assert.equal(results.filter(value => value.status === 'fulfilled').length, 1);
  assert.equal((await s.leases.read(s.binding))?.generation, 2);
});

test('one user losing a lease does not stop, renew or recycle another user cache', async t => {
  const s = await fixture(t), a = await s.activate(), bBinding = { ...s.binding, connectionId: randomUUID(), actorId: 'employee-b' };
  const { lease: pending } = await s.other.claim(bBinding, s.contender, randomUUID());
  const b = await s.other.ready(bBinding, workerLeaseHandle(pending), readyReceipt(pending));
  assert.notEqual(a.resourceKey, b.resourceKey); assert.notEqual(a.cacheKey, b.cacheKey);
  await s.leases.quarantine(s.binding, workerLeaseHandle(a), 'revoked');
  await s.leases.retire(s.binding, workerLeaseHandle(a), retirementReceipt(a));
  assert.deepEqual(await s.other.assertActive(bBinding, workerLeaseHandle(b)), b);
  await assert.rejects(s.leases.quarantine(bBinding, workerLeaseHandle(a), 'revoked'), errorCode('worker_binding_mismatch'));
});

test('a held synthetic operation cannot publish a late result after its post-call lease check fails', async t => {
  const s = await fixture(t), lease = await s.activate(), handle = workerLeaseHandle(lease);
  let resolve!: (value: string) => void; const external = new Promise<string>(done => { resolve = done; });
  await s.leases.assertActive(s.binding, handle);
  const result = external.then(async value => { await s.leases.assertActive(s.binding, handle); return value; });
  const rejected = assert.rejects(result, errorCode('worker_lease_not_ready'));
  s.setNow(lease.expiresAt); assert.equal((await s.other.read(s.binding))?.state, 'unknown');
  resolve('synthetic-result'); await rejected;
});

test('transaction callback retries do not change the resource identity or acknowledge rolled-back allocation', async t => {
  const s = await fixture(t), discarded: WorkerLease[] = [], sentinel = new Error('synthetic transaction retry');
  const retrying: CloudStore = { async transact(body) {
    try { await s.first.transact(async tx => { await body({ get: tx.get, put(key, value) { if (key === keyOf(s.binding)) discarded.push(structuredClone(value) as WorkerLease); tx.put(key, value); } }); throw sentinel; }); }
    catch (error) { if (error !== sentinel) throw error; }
    assert.equal(await s.second.transact(tx => tx.get(keyOf(s.binding))), undefined);
    return s.first.transact(body);
  } };
  const request = randomUUID(), leases = new OrganizationWorkerLeases(retrying, s.options), value = await leases.claim(s.binding, s.supervisor, request);
  assert.equal(value.created, true); assert.equal(discarded.length, 1); assert.deepEqual(value.lease, discarded[0]);
  assert.equal((await s.other.claim(s.binding, s.supervisor, request)).created, false);
});

test('failed atomic commit leaves neither an acknowledged allocation nor a claim ledger', async t => {
  const s = await fixture(t), sentinel = new Error('synthetic commit failure'), request = randomUUID();
  const failing: CloudStore = { transact: body => s.first.transact(async tx => { await body(tx); throw sentinel; }) };
  await assert.rejects(new OrganizationWorkerLeases(failing, s.options).claim(s.binding, s.supervisor, request), error => error === sentinel);
  assert.equal(await s.leases.read(s.binding), undefined);
  assert.equal(await s.first.transact(tx => tx.get(claimKey(s.binding, request))), undefined);
  assert.equal((await s.other.claim(s.binding, s.supervisor, request)).created, true);
});

test('corrupted lease state and inconsistent persisted claim ownership fail closed', async t => {
  const s = await fixture(t), { lease } = await s.allocate();
  await s.write(keyOf(s.binding), { ...lease, state: 'retired' });
  await assert.rejects(s.other.read(s.binding), errorCode('invalid_worker_lease'));
  await s.write(keyOf(s.binding), lease);
  const request = randomUUID();
  // The ledger says supervisor B while its embedded allocation still belongs to A.
  await s.write(claimKey(s.binding, request), { bindingDigest: bindingDigest(s.binding), supervisorId: s.contender, handle: workerLeaseHandle(lease) });
  await assert.rejects(s.other.claim(s.binding, s.contender, request), errorCode('invalid_worker_claim'));
  await s.write(claimKey(s.binding, request), { bindingDigest: 'a'.repeat(64), supervisorId: s.supervisor, handle: workerLeaseHandle(lease) });
  await assert.rejects(s.other.claim(s.binding, s.supervisor, request), errorCode('invalid_worker_claim'));
});

test('generation overflow and invalid clocks cannot silently wrap or create resource references', async t => {
  const s = await fixture(t), lease = await s.activate(), handle = workerLeaseHandle(lease);
  await s.leases.quarantine(s.binding, handle, 'shutdown');
  const retired = await s.leases.retire(s.binding, handle, retirementReceipt(lease));
  await s.write(keyOf(s.binding), { ...retired, generation: Number.MAX_SAFE_INTEGER });
  await assert.rejects(s.other.claim(s.binding, s.contender, randomUUID()), errorCode('worker_generation_exhausted'));
  for (const value of [NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER - 9999]) {
    s.setNow(value); await assert.rejects(s.other.claim({ ...s.binding, connectionId: randomUUID() }, s.contender, randomUUID()), errorCode('worker_clock_invalid'));
  }
  for (const lifetimeMs of [9999, 300001, Infinity, 10_000.5]) assert.throws(() => new OrganizationWorkerLeases(s.first, { lifetimeMs }));
});
