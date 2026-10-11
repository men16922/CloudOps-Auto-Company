import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { OrganizationWebAccess, identityActor } from '../../../apps/host/src/identity/web-access';
import { SqliteCloudStore } from '../../../apps/host/src/storage/sqlite-store';
import { OrganizationConnections, type OrganizationWorkerTransport } from '../../../apps/host/src/connections/connections';
import { OrganizationCliWorker } from '../../../apps/worker/src/cli-worker';
import { createOrganizationApiServer } from '../../../apps/host/src';
import { CloudOperationError } from '../../../packages/contracts/errors';
import { FileObservationCache } from '../../../apps/host/src/connections/observation-cache';
import { readdir, stat } from 'node:fs/promises';

const issuer = 'https://company.example.invalid';
const config = { configurationId: 'aws-read', label: 'Synthetic AWS', organizationId: 'synthetic-org', workspaceId: 'workspace-a', startUrl: 'https://synthetic-example.awsapps.com/start', ssoRegion: 'us-east-1', region: 'ap-northeast-2', accountId: '123456789012', roleName: 'ReadOnlyAccess' };
const errorCode = (expected: string) => (error: unknown) => error instanceof CloudOperationError && error.code === expected;
async function fixture(t: TestContext, withDirectory = false) {
  const trusted = { ...config, ...(withDirectory ? { directory: { awsOrganizationId: 'o-synthetic1', parentId: 'r-demo' } } : {}) };
  const directory = await mkdtemp(join(tmpdir(), 'cloudops-organization-api-')), path = join(directory, 'cloud.sqlite');
  const first = new SqliteCloudStore(path), second = new SqliteCloudStore(path);
  const workers = new Map<string, OrganizationCliWorker>(), calls: string[] = [];
  let now = 1_800_000_000_000, revoked = false;
  // Synthetic company verifier port only; no signature/SSO claim is made by this fixture.
  const identities = { async verify(token: string) {
    if (revoked || !['valid-a', 'valid-b'].includes(token)) throw new CloudOperationError(401, 'web_sign_in_required', 'Synthetic identity rejected');
    return { actorId: identityActor(issuer, token === 'valid-a' ? 'employee-a' : 'employee-b'), expiresAt: 1_800_003_600_000 };
  } };
  const access = new OrganizationWebAccess(identities, first, () => now), otherAccess = new OrganizationWebAccess(identities, second, () => now);
  const provision = async (subject: string, active = true, version = 1) => access.provision({ organizationId: config.organizationId, workspaceId: config.workspaceId, actorId: identityActor(issuer, subject), active, roles: ['viewer'], version, updatedAt: new Date(now).toISOString() });
  await provision('employee-a'); await provision('employee-b');
  let transportOverride: OrganizationWorkerTransport['invoke'] | undefined;
  const transport: OrganizationWorkerTransport = { async invoke(binding, command, signal) {
    calls.push(`${binding.actorId}:${command.operation}`);
    if (transportOverride) return transportOverride(binding, command, signal);
    let worker = workers.get(binding.connectionId);
    if (!worker) {
      worker = new OrganizationCliWorker(binding, { async run(operation, _signal, output, input) { const query = input && 'parentId' in input ? input : undefined;
        if (operation === 'login') { output?.('https://device.sso.us-east-1.amazonaws.com/\nThen enter the code:\nDEMO-CODE\n'); return { stdout: '' }; }
        if (operation === 'identity') return { stdout: JSON.stringify({ Account: binding.accountId, Arn: `arn:aws:sts::${binding.accountId}:assumed-role/AWSReservedSSO_${binding.roleName}_0123456789abcdef/synthetic-session`, UserId: `SYNTHETIC:${binding.actorId}` }) };
        if (operation === 'logout') return { stdout: '' };
        if (operation === 'directory-organization') return { stdout: JSON.stringify({ Id: 'o-synthetic1', MasterAccountId: binding.accountId }) };
        if (operation === 'directory-parent') return { stdout: JSON.stringify({ Items: [{ Id: 'r-demo', Name: 'Synthetic root', Arn: `arn:aws:organizations::${binding.accountId}:root/o-synthetic1/r-demo` }], HasMore: false }) };
        if (operation === 'directory-accounts' || operation === 'directory-ous') return { stdout: JSON.stringify({ Items: [], HasMore: !query?.nextToken, NextToken: query?.nextToken ? null : 'synthetic-next-token' }) };
        return { stdout: JSON.stringify({ Items: [{ name: 'synthetic-resource' }], HasMore: false }) };
      } }, () => now); workers.set(binding.connectionId, worker);
    }
    const context = { actorId: binding.actorId, owner: { kind: 'organization' as const, organizationId: binding.organizationId }, workspaceId: binding.workspaceId, channel: 'web' as const, roles: ['viewer' as const] };
    try {
      const result = command.operation === 'status' ? worker.status(context) : command.operation === 'login' ? worker.start(context)
        : command.operation === 'verify' ? await worker.verify(context) : command.operation === 'inspect' ? await worker.inspect(context, command.service)
          : command.operation === 'directory' ? await worker.directory(context, command.cursor) : command.operation === 'disconnect' ? worker.disconnect(context) : await worker.logout(context);
      return { ok: true, result };
    } catch (error) { return { ok: false, code: error instanceof CloudOperationError ? error.code : 'worker_failed' }; }
  } };
  const connections = new OrganizationConnections(first, access, transport, [trusted], () => now);
  const otherConnections = new OrganizationConnections(second, otherAccess, transport, [trusted], () => now);
  t.after(async () => { await Promise.all([...workers.values()].map(worker => worker.close())); first.close(); second.close(); await rm(directory, { recursive: true, force: true }); });
  return { first, path, access, otherAccess, connections, otherConnections, transport, calls, workers, provision,
    session: (token = 'valid-a') => access.authenticate(`Bearer ${token}`, config.organizationId, config.workspaceId),
    revokeIdentity: () => { revoked = true; }, advance: (ms: number) => { now += ms; },
    override: (value: OrganizationWorkerTransport['invoke']) => { transportOverride = value; } };
}


test('membership is durable, versioned and rechecked; revoked, expired and foreign workspace sessions are denied', async t => {
  const s = await fixture(t), session = await s.session(); assert.deepEqual(session.context.roles, ['viewer']);
  await s.otherAccess.assertCurrent(session);
  await assert.rejects(s.access.authenticate('Bearer invalid', config.organizationId, config.workspaceId), errorCode('web_sign_in_required'));
  await assert.rejects(s.access.authenticate('Bearer valid-a', config.organizationId, 'foreign'), errorCode('organization_access_denied'));
  await s.provision('employee-a', false, 2); await assert.rejects(s.access.assertCurrent(session), errorCode('organization_access_denied'));
  await assert.rejects(s.provision('employee-a', true, 2), errorCode('membership_version_conflict'));
  await s.provision('employee-a', true, 3); const newSession = await s.session(); s.advance(3_600_000);
  await assert.rejects(s.access.assertCurrent(newSession), errorCode('web_sign_in_required'));
});

test('concurrent replicas create one owned connection and another user receives a separate profile binding', async t => {
  const s = await fixture(t), first = await s.session(), second = await s.session('valid-b');
  const [a, retry] = await Promise.all([s.connections.create(first, { configurationId: config.configurationId, requestKey: randomUUID() }), s.otherConnections.create(first, { configurationId: config.configurationId, requestKey: randomUUID() })]);
  assert.equal(a.id, retry.id);
  const b = await s.connections.create(second, { configurationId: config.configurationId, requestKey: randomUUID() }); assert.notEqual(a.id, b.id);
  assert.deepEqual((await s.connections.list(first)).items.map(value => value.id), [a.id]);
  await assert.rejects(s.connections.status(second, a.id), errorCode('connection_unavailable'));
  await assert.rejects(s.connections.perform(second, a.id, { requestKey: randomUUID(), operation: 'logout' }), errorCode('connection_unavailable')); assert.equal(s.calls.length, 0);
  const reopened = new SqliteCloudStore(s.path);
  try {
    const access = new OrganizationWebAccess({ verify: async () => first.identity }, reopened, () => 1_800_000_000_000);
    const restored = new OrganizationConnections(reopened, access, s.transport, [config], () => 1_800_000_000_000);
    assert.equal((await restored.list(first)).items[0].id, a.id);
  } finally { reopened.close(); }
});

test('replayed commands require current ownership/membership and changed request bodies cannot call a worker twice', async t => {
  const s = await fixture(t), session = await s.session(), connection = await s.connections.create(session, { configurationId: config.configurationId, requestKey: randomUUID() });
  const requestKey = randomUUID(), command = { requestKey, operation: 'verify' };
  const result = await s.connections.perform(session, connection.id, command);
  assert.deepEqual(await s.otherConnections.perform(session, connection.id, command), result); assert.equal(s.calls.length, 1);
  await assert.rejects(s.connections.perform(session, connection.id, { requestKey, operation: 'logout' }), errorCode('request_key_conflict')); assert.equal(s.calls.length, 1);
  await s.provision('employee-a', false, 2);
  await assert.rejects(s.connections.perform(session, connection.id, command), errorCode('organization_access_denied')); assert.equal(s.calls.length, 1);
});

test('lost worker replies remain unknown; retry never redispatches and a concurrent request is rejected', async t => {
  const s = await fixture(t), session = await s.session(), connection = await s.connections.create(session, { configurationId: config.configurationId, requestKey: randomUUID() });
  let reject!: (reason: Error) => void;
  const waiting = new Promise<never>((_resolve, fail) => { reject = fail; }); s.override(async () => waiting);
  const command = { requestKey: randomUUID(), operation: 'login' };
  const started = s.connections.perform(session, connection.id, command); await nextTurn();
  await assert.rejects(s.otherConnections.perform(session, connection.id, command), errorCode('worker_request_uncertain'));
  await assert.rejects(s.otherConnections.perform(session, connection.id, { requestKey: randomUUID(), operation: 'logout' }), errorCode('connection_busy'));
  reject(new Error('private token error')); await assert.rejects(started, errorCode('worker_request_uncertain'));
  await assert.rejects(s.connections.perform(session, connection.id, command), errorCode('worker_request_uncertain')); assert.equal(s.calls.length, 1);
});

test('membership revoked during a provider read prevents release or replay of its result', async t => {
  const s = await fixture(t), session = await s.session(), connection = await s.connections.create(session, { configurationId: config.configurationId, requestKey: randomUUID() });
  s.override(async binding => { await s.provision('employee-a', false, 2); return { ok: true, result: { connectionId: binding.connectionId, accountId: binding.accountId, region: binding.region, roleName: binding.roleName, status: 'connected' } }; });
  const command = { requestKey: randomUUID(), operation: 'verify' };
  await assert.rejects(s.connections.perform(session, connection.id, command), errorCode('organization_access_denied'));
  await s.provision('employee-a', true, 3); const restored = await s.session();
  await assert.rejects(s.connections.perform(restored, connection.id, command), errorCode('worker_request_uncertain')); assert.equal(s.calls.length, 1);
});

test('configuration changes and malformed worker responses never retarget a saved connection or expose secrets', async t => {
  const s = await fixture(t), session = await s.session(), connection = await s.connections.create(session, { configurationId: config.configurationId, requestKey: randomUUID() });
  const changed = new OrganizationConnections(s.first, s.access, s.transport, [{ ...config, accountId: '999999999999' }], () => 1_800_000_000_000);
  await assert.rejects(changed.status(session, connection.id), errorCode('connection_unavailable')); assert.equal(s.calls.length, 0);
  s.override(async () => ({ ok: true, result: { token: 'private-synthetic-token' } }));
  await assert.rejects(s.connections.status(session, connection.id), errorCode('invalid_worker_result'));
  await assert.rejects(s.connections.perform(session, connection.id, { requestKey: randomUUID(), operation: 'verify' }), errorCode('worker_request_uncertain'));
});

test('organization HTTP enforces Bearer membership and strict requests through the real registry/worker flow', async t => {
  const s = await fixture(t, true); const services = { access: s.access, connections: s.connections, publicOrigin: 'http://127.0.0.1' };
  const server = createOrganizationApiServer(services); server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => server.close());
  const address = server.address(); assert.ok(address && typeof address !== 'string'); const origin = `http://127.0.0.1:${address.port}`;
  services.publicOrigin = origin;
  for (const route of ['/api/state', '/api/aws/status', '/api/organization/sso/config']) assert.equal((await fetch(`${origin}${route}`)).status, 404);
  const base = `${origin}/api/organizations/v1/${config.organizationId}/workspaces/${config.workspaceId}/aws/connections`;
  const request = (path = '', body?: unknown, token = 'valid-a', headers: Record<string, string> = {}) => fetch(`${base}${path}`, { method: body ? 'POST' : 'GET', headers: { Origin: origin, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID(), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.equal((await request('', undefined, 'invalid', { Cookie: 'cloudops-aws=synthetic; cloudops-organization=synthetic', 'X-CloudOps-Role': 'admin' })).status, 401);
  assert.equal((await request('', undefined, 'valid-a', { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await request('', { configurationId: config.configurationId, actorId: 'other' })).status, 400);
  assert.equal((await request('?token=synthetic')).status, 400);
  const created = await request('', { configurationId: config.configurationId }); assert.equal(created.status, 200); const connection = await created.json();
  assert.equal((await request(`/${connection.id}/status`, undefined, 'valid-b')).status, 404);
  const login = await request(`/${connection.id}/actions`, { operation: 'login' }); assert.equal(login.status, 200);
  await nextTurn(); const status = await request(`/${connection.id}/status`); assert.equal(status.status, 200); assert.equal((await status.json()).status, 'connected');
  const result = await request(`/${connection.id}/actions`, { operation: 'inspect', service: 'lambda' }); assert.equal(result.status, 200); assert.equal((await result.json()).items[0].name, 'synthetic-resource');
  assert.deepEqual(connection.directory, { awsOrganizationId: 'o-synthetic1', parentId: 'r-demo' });
  assert.equal((await request(`/${connection.id}/actions`, { operation: 'directory', parentId: 'r-evil' })).status, 400);
  assert.equal((await request(`/${connection.id}/actions`, { operation: 'directory', service: 'lambda' })).status, 400);
  const directory = await request(`/${connection.id}/actions`, { operation: 'directory' }); assert.equal(directory.status, 200);
  const observation = await directory.json(); assert.equal(observation.accounts.status, 'collected'); assert.equal(observation.accounts.hasMore, true); assert.deepEqual(observation.accounts.items, []);
  assert.equal((await request(`/${connection.id}/actions`, { operation: 'verify', cursor: observation.accounts.nextCursor })).status, 400);
  const nextPage = await request(`/${connection.id}/actions`, { operation: 'directory', cursor: observation.accounts.nextCursor }); assert.equal(nextPage.status, 200);
  const nextObservation = await nextPage.json(); assert.equal(nextObservation.accounts.pageNumber, 2); assert.equal(nextObservation.accounts.hasMore, false);
  assert.ok(!JSON.stringify(nextObservation).includes('synthetic-next-token'));
  // Report history and saved views: owner-only reads; views change only by POST with the request key.
  assert.deepEqual(await (await request(`/${connection.id}/report`)).json(), { snapshots: [] });
  assert.equal((await request(`/${connection.id}/report`, { operation: 'save' })).status, 405);
  assert.equal((await request(`/${connection.id}/views/eks`)).status, 404);
  const savedView = await request(`/${connection.id}/views`, { operation: 'save', view: { name: 'Synthetic', page: 'ec2', accounts: [], regions: [], queries: {} } }); assert.equal(savedView.status, 200);
  assert.deepEqual((await (await request(`/${connection.id}/views`)).json()).items.map((item: { view: { name: string } }) => item.view.name), ['Synthetic']);
  assert.equal((await request(`/${connection.id}/views`, { operation: 'save', view: { name: 'x', page: 'shell', accounts: [], regions: [], queries: {} } })).status, 400);
  assert.equal((await request(`/${connection.id}/views`, undefined, 'valid-b')).status, 404);
  // Alert status is owner-only; without a notifications config the test message is refused and nothing is sent.
  assert.deepEqual(await (await request(`/${connection.id}/alerts`)).json(), { configured: false, recipients: [], history: [] });
  const notConfigured = await request(`/${connection.id}/alerts`, { operation: 'test' }); assert.equal(notConfigured.status, 409); assert.equal((await notConfigured.json()).code, 'alerts_not_configured');
  assert.equal((await request(`/${connection.id}/alerts`, { operation: 'send', to: 'x@example.invalid' })).status, 400, 'the browser cannot choose recipients or content');
  assert.equal((await request(`/${connection.id}/alerts`, undefined, 'valid-b')).status, 404);
  const logout = await request(`/${connection.id}/actions`, { operation: 'logout' }); assert.equal(logout.status, 200);
  assert.equal((await (await request(`/${connection.id}/status`)).json()).status, 'disconnected');
  s.revokeIdentity(); assert.equal((await request(`/${connection.id}/status`)).status, 401);
});


test('directory capability and changed parent are checked before dispatch, and replay requires current membership', async t => {
  const plain = await fixture(t), plainSession = await plain.session(), connection = await plain.connections.create(plainSession, { configurationId: config.configurationId, requestKey: randomUUID() });
  await assert.rejects(plain.connections.perform(plainSession, connection.id, { requestKey: randomUUID(), operation: 'directory' }), errorCode('directory_not_configured')); assert.equal(plain.calls.length, 0);
  const s = await fixture(t, true), session = await s.session(), own = await s.connections.create(session, { configurationId: config.configurationId, requestKey: randomUUID() });
  await s.connections.perform(session, own.id, { requestKey: randomUUID(), operation: 'verify' });
  const command = { requestKey: randomUUID(), operation: 'directory' }, snapshot = await s.connections.perform(session, own.id, command);
  assert.deepEqual(await s.otherConnections.perform(session, own.id, command), snapshot); assert.equal(s.calls.length, 2);
  const changed = new OrganizationConnections(s.first, s.access, s.transport, [{ ...config, directory: { awsOrganizationId: 'o-synthetic1', parentId: 'r-other' } }], () => 1_800_000_000_000);
  await assert.rejects(changed.perform(session, own.id, command), errorCode('connection_unavailable')); assert.equal(s.calls.length, 2);
  await s.provision('employee-a', false, 2); await assert.rejects(s.connections.perform(session, own.id, command), errorCode('organization_access_denied'));
});

test('a changed trusted configuration retires the stale connection and registers a new one instead of failing', async t => {
  const s = await fixture(t), session = await s.session();
  const first = await s.connections.create(session, { configurationId: 'aws-read', requestKey: randomUUID() });
  const changed = new OrganizationConnections(s.first, s.access, s.transport, [{ ...config, directory: { awsOrganizationId: 'o-synthetic1', parentId: 'r-demo' } }]);
  assert.deepEqual((await changed.list(session)).items, [], 'the stale binding is not shown');
  const second = await changed.create(session, { configurationId: 'aws-read', requestKey: randomUUID() });
  assert.notEqual(second.id, first.id); assert.deepEqual(second.directory, { awsOrganizationId: 'o-synthetic1', parentId: 'r-demo' });
  assert.deepEqual((await changed.list(session)).items.map(item => item.id), [second.id]);
  const stale = await s.first.transact(tx => tx.get<{ enabled: boolean }>(`organization-connection:${first.id}`));
  assert.equal(stale?.enabled, false, 'the stale connection is disabled so its worker authorization fails closed');
  const { configurationId: _id, label: _label, ...staleScope } = config;
  await assert.rejects(changed.workerAuthorization({ ...staleScope, actorId: session.identity.actorId, connectionId: first.id }), errorCode('connection_unavailable'));
  assert.equal((await changed.create(session, { configurationId: 'aws-read', requestKey: randomUUID() })).id, second.id, 'the current connection is reused');
});

test('read results are cached per owned connection on local disk and re-validated before they are served', async t => {
  const s = await fixture(t), session = await s.session(), other = await s.session('valid-b');
  const root = await mkdtemp(join(tmpdir(), 'cloudops-observations-')), cacheDir = join(root, 'observations');
  t.after(() => rm(root, { recursive: true, force: true }));
  const connections = new OrganizationConnections(s.first, s.access, s.transport, [config], Date.now, new FileObservationCache(cacheDir));
  const connection = await connections.create(session, { configurationId: 'aws-read', requestKey: randomUUID() });
  assert.deepEqual(await connections.observations(session, connection.id), { inventories: {} }, 'nothing cached yet and no worker is called');
  await connections.perform(session, connection.id, { requestKey: randomUUID(), operation: 'login' }); await nextTurn();
  await connections.perform(session, connection.id, { requestKey: randomUUID(), operation: 'inspect', service: 'lambda' });
  const calls = s.calls.length, cached = await connections.observations(session, connection.id) as { savedAt: string; inventories: { lambda?: { items: Array<{ name: string }> } } };
  assert.equal(cached.inventories.lambda?.items[0]?.name, 'synthetic-resource'); assert.ok(cached.savedAt);
  assert.equal(s.calls.length, calls, 'serving the cache never invokes the worker');
  await assert.rejects(connections.observations(other, connection.id), errorCode('connection_unavailable'));
  const [file] = await readdir(cacheDir);
  assert.equal((await stat(join(cacheDir, file!))).mode & 0o777, 0o600); assert.equal((await stat(cacheDir)).mode & 0o777, 0o700);
  const changed = new OrganizationConnections(s.first, s.access, s.transport, [{ ...config, directory: { awsOrganizationId: 'o-synthetic1', parentId: 'r-demo' } }], Date.now, new FileObservationCache(cacheDir));
  await assert.rejects(changed.observations(session, connection.id), errorCode('connection_unavailable'));
  const next = await changed.create(session, { configurationId: 'aws-read', requestKey: randomUUID() });
  assert.deepEqual(await changed.observations(session, next.id), { inventories: {} }, 'a changed binding never reuses the old cache entry');
});
