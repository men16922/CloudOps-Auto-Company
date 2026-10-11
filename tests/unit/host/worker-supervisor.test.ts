import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { SqliteCloudStore } from '../../../apps/host/src/storage/sqlite-store';
import { OrganizationWebAccess } from '../../../apps/host/src/identity/web-access';
import { CloudOperationError } from '../../../packages/contracts/errors';
import { bindingDigest, type CliBinding, type CliOperation } from '../../../packages/worker-protocol/cli-contract';
import { OrganizationCliWorker } from '../../../apps/worker/src/cli-worker';
import { serveCliWorker } from '../../../apps/worker/src/serve';
import { OrganizationConnections } from '../../../apps/host/src/connections/connections';
import type { WorkerLeaseHandle } from '../../../packages/worker-protocol/lease-handle';
import { createOrganizationWorkerRuntime, type OrganizationWorkerProvisioner, type WorkerAllocation, type ProvisionedOrganizationWorker } from '../../../apps/host/src/workers/supervisor';
import { createOrganizationApiServer } from '../../../apps/host/src';

const config = { configurationId: 'aws-read', label: 'Synthetic AWS', organizationId: 'synthetic-org', workspaceId: 'workspace-a',
  startUrl: 'https://synthetic-example.awsapps.com/start', ssoRegion: 'us-east-1', region: 'ap-northeast-2', accountId: '123456789012', roleName: 'ReadOnlyAccess' };
const failed = (error: unknown) => error instanceof CloudOperationError;
function deferred<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

async function fixture(t: TestContext, enabled = true) {
  const directory = await mkdtemp(join(tmpdir(), 'cloudops-supervisor-')), path = join(directory, 'cloud.sqlite');
  const first = new SqliteCloudStore(path), second = new SqliteCloudStore(path);
  let now = 1_800_000_000_000;
  const access = new OrganizationWebAccess({ verify: async token => ({ actorId: token, expiresAt: now + 3600_000 }) }, first, () => now);
  const membership = (actorId: string, active = true, version = 1) => access.provision({ organizationId: config.organizationId, workspaceId: config.workspaceId, actorId, active, version, roles: ['viewer'], updatedAt: new Date(now).toISOString() });
  await membership('actor-a'); await membership('actor-b');
  const provisions: WorkerAllocation[] = [], stops: WorkerAllocation[] = [], calls: { actor: string; operation: CliOperation }[] = [];
  const fenced = new Set<string>();
  const pipes = new Map<string, { output: PassThrough; stop(): Promise<void> }>();
  const hooks: { beforeProvision?: (allocation: WorkerAllocation) => Promise<void>;
    afterProvision?: (value: ProvisionedOrganizationWorker) => Promise<ProvisionedOrganizationWorker>;
    run?: (binding: CliBinding, operation: CliOperation, signal: AbortSignal) => Promise<void>;
    stamp?: (value: WorkerLeaseHandle) => WorkerLeaseHandle | undefined; beforeStop?: () => Promise<void>; stopFails?: boolean; badStopReceipt?: boolean } = {};
  const provisioner: OrganizationWorkerProvisioner = {
    async provision(allocation) {
      assert.deepEqual(Object.keys(allocation).sort(), ['binding', 'handle']); provisions.push(structuredClone(allocation));
      await hooks.beforeProvision?.(allocation);
      if (fenced.has(allocation.handle.leaseId)) throw new Error('synthetic fenced creation');
      const { binding, handle } = allocation, input = new PassThrough(), output = new PassThrough();
      const worker = new OrganizationCliWorker(binding, { async run(operation, signal, write) {
        calls.push({ actor: binding.actorId, operation }); await hooks.run?.(binding, operation, signal);
        if (operation === 'login') { write?.('https://device.sso.us-east-1.amazonaws.com/\nThen enter the code:\nDEMO-CODE\n'); return { stdout: '' }; }
        if (operation === 'identity') return { stdout: JSON.stringify({ Account: binding.accountId, Arn: `arn:aws:sts::${binding.accountId}:assumed-role/AWSReservedSSO_${binding.roleName}_0123456789abcdef/synthetic-session`, UserId: `SYNTHETIC:${binding.actorId}` }) };
        if (operation === 'logout') return { stdout: '' };
        return { stdout: JSON.stringify({ Items: [{ name: 'synthetic-resource' }], HasMore: false }) };
      } }, () => now);
      const serving = serveCliWorker(worker, input, output, hooks.stamp ? hooks.stamp(handle) : handle);
      pipes.set(handle.leaseId, { output, async stop() { input.end(); await serving; output.destroy(); } });
      const value = { input, output, receipt: { ...handle, ready: true as const } };
      return hooks.afterProvision ? hooks.afterProvision(value) : value;
    },
    async fenceAndStop(allocation) {
      assert.deepEqual(Object.keys(allocation).sort(), ['binding', 'handle']); stops.push(structuredClone(allocation));
      if (hooks.stopFails) throw new Error('private synthetic infrastructure token');
      await hooks.beforeStop?.();
      fenced.add(allocation.handle.leaseId); await pipes.get(allocation.handle.leaseId)?.stop();
      if (hooks.badStopReceipt) return { ...allocation.handle, stopped: true, cacheAccessRevoked: false } as never;
      return { ...allocation.handle, stopped: true, cacheAccessRevoked: true };
    },
  };
  const options = { access, configurations: [config], now: () => now, lifetimeMs: 10_000, provisioner: enabled ? provisioner : undefined, heartbeatIntervalMs: 0, operationTimeoutMs: 500 };
  const { connections, supervisor, leases, runbooks } = createOrganizationWorkerRuntime({ ...options, store: first });
  const { connections: otherConnections, supervisor: other, leases: otherLeases } = createOrganizationWorkerRuntime({ ...options, store: second });
  t.after(async () => { hooks.stopFails = false; hooks.badStopReceipt = false; await Promise.allSettled([supervisor.close(), other.close()]);
    await Promise.all([...pipes.values()].map(pipe => pipe.stop())); first.close(); second.close(); await rm(directory, { recursive: true, force: true }); });
  const connect = async (actor = 'actor-a') => {
    const session = await access.authenticate(`Bearer ${actor}`, config.organizationId, config.workspaceId);
    const connection = await connections.create(session, { configurationId: config.configurationId, requestKey: randomUUID() });
    const record = await first.transact(tx => tx.get<{ binding: CliBinding }>(`organization-connection:${connection.id}`)); assert.ok(record);
    return { session, connection, binding: record.binding };
  };
  const login = async (actor = 'actor-a') => {
    const owner = await connect(actor), command = { requestKey: randomUUID(), operation: 'login' as const };
    await connections.perform(owner.session, owner.connection.id, command); await nextTurn();
    assert.equal((await connections.status(owner.session, owner.connection.id) as { status: string }).status, 'connected');
    return { ...owner, command };
  };
  return { first, second, access, leases, otherLeases, supervisor, other, connections, otherConnections, runbooks, membership, connect, login,
    provisions, stops, calls, pipes, hooks, advance(ms: number) { now += ms; }, now: () => now };
}

test('unconfigured and non-login requests cannot allocate workers or fall back to a host CLI', async t => {
  const s = await fixture(t, false), a = await s.connect();
  await assert.rejects(s.connections.status(a.session, a.connection.id), failed);
  await assert.rejects(s.connections.perform(a.session, a.connection.id, { requestKey: randomUUID(), operation: 'login' }), failed);
  assert.equal(await s.leases.read(a.binding), undefined); assert.equal(s.provisions.length, 0); assert.equal(s.calls.length, 0);
});

test('registry reservations, two supervisors and worker protocol replay prevent duplicate login/read dispatch', async t => {
  const s = await fixture(t), a = await s.connect();
  await s.connections.list(a.session); await assert.rejects(s.connections.status(a.session, a.connection.id), failed);
  assert.equal(s.provisions.length, 0);
  const command = { requestKey: randomUUID(), operation: 'login' };
  const results = await Promise.allSettled([s.connections.perform(a.session, a.connection.id, command), s.otherConnections.perform(a.session, a.connection.id, command)]);
  assert.equal(results.filter(value => value.status === 'fulfilled').length, 1); await nextTurn();
  const prior = s.calls.length;
  await s.otherConnections.perform(a.session, a.connection.id, command); assert.equal(s.calls.length, prior);
  assert.equal(s.provisions.length, 1); assert.equal(s.calls.filter(value => value.operation === 'login').length, 1);
  const owning = (await s.leases.read(a.binding))?.supervisorId === s.supervisor.id ? s.connections : s.otherConnections;
  const read = { requestKey: randomUUID(), operation: 'inspect', service: 'lambda' };
  await owning.perform(a.session, a.connection.id, read); const readCount = s.calls.length;
  await s.otherConnections.perform(a.session, a.connection.id, read); assert.equal(s.calls.length, readCount);
});

test('status never renews; heartbeat refreshes authorization and lease without CLI or provisioning calls', async t => {
  const s = await fixture(t), a = await s.login(), initial = await s.leases.read(a.binding), before = s.calls.length;
  s.advance(3000); await s.connections.status(a.session, a.connection.id);
  assert.equal((await s.leases.read(a.binding))?.expiresAt, initial?.expiresAt);
  await s.supervisor.maintain(); assert.equal((await s.leases.read(a.binding))?.expiresAt, s.now() + 10_000);
  assert.equal(s.calls.length, before); assert.equal(s.provisions.length, 1);
});

test('two actors have distinct allocation/cache identities and one logout/stop preserves the other', async t => {
  const s = await fixture(t), a = await s.login(), b = await s.login('actor-b');
  assert.notEqual(s.provisions[0].handle.cacheKey, s.provisions[1].handle.cacheKey);
  await s.connections.perform(a.session, a.connection.id, { requestKey: randomUUID(), operation: 'logout' });
  assert.deepEqual(s.calls.filter(call => call.operation === 'logout').map(call => call.actor), ['actor-a']);
  await s.supervisor.stop(a.binding); assert.equal((await s.leases.read(a.binding))?.state, 'retired');
  assert.equal((await s.connections.status(b.session, b.connection.id) as { status: string }).status, 'connected');
  assert.equal(s.stops.some(value => value.binding.actorId === 'actor-b'), false);
});

test('a new supervisor cannot adopt a live generation; explicit fencing precedes fresh allocation', async t => {
  const s = await fixture(t), a = await s.login(), first = s.provisions[0];
  await assert.rejects(s.otherConnections.status(a.session, a.connection.id), failed);
  await assert.rejects(s.otherConnections.perform(a.session, a.connection.id, { requestKey: randomUUID(), operation: 'login' }), failed);
  assert.equal(s.provisions.length, 1);
  await s.other.stop(a.binding);
  await s.otherConnections.perform(a.session, a.connection.id, { requestKey: randomUUID(), operation: 'login' }); await nextTurn();
  assert.equal(s.provisions[1].handle.generation, 2); assert.notEqual(s.provisions[1].handle.cacheKey, first.handle.cacheKey);
  await assert.rejects(s.connections.status(a.session, a.connection.id), failed);
  assert.equal((await s.otherConnections.status(a.session, a.connection.id) as { status: string }).status, 'connected');
  assert.equal(s.stops.some(value => value.handle.leaseId === s.provisions[1].handle.leaseId), false);
});

test('expiry during provisioning plus unconfirmed stop stays unknown and cannot be retried into another worker', async t => {
  const s = await fixture(t), a = await s.connect(), entered = deferred(), gate = deferred();
  s.hooks.beforeProvision = async () => { entered.resolve(); await gate.promise; }; s.hooks.stopFails = true;
  const command = { requestKey: randomUUID(), operation: 'login' }, pending = s.connections.perform(a.session, a.connection.id, command), rejected = assert.rejects(pending, failed);
  await entered.promise; s.advance(10_000); gate.resolve(); await rejected;
  assert.equal((await s.leases.read(a.binding))?.state, 'unknown'); assert.equal(s.calls.length, 0);
  await assert.rejects(s.otherConnections.perform(a.session, a.connection.id, command), failed);
  await assert.rejects(s.otherConnections.perform(a.session, a.connection.id, { ...command, requestKey: randomUUID() }), failed);
  assert.equal(s.provisions.length, 1); s.hooks.stopFails = false; await s.other.stop(a.binding);
  assert.equal((await s.leases.read(a.binding))?.state, 'retired');
});

test('status after expiry stops the owned worker without automatically creating another generation', async t => {
  const s = await fixture(t), a = await s.login(); s.advance(10_000);
  await assert.rejects(s.connections.status(a.session, a.connection.id), failed);
  assert.equal((await s.leases.read(a.binding))?.state, 'retired'); assert.equal(s.provisions.length, 1);
  await assert.rejects(s.connections.status(a.session, a.connection.id), failed); assert.equal(s.provisions.length, 1);
});

test('revocation during a private read blocks release and durable replay; heartbeat also stops an idle revoked owner', async t => {
  const s = await fixture(t), a = await s.login(), b = await s.login('actor-b');
  s.hooks.run = async (binding, operation) => { if (binding.actorId === 'actor-a' && operation === 'lambda') await s.membership('actor-a', false, 2); };
  const command = { requestKey: randomUUID(), operation: 'inspect', service: 'lambda' };
  await assert.rejects(s.connections.perform(a.session, a.connection.id, command), failed);
  assert.equal((await s.leases.read(a.binding))?.state, 'retired'); const before = s.calls.length;
  await s.membership('actor-a', true, 3); const restored = await s.connect();
  await assert.rejects(s.connections.perform(restored.session, a.connection.id, command), failed); assert.equal(s.calls.length, before);
  await s.membership('actor-b', false, 2); await s.supervisor.maintain();
  assert.equal((await s.leases.read(b.binding))?.state, 'retired');
});

test('an active membership version change or server configuration replacement retires the old worker', async t => {
  const s = await fixture(t), a = await s.login(); await s.membership('actor-a', true, 2); await s.supervisor.maintain();
  assert.equal((await s.leases.read(a.binding))?.state, 'retired');
  const replacement = new OrganizationConnections(s.first, s.access, s.supervisor, [{ ...config, region: 'us-west-2' }]);
  await assert.rejects(replacement.workerAuthorization(a.binding), failed);
  await assert.rejects(s.connections.workerAuthorization({ ...a.binding, actorId: 'actor-b' }), failed);
});

test('cancellation while provisioning discards a late pipe and never starts a CLI login', async t => {
  const s = await fixture(t), a = await s.connect(), entered = deferred(), gate = deferred(), controller = new AbortController();
  s.hooks.afterProvision = async value => { entered.resolve(); await gate.promise; return value; };
  const pending = s.supervisor.invoke(a.binding, { id: randomUUID(), operation: 'login' }, controller.signal), rejected = assert.rejects(pending, failed);
  await entered.promise; controller.abort(); await rejected; gate.resolve(); await nextTurn(); await nextTurn();
  assert.equal(s.calls.length, 0); assert.equal(s.provisions.length, 1); assert.equal((await s.leases.read(a.binding))?.state, 'retired');
});

test('a mismatched ready receipt cannot attach or launch a command', async t => {
  const s = await fixture(t), a = await s.connect();
  s.hooks.afterProvision = async value => ({ ...value, receipt: { ...value.receipt, cacheKey: `cache-${randomUUID()}` } });
  await assert.rejects(s.connections.perform(a.session, a.connection.id, { requestKey: randomUUID(), operation: 'login' }), failed);
  assert.equal(s.calls.length, 0); assert.equal((await s.leases.read(a.binding))?.state, 'retired');
});

test('same-binding pipes with a wrong generation or missing allocation fail the handshake before CLI execution', async t => {
  for (const mode of ['old-generation', 'legacy'] as const) await t.test(mode, async child => {
    const s = await fixture(child), a = await s.connect();
    s.hooks.stamp = value => mode === 'legacy' ? undefined : { ...value, generation: value.generation + 1 };
    await assert.rejects(s.connections.perform(a.session, a.connection.id, { requestKey: randomUUID(), operation: 'login' }), failed);
    assert.equal(s.calls.length, 0); assert.equal(s.stops.length, 1);
  });
});

test('a stale-generation reply closes only its owned pipe and cannot be published', async t => {
  const s = await fixture(t), a = await s.login(), b = await s.login('actor-b'), allocation = s.provisions[0];
  s.pipes.get(allocation.handle.leaseId)!.output.write(`${JSON.stringify({ id: randomUUID(), bindingDigest: bindingDigest(a.binding), allocation: { ...allocation.handle, generation: 99 }, ok: true, result: {} })}\n`);
  await nextTurn(); await nextTurn();
  await assert.rejects(s.connections.status(a.session, a.connection.id), failed);
  assert.equal((await s.connections.status(b.session, b.connection.id) as { status: string }).status, 'connected');
});

test('invalid stop receipts preserve unknown and an explicit corrected reconciliation can retire it', async t => {
  const s = await fixture(t), a = await s.login(); s.hooks.badStopReceipt = true;
  await assert.rejects(s.supervisor.stop(a.binding), failed); assert.equal((await s.leases.read(a.binding))?.state, 'unknown');
  await assert.rejects(s.otherConnections.perform(a.session, a.connection.id, { requestKey: randomUUID(), operation: 'login' }), failed);
  s.hooks.badStopReceipt = false; await s.other.stop(a.binding); assert.equal((await s.leases.read(a.binding))?.state, 'retired');
});

test('shutdown waits for a cleanup already removed from routing before returning', async t => {
  const s = await fixture(t), a = await s.login(), entered = deferred(), gate = deferred();
  s.hooks.beforeStop = async () => { entered.resolve(); await gate.promise; };
  const stopping = s.supervisor.stop(a.binding); await entered.promise;
  let closed = false; const closing = s.supervisor.close().then(() => { closed = true; });
  await nextTurn(); const returnedBeforeProof = closed; gate.resolve(); await Promise.all([stopping, closing]);
  assert.equal(returnedBeforeProof, false); assert.equal((await s.leases.read(a.binding))?.state, 'retired');
});

test('two transport owners racing an allocation cannot provision two workers', async t => {
  const s = await fixture(t), a = await s.connect();
  const results = await Promise.allSettled([s.supervisor.invoke(a.binding, { id: randomUUID(), operation: 'login' }, new AbortController().signal),
    s.other.invoke(a.binding, { id: randomUUID(), operation: 'login' }, new AbortController().signal)]);
  assert.equal(results.filter(value => value.status === 'fulfilled').length, 1);
  assert.equal(s.provisions.length, 1); assert.equal(s.calls.filter(value => value.operation === 'login').length, 1);
});

test('shutdown during provisioning settles the active request and fences a late adapter response', async t => {
  const s = await fixture(t), a = await s.connect(), entered = deferred(), gate = deferred();
  s.hooks.afterProvision = async value => { entered.resolve(); await gate.promise; return value; };
  let settled = false;
  const pending = s.supervisor.invoke(a.binding, { id: randomUUID(), operation: 'login' }, new AbortController().signal);
  const rejected = assert.rejects(pending, failed).then(() => { settled = true; });
  await entered.promise; await s.supervisor.close(); assert.equal(settled, true);
  gate.resolve(); await rejected; await nextTurn();
  assert.equal(s.calls.length, 0); assert.equal((await s.leases.read(a.binding))?.state, 'retired');
});

test('an infrastructure port ignoring cancellation is bounded and a late creation stays fenced', async t => {
  const s = await fixture(t), a = await s.connect(), entered = deferred(), gate = deferred();
  s.hooks.beforeProvision = async () => { entered.resolve(); await gate.promise; };
  const command = { requestKey: randomUUID(), operation: 'login' };
  const pending = s.connections.perform(a.session, a.connection.id, command), rejected = assert.rejects(pending, error => failed(error) && !String(error).includes('synthetic infrastructure'));
  await entered.promise;
  // Keep the test process alive past the unref'ed product deadline, then release the deliberately uncooperative port.
  const later = new Promise<void>(resolve => setTimeout(() => { gate.resolve(); resolve(); }, 650));
  await rejected; await later; await nextTurn();
  assert.equal(s.pipes.size, 0); assert.equal(s.calls.length, 0); assert.equal((await s.leases.read(a.binding))?.state, 'retired');
  await assert.rejects(s.connections.perform(a.session, a.connection.id, command), failed); assert.equal(s.provisions.length, 1);
});

test('HTTP authentication, registry replay, supervisor generation and private worker reads compose without provider calls on refresh', async t => {
  const s = await fixture(t), services = { access: s.access, connections: s.connections, runbooks: s.runbooks, publicOrigin: 'http://127.0.0.1' };
  const server = createOrganizationApiServer(services); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => server.close()); const address = server.address(); assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`; services.publicOrigin = origin;
  const base = `${origin}/api/organizations/v1/${config.organizationId}/workspaces/${config.workspaceId}/aws/connections`;
  const request = (path = '', body?: unknown, key = randomUUID(), actor = 'actor-a') => fetch(`${base}${path}`, { method: body ? 'POST' : 'GET',
    headers: { Origin: origin, Authorization: `Bearer ${actor}`, 'Content-Type': 'application/json', 'Idempotency-Key': key }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const created = await request('', { configurationId: config.configurationId }); assert.equal(created.status, 200); const { id } = await created.json();
  assert.equal((await request(`/${id}/status`)).status, 503); assert.equal(s.provisions.length, 0);
  const key = randomUUID(); assert.equal((await request(`/${id}/actions`, { operation: 'login' }, key)).status, 200); await nextTurn();
  const before = s.calls.length; assert.equal((await request(`/${id}/actions`, { operation: 'login' }, key)).status, 200);
  assert.equal((await request(`/${id}/status`)).status, 200); assert.equal(s.calls.length, before);
  assert.equal((await request(`/${id}/status`, undefined, randomUUID(), 'actor-b')).status, 404);
  const inspected = await request(`/${id}/actions`, { operation: 'inspect', service: 'lambda' }); assert.equal(inspected.status, 200);
  assert.equal((await inspected.json()).items[0].name, 'synthetic-resource'); assert.equal(s.provisions.length, 1);
});
