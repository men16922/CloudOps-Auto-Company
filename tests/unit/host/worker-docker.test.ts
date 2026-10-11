import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, stat, writeFile, chmod, symlink, link } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { SqliteCloudStore } from '../../../apps/host/src/storage/sqlite-store';
import { OrganizationWorkerLeases, workerLeaseHandle } from '../../../apps/host/src/workers/leases';
import { DockerOrganizationWorkerProvisioner } from '../../../apps/host/src/workers/docker/provisioner';
import { dockerWorkerEngine, createLocalDockerWorkerEngine, type DockerCommandTransport } from '../../../apps/host/src/workers/docker/docker-cli';
import { dockerAllocationLabels, dockerTmpfs, dockerWorkerConfigSchema, type DockerWorkerConfig } from '../../../apps/host/src/workers/docker/contract';
import { OrganizationWorkerSupervisor, type WorkerAllocation } from '../../../apps/host/src/workers/supervisor';
import { OrganizationCliWorker } from '../../../apps/worker/src/cli-worker';
import { serveCliWorker } from '../../../apps/worker/src/serve';
import type { CliBinding } from '../../../packages/worker-protocol/cli-contract';
import type { CloudStore } from '../../../apps/host/src/storage/store';
import { CloudOperationError } from '../../../packages/contracts/errors';

const failed = (error: unknown) => error instanceof CloudOperationError;
const signal = () => new AbortController().signal;
const keyOf = (value: WorkerAllocation) => `organization-worker-docker:${value.handle.leaseId}`;
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
type Container = { id: string; allocation: WorkerAllocation; running: boolean; input: PassThrough; output: PassThrough; close(): Promise<void> };
async function fixture(t: TestContext) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'cloudops-docker-driver-'))), path = join(directory, 'store.sqlite');
  const first = new SqliteCloudStore(path), second = new SqliteCloudStore(path);
  const now = 1_800_000_000_000, leases = new OrganizationWorkerLeases(first, { now: () => now });
  const config: DockerWorkerConfig = { executable: '/synthetic/docker', socketPath: '/synthetic/docker.sock', metadataRoot: join(directory, 'metadata'),
    daemonId: 'synthetic-engine-a', imageId: `sha256:${'a'.repeat(64)}`, network: 'synthetic-aws-egress' };
  const calls: string[][] = [], aws: string[] = [], containers = new Map<string, Container>();
  const hooks: { create?: () => Promise<void>; start?: () => Promise<void>; remove?: () => Promise<void>;
    createError?: boolean; lostCreateResponse?: boolean; startError?: boolean; wrongDaemon?: boolean; observation?: (value: Record<string, unknown>) => Record<string, unknown> } = {};
  const transport: DockerCommandTransport = {
    assertAvailable() {},
    async exec(input) {
      const args = [...input]; calls.push(args);
      assert.deepEqual(args.slice(0, 4), ['--host', `unix://${config.socketPath}`, '--config', join(config.metadataRoot, 'client')]);
      const operation = args[5];
      if (args[4] === 'info') return JSON.stringify(hooks.wrongDaemon ? 'foreign-engine-b' : config.daemonId);
      if (operation === 'create') {
        await hooks.create?.(); if (hooks.createError) throw new Error('synthetic private daemon error');
        const name = args[args.indexOf('--name') + 1], leaseId = name.slice('worker-'.length), metadata = join(config.metadataRoot, leaseId);
        const allocation = { binding: JSON.parse(await readFile(join(metadata, 'binding.json'), 'utf8')), handle: JSON.parse(await readFile(join(metadata, 'lease.json'), 'utf8')) };
        const id = createHash('sha256').update(randomUUID()).digest('hex'), input = new PassThrough(), output = new PassThrough();
        let serving: Promise<void> | undefined;
        const value: Container = { id, allocation, input, output, running: false, async close() { input.end(); await serving; output.destroy(); } };
        Object.defineProperty(value, 'begin', { value: () => {
          const worker = new OrganizationCliWorker(allocation.binding, { async run(operation, _signal, write) {
            aws.push(`${allocation.binding.actorId}:${operation}`);
            if (operation === 'login') { write?.('https://device.sso.us-east-1.amazonaws.com/\nThen enter the code:\nDEMO-CODE\n'); return { stdout: '' }; }
            if (operation === 'identity') return { stdout: JSON.stringify({ Account: allocation.binding.accountId,
              Arn: `arn:aws:sts::${allocation.binding.accountId}:assumed-role/AWSReservedSSO_${allocation.binding.roleName}_0123456789abcdef/synthetic-session`, UserId: `SYNTHETIC:${allocation.binding.actorId}` }) };
            return { stdout: '{"Items":[],"HasMore":false}' };
          } }, () => now);
          serving = serveCliWorker(worker, input, output, allocation.handle);
        } });
        containers.set(id, value);
        if (hooks.lostCreateResponse) throw new Error('synthetic lost create response after the daemon created it');
        return `${id}\n`;
      }
      const id = args.at(-1)!;
      if (operation === 'start') {
        const value = containers.get(id)!; value.running = true; (value as Container & { begin(): void }).begin();
        await hooks.start?.(); if (hooks.startError) throw new Error('synthetic lost start response'); return `${id}\n`;
      }
      if (operation === 'rm') {
        await hooks.remove?.(); await containers.get(id)?.close(); containers.delete(id); return `${id}\n`;
      }
      if (operation === 'ls') { const filter = args[args.indexOf('--filter') + 1].slice(3); return containers.has(filter) ? `${filter}\n` : ''; }
      if (operation === 'inspect') {
        const value = containers.get(id)!;
        const projected = { id, name: `/${value.allocation.handle.resourceKey}`, image: config.imageId, labels: dockerAllocationLabels(config, value.allocation),
          running: value.running, status: value.running ? 'running' : 'created', user: '10001:10001', entrypoint: ['node'], cmd: ['/app/worker.mjs'], stdin: true, tty: false,
          readonly: true, privileged: false, capAdd: null, capDrop: ['ALL'], security: ['no-new-privileges:true'], network: config.network, pidMode: '', ipcMode: 'private', restart: 'no',
          memory: 268435456, swap: 268435456, cpus: 250000000, pids: 64, logs: 'none', ports: {}, devices: null, tmpfs: dockerTmpfs,
          mounts: ['binding.json', 'lease.json'].map(file => ({ Type: 'bind', Source: join(config.metadataRoot, value.allocation.handle.leaseId, file), Destination: `/run/cloudops/${file}`, RW: false })) };
        return JSON.stringify(hooks.observation ? hooks.observation(projected) : projected);
      }
      throw new Error('Unsupported synthetic command');
    },
    async attach(args) {
      calls.push([...args]); assert.deepEqual(args.slice(4, -1), ['container', 'attach', '--sig-proxy=false']);
      const value = containers.get(args.at(-1)!); assert.ok(value?.running);
      return { input: value.input, output: value.output, close: () => value.close() };
    },
  };
  const engine = dockerWorkerEngine(config, transport), provider = new DockerOrganizationWorkerProvisioner({ store: first, leases, config, engine, now: () => now });
  const other = new DockerOrganizationWorkerProvisioner({ store: second, leases, config, engine, now: () => now });
  t.after(async () => { await Promise.all([...containers.values()].map(value => value.close())); first.close(); second.close(); await rm(directory, { recursive: true, force: true }); });
  const binding = (actor = 'actor-a'): CliBinding => ({ connectionId: randomUUID(), organizationId: 'synthetic-org', workspaceId: 'workspace-a', actorId: actor,
    startUrl: 'https://synthetic-example.awsapps.com/start', ssoRegion: 'us-east-1', region: 'ap-northeast-2', accountId: '123456789012', roleName: 'ReadOnlyAccess' });
  const allocation = async (actor = 'actor-a') => {
    const owner = binding(actor), { lease } = await leases.claim(owner, randomUUID(), randomUUID()); return { binding: owner, handle: workerLeaseHandle(lease) };
  };
  return { directory, path, first, second, config, leases, transport, engine, provider, other, calls, aws, hooks, containers, binding, allocation,
    count: (operation: string) => calls.filter(args => args[5] === operation).length,
    record: (value: WorkerAllocation) => first.transact(tx => tx.get<Record<string, unknown>>(keyOf(value))) };
}

test('fixed create/start/attach arguments use immutable image, non-root limits, private metadata and ephemeral cache', async t => {
  const s = await fixture(t), a = await s.allocation(), result = await s.provider.provision(a, signal());
  assert.deepEqual(result.receipt, { ...a.handle, ready: true }); assert.equal(s.aws.length, 0);
  const create = s.calls.find(args => args[5] === 'create')!;
  for (const flag of ['--pull=never', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges:true', '--user=10001:10001', '--log-driver=none', '--memory=268435456', '--memory-swap=268435456', '--pids-limit=64', '--restart=no', '--no-healthcheck']) assert.ok(create.includes(flag));
  assert.deepEqual(create.slice(-2), [s.config.imageId, '/app/worker.mjs']);
  assert.equal(create.slice(4).some(arg => /--privileged|--publish|docker.sock|\/\.aws\/sso/.test(arg)), false);
  assert.equal(s.count('create'), 1); assert.equal(s.count('start'), 1); assert.equal(s.count('attach'), 1);
  const receipt = await s.other.fenceAndStop(a, signal()); assert.equal(receipt.cacheAccessRevoked, true); assert.equal(s.containers.size, 0);
  const before = s.calls.length; await s.provider.fenceAndStop(a, signal()); assert.equal(s.calls.length, before);
});

test('two durable provisioners cannot issue duplicate create or replay a running allocation', async t => {
  const s = await fixture(t), a = await s.allocation();
  const results = await Promise.allSettled([s.provider.provision(a, signal()), s.other.provision(a, signal())]);
  assert.equal(results.filter(value => value.status === 'fulfilled').length, 1); assert.equal(s.count('create'), 1);
  await assert.rejects(s.other.provision(a, signal()), failed); assert.equal(s.count('create'), 1);
});

test('a durable tombstone before provisioning prevents any late create and survives store reopen', async t => {
  const s = await fixture(t), a = await s.allocation(); await s.provider.fenceAndStop(a, signal());
  const reopened = new SqliteCloudStore(s.path);
  try {
    const provider = new DockerOrganizationWorkerProvisioner({ store: reopened, leases: s.leases, config: s.config, engine: s.engine });
    await assert.rejects(provider.provision(a, signal()), failed); assert.equal(s.calls.length, 0);
  } finally { reopened.close(); }
});

test('fencing a pending create does not claim absence; late create cannot progress to start', async t => {
  const s = await fixture(t), a = await s.allocation(), entered = deferred(), gate = deferred();
  s.hooks.create = async () => { entered.resolve(); await gate.promise; };
  const pending = s.provider.provision(a, signal()), rejected = assert.rejects(pending, failed); await entered.promise;
  await assert.rejects(s.other.fenceAndStop(a, signal()), failed); assert.equal((await s.record(a))?.retired, false);
  gate.resolve(); await rejected; assert.equal(s.count('start'), 0); assert.equal(s.containers.size, 1);
  await s.other.fenceAndStop(a, signal()); assert.equal(s.containers.size, 0); assert.equal((await s.record(a))?.retired, true);
});

test('an unconfirmed create is never retried and does not produce a retirement receipt after restart', async t => {
  const s = await fixture(t), a = await s.allocation(); s.hooks.createError = true;
  await assert.rejects(s.provider.provision(a, signal()), failed);
  await assert.rejects(s.other.provision(a, signal()), failed); await assert.rejects(s.other.fenceAndStop(a, signal()), failed);
  assert.equal(s.count('create'), 1); assert.equal(s.count('start'), 0); assert.equal((await s.record(a))?.retired, false);
});

test('fencing a pending start stops the known ID but waits for its terminal intent before attesting', async t => {
  const s = await fixture(t), a = await s.allocation(), entered = deferred(), gate = deferred();
  s.hooks.start = async () => { entered.resolve(); await gate.promise; };
  const pending = s.provider.provision(a, signal()), rejected = assert.rejects(pending, failed); await entered.promise;
  await assert.rejects(s.other.fenceAndStop(a, signal()), failed); assert.equal(s.containers.size, 0); assert.equal((await s.record(a))?.retired, false);
  gate.resolve(); await rejected; await s.other.fenceAndStop(a, signal()); assert.equal((await s.record(a))?.retired, true);
  assert.equal(s.count('start'), 1); assert.equal(s.count('attach'), 0);
});

test('lost start response stays unknown even after targeted removal and two absence observations', async t => {
  const s = await fixture(t), a = await s.allocation(); s.hooks.startError = true;
  await assert.rejects(s.provider.provision(a, signal()), failed);
  await assert.rejects(s.other.fenceAndStop(a, signal()), failed); assert.equal(s.containers.size, 0);
  await assert.rejects(s.provider.fenceAndStop(a, signal()), failed); assert.equal((await s.record(a))?.retired, false);
  assert.equal(s.count('start'), 1); assert.equal(s.count('rm'), 1);
});

test('foreign binding/configuration cannot target persisted containers for removal', async t => {
  const s = await fixture(t), a = await s.allocation(); await s.provider.provision(a, signal());
  const before = s.calls.length;
  await assert.rejects(s.other.fenceAndStop({ ...a, binding: { ...a.binding, actorId: 'foreign-actor' } }, signal()), failed);
  const foreign = new DockerOrganizationWorkerProvisioner({ store: s.second, leases: s.leases, engine: s.engine, config: { ...s.config, daemonId: 'foreign-engine-b' } });
  await assert.rejects(foreign.fenceAndStop(a, signal()), failed); assert.equal(s.calls.length, before); assert.equal(s.containers.size, 1);
});

test('tampered container ownership/runtime controls fail before start or destructive removal', async t => {
  for (const [field, value] of [['privileged', true], ['readonly', false], ['network', 'host'], ['logs', 'json-file'], ['labels', {}], ['memory', 0], ['mounts', []]]) {
    await t.test(field as string, async child => {
      const s = await fixture(child), a = await s.allocation(); s.hooks.observation = record => ({ ...record, [field as string]: value });
      await assert.rejects(s.provider.provision(a, signal()), failed); assert.equal(s.count('start'), 0);
      await assert.rejects(s.provider.fenceAndStop(a, signal()), failed); assert.equal(s.count('rm'), 0);
      assert.equal((await s.record(a))?.retired, false);
    });
  }
});

test('one actor teardown does not reuse another actor metadata/cache/container identity', async t => {
  const s = await fixture(t), a = await s.allocation(), b = await s.allocation('actor-b');
  await s.provider.provision(a, signal()); await s.provider.provision(b, signal());
  await s.other.fenceAndStop(a, signal()); assert.equal(s.containers.size, 1);
  assert.equal([...s.containers.values()][0].allocation.binding.actorId, 'actor-b');
  assert.notEqual(a.handle.cacheKey, b.handle.cacheKey);
});

test('metadata stays under private canonical directories and remains readable under a restrictive umask', async t => {
  const s = await fixture(t), a = await s.allocation(), previous = process.umask(0o077);
  try { await s.engine.prepare(a, signal()); } finally { process.umask(previous); }
  assert.equal((await stat(s.config.metadataRoot)).mode & 0o777, 0o700);
  assert.equal((await stat(join(s.config.metadataRoot, a.handle.leaseId, 'binding.json'))).mode & 0o777, 0o444);
  const file = join(s.config.metadataRoot, a.handle.leaseId, 'binding.json'); await chmod(file, 0o600); await writeFile(file, '{"actorId":"foreign"}'); await chmod(file, 0o444);
  await assert.rejects(s.engine.prepare(a, signal()), failed);
});

test('offline native factory rejects before parsing configuration or touching an executable/socket', () => {
  const before = process.env.CLOUDOPS_ORGANIZATION_DOCKER_ENABLED;
  try { process.env.CLOUDOPS_ORGANIZATION_DOCKER_ENABLED = '1'; assert.equal(process.env.CLOUDOPS_OFFLINE_TEST, '1'); assert.equal(createLocalDockerWorkerEngine({ executable: '/not-allowed' }), undefined); }
  finally { if (before === undefined) delete process.env.CLOUDOPS_ORGANIZATION_DOCKER_ENABLED; else process.env.CLOUDOPS_ORGANIZATION_DOCKER_ENABLED = before; }
});

test('a daemon identity change fails before create and never publishes a ready receipt', async t => {
  const s = await fixture(t), a = await s.allocation(); s.hooks.wrongDaemon = true;
  await assert.rejects(s.provider.provision(a, signal()), failed); assert.equal(s.count('create'), 0);
  assert.equal((await s.record(a))?.retired, false);
});

test('driver transactions retry without repeating an external create or start', async t => {
  const s = await fixture(t), a = await s.allocation(), retry = new Error('synthetic retry'); let attempts = 0;
  const store: CloudStore = { async transact(body) {
    try { await s.first.transact(async tx => { await body(tx); attempts++; throw retry; }); } catch (error) { if (error !== retry) throw error; }
    return s.first.transact(body);
  } };
  const provider = new DockerOrganizationWorkerProvisioner({ store, leases: s.leases, config: s.config, engine: s.engine });
  await provider.provision(a, signal()); assert.ok(attempts > 3); assert.equal(s.count('create'), 1); assert.equal(s.count('start'), 1);
  await provider.fenceAndStop(a, signal()); assert.equal(s.count('rm'), 1);
});

test('supervisor, durable driver, fixed command adapter and private generation-stamped worker compose', async t => {
  const s = await fixture(t), binding = s.binding(), supervisor = new OrganizationWorkerSupervisor({ leases: s.leases, provisioner: s.provider,
    authorize: async () => ({ revision: 'a'.repeat(64) }), heartbeatIntervalMs: 0 });
  t.after(() => supervisor.close());
  assert.equal((await supervisor.invoke(binding, { id: randomUUID(), operation: 'login' }, signal())).ok, true); await nextTurn();
  const before = s.aws.length; assert.equal((await supervisor.invoke(binding, { id: randomUUID(), operation: 'status' }, signal())).ok, true);
  assert.equal(s.aws.length, before); assert.equal(s.count('create'), 1);
  await supervisor.stop(binding); assert.equal((await s.leases.read(binding))?.state, 'retired'); assert.equal(s.containers.size, 0);
});

test('a late rejected provisioning attempt is reconciled after its in-flight start becomes confirmed', async t => {
  const s = await fixture(t), binding = s.binding(), entered = deferred(), gate = deferred(), abort = new AbortController();
  s.hooks.start = async () => { entered.resolve(); await gate.promise; };
  // Simulate an infrastructure port that ignores cancellation but returns a confirmed terminal start.
  // The fixed CLI adapter instead treats interrupted post-command validation as unknown (next test).
  const provisioner = new DockerOrganizationWorkerProvisioner({ store: s.first, leases: s.leases, config: s.config,
    engine: { ...s.engine, start: id => s.engine.start(id, signal()) } });
  const supervisor = new OrganizationWorkerSupervisor({ leases: s.leases, provisioner, authorize: async () => ({ revision: 'a'.repeat(64) }), heartbeatIntervalMs: 0 });
  t.after(() => supervisor.close());
  const pending = supervisor.invoke(binding, { id: randomUUID(), operation: 'login' }, abort.signal), rejected = assert.rejects(pending, failed);
  await entered.promise; abort.abort(); await rejected;
  assert.equal((await s.leases.read(binding))?.state, 'unknown'); assert.equal(s.containers.size, 0);
  gate.resolve();
  for (let attempt = 0; attempt < 100 && (await s.leases.read(binding))?.state !== 'retired'; attempt++) await nextTurn();
  const lease = await s.leases.read(binding);
  const record = await s.record({ binding, handle: workerLeaseHandle(lease!) });
  assert.equal((record?.start as { state: string }).state, 'confirmed');
  assert.equal((await s.leases.read(binding))?.state, 'retired'); assert.equal(s.aws.length, 0); assert.equal(s.count('start'), 1);
});

test('cancellation during post-start CLI validation remains unknown after late rejection cleanup', async t => {
  const s = await fixture(t), binding = s.binding(), entered = deferred(), gate = deferred(), abort = new AbortController();
  s.hooks.start = async () => { entered.resolve(); await gate.promise; };
  const supervisor = new OrganizationWorkerSupervisor({ leases: s.leases, provisioner: s.provider, authorize: async () => ({ revision: 'a'.repeat(64) }), heartbeatIntervalMs: 0 });
  t.after(() => supervisor.close());
  const rejected = assert.rejects(supervisor.invoke(binding, { id: randomUUID(), operation: 'login' }, abort.signal), failed);
  await entered.promise; abort.abort(); await rejected; gate.resolve();
  for (let attempt = 0; attempt < 100; attempt++) await nextTurn();
  const lease = await s.leases.read(binding), record = await s.record({ binding, handle: workerLeaseHandle(lease!) });
  assert.equal((record?.start as { state: string }).state, 'unknown'); assert.equal(record?.retired, false);
  await assert.rejects(supervisor.stop(binding), failed);
  assert.equal((await s.leases.read(binding))?.state, 'unknown'); assert.equal(s.count('start'), 1); assert.equal(s.containers.size, 0);
});

test('shutdown waits for targeted cleanup triggered by a late rejected provisioning response', async t => {
  const s = await fixture(t), binding = s.binding(), started = deferred(), startGate = deferred(), stopping = deferred(), stopGate = deferred(), abort = new AbortController();
  s.hooks.start = async () => { started.resolve(); await startGate.promise; };
  const driver = new DockerOrganizationWorkerProvisioner({ store: s.first, leases: s.leases, config: s.config,
    engine: { ...s.engine, start: id => s.engine.start(id, signal()) } });
  let stops = 0;
  const supervisor = new OrganizationWorkerSupervisor({ leases: s.leases, authorize: async () => ({ revision: 'a'.repeat(64) }), heartbeatIntervalMs: 0,
    provisioner: { provision: (...args) => driver.provision(...args), async fenceAndStop(...args) {
      if (++stops === 2) { stopping.resolve(); await stopGate.promise; }
      return driver.fenceAndStop(...args);
    } } });
  t.after(async () => { startGate.resolve(); stopGate.resolve(); await supervisor.close(); });
  const rejected = assert.rejects(supervisor.invoke(binding, { id: randomUUID(), operation: 'login' }, abort.signal), failed);
  await started.promise; abort.abort(); await rejected; startGate.resolve(); await stopping.promise;
  let closed = false; const closing = supervisor.close().then(() => { closed = true; });
  await nextTurn(); const closedBeforeReceipt = closed;
  stopGate.resolve(); await closing;
  assert.equal(closedBeforeReceipt, false);
  assert.equal((await s.leases.read(binding))?.state, 'retired');
});

test('a rolled-back create intent cannot dispatch Docker or be mistaken for a confirmed create', async t => {
  const s = await fixture(t), a = await s.allocation(), rollback = new Error('synthetic durable commit failure');
  const store: CloudStore = { transact: body => s.first.transact(async tx => {
    let pendingCreate = false;
    const result = await body({ get: tx.get, put(key, value) {
      tx.put(key, value);
      if (key === keyOf(a) && (value as { create?: { state: string } }).create?.state === 'pending') pendingCreate = true;
    } });
    if (pendingCreate) throw rollback;
    return result;
  }) };
  const driver = new DockerOrganizationWorkerProvisioner({ store, leases: s.leases, config: s.config, engine: s.engine });
  await assert.rejects(driver.provision(a, signal()), error => error === rollback);
  assert.equal(s.count('create'), 0); assert.equal((await s.record(a))?.create, undefined);
  await s.other.fenceAndStop(a, signal()); assert.equal((await s.record(a))?.retired, true);
});

test('malformed persisted confirmation without a container ID cannot authorize retirement', async t => {
  const s = await fixture(t), a = await s.allocation(); s.hooks.createError = true;
  await assert.rejects(s.provider.provision(a, signal()), failed);
  await s.first.transact(async tx => {
    const record = await tx.get<Record<string, unknown>>(keyOf(a));
    tx.put(keyOf(a), { ...record, create: { ...(record!.create as object), state: 'confirmed' } });
  });
  const before = s.calls.length;
  await assert.rejects(s.other.fenceAndStop(a, signal()), failed); assert.equal(s.calls.length, before);
});

test('concurrent cleanup cannot confirm retirement before the pending targeted removal settles', async t => {
  const s = await fixture(t), a = await s.allocation(), entered = deferred(), gate = deferred(); await s.provider.provision(a, signal());
  s.hooks.remove = async () => { entered.resolve(); await gate.promise; };
  const stopping = s.provider.fenceAndStop(a, signal()); await entered.promise;
  await assert.rejects(s.other.fenceAndStop(a, signal()), failed); assert.equal((await s.record(a))?.retired, false);
  gate.resolve(); await stopping; await s.other.fenceAndStop(a, signal());
  assert.equal(s.count('rm'), 1); assert.equal((await s.record(a))?.retired, true);
});

test('metadata symlinks and hardlinks fail before any daemon call and leave the target untouched', async t => {
  for (const kind of ['symlink', 'hardlink']) {
    const s = await fixture(t), a = await s.allocation(); await s.engine.prepare(a, signal());
    const path = join(s.config.metadataRoot, a.handle.leaseId, 'binding.json'), content = await readFile(path, 'utf8'), target = join(s.directory, 'foreign-metadata');
    await writeFile(target, content, { mode: 0o444 }); await rm(path);
    if (kind === 'symlink') await symlink(target, path); else await link(target, path);
    const before = s.calls.length;
    await assert.rejects(s.engine.prepare(a, signal()), failed); assert.equal(s.calls.length, before);
    assert.equal(await readFile(target, 'utf8'), content);
  }
});

test('server Docker configuration rejects floating images, host networking, remote sockets and path injection', async t => {
  const s = await fixture(t);
  assert.equal(dockerWorkerConfigSchema.safeParse(s.config).success, true);
  for (const patch of [{ imageId: 'cloudops:latest' }, { network: 'host' }, { network: 'bridge' }, { socketPath: 'tcp://example.invalid:2375' },
    { metadataRoot: '/tmp/../elsewhere' }, { metadataRoot: '/tmp/cache,readonly=false' }, { executable: '/tmp/docker\n--privileged' }, { arbitraryCommand: 'run' }]) {
    assert.equal(dockerWorkerConfigSchema.safeParse({ ...s.config, ...patch }).success, false);
  }
  assert.equal(s.calls.length, 0);
});

test('an already cancelled allocation neither writes intent or metadata nor calls the command port', async t => {
  const s = await fixture(t), a = await s.allocation(), abort = new AbortController(); abort.abort();
  await assert.rejects(s.provider.provision(a, abort.signal), failed);
  assert.equal(await s.record(a), undefined); assert.equal(s.calls.length, 0);
  await assert.rejects(stat(s.config.metadataRoot), { code: 'ENOENT' });
});

test('an unconfirmed attachment close still removes its known container and retains cleanup for an explicit retry', async t => {
  const s = await fixture(t), a = await s.allocation(); let closes = 0;
  const driver = new DockerOrganizationWorkerProvisioner({ store: s.first, leases: s.leases, config: s.config, engine: {
    ...s.engine, async attach(...args) {
      const pipe = await s.engine.attach(...args);
      return { ...pipe, async close() { if (++closes === 1) throw new Error('synthetic unconfirmed pipe close'); await pipe.close(); } };
    },
  } });
  await driver.provision(a, signal());
  await assert.rejects(driver.fenceAndStop(a, signal()));
  assert.equal(s.containers.size, 0); assert.equal(s.count('rm'), 1); assert.equal((await s.record(a))?.retired, false);
  await driver.fenceAndStop(a, signal()); assert.equal(closes, 2); assert.equal((await s.record(a))?.retired, true);
});

test('an operator can adopt only a verified late-created container after investigation, then retire it', async t => {
  const s = await fixture(t), a = await s.allocation();
  s.hooks.lostCreateResponse = true;
  await assert.rejects(s.provider.provision(a, signal()), failed);
  s.hooks.lostCreateResponse = false;
  const [late] = [...s.containers.keys()];
  assert.equal(s.containers.size, 1);
  await assert.rejects(s.provider.adoptInvestigatedContainer(a, late!, signal()), failed, 'an unfenced record is not eligible');
  await assert.rejects(s.provider.fenceAndStop(a, signal()), failed, 'an unconfirmed create never yields a receipt');
  assert.equal(s.containers.size, 1);
  await assert.rejects(s.provider.adoptInvestigatedContainer(a, 'f'.repeat(64), signal()), failed, 'an absent ID is refused');
  const b = await s.allocation('actor-b'); await s.provider.provision(b, signal());
  const foreign = [...s.containers.keys()].find(id => id !== late)!;
  await assert.rejects(s.provider.adoptInvestigatedContainer(a, foreign, signal()), failed, 'another allocation\'s container fails inspection');
  assert.ok(s.containers.has(foreign));
  const receipt = await s.provider.adoptInvestigatedContainer(a, late!, signal());
  assert.deepEqual(receipt, { ...a.handle, stopped: true, cacheAccessRevoked: true });
  assert.equal(s.containers.has(late!), false);
  assert.equal((await s.record(a))?.retired, true);
  await assert.rejects(s.provider.adoptInvestigatedContainer(a, late!, signal()), failed, 'a retired record is not eligible again');
  await s.leases.quarantine(a.binding, a.handle, 'provisioning_uncertain');
  assert.equal((await s.leases.retire(a.binding, a.handle, receipt)).state, 'retired');
});
