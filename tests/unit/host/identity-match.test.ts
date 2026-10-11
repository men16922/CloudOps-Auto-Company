import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OrganizationWebAccess, identityActor } from '../../../apps/host/src/identity/web-access';
import { SqliteCloudStore } from '../../../apps/host/src/storage/sqlite-store';
import { OrganizationConnections, type OrganizationWorkerTransport } from '../../../apps/host/src/connections/connections';
import { CloudOperationError } from '../../../packages/contracts/errors';
import type { CliBinding } from '../../../packages/worker-protocol/cli-contract';

// Synthetic identities and an in-memory transport only: no IdP, AWS CLI or Docker.
const issuer = 'https://company.example.invalid';
const config = { configurationId: 'aws-read', label: 'Synthetic AWS', organizationId: 'synthetic-org', workspaceId: 'workspace-a', startUrl: 'https://synthetic-example.awsapps.com/start', ssoRegion: 'us-east-1',
  region: 'ap-northeast-2', accountId: '111111111111', roleName: 'ReadOnlyAccess' };
const code = (expected: string) => (error: unknown) => error instanceof CloudOperationError && error.code === expected;

async function fixture(t: TestContext, identityPolicy: unknown, loginNames: Record<string, string | undefined>) {
  const directory = await mkdtemp(join(tmpdir(), 'cloudops-identity-match-')), store = new SqliteCloudStore(join(directory, 'cloud.sqlite'));
  const identities = { async verify(token: string) { return { actorId: identityActor(issuer, token), expiresAt: 1_800_003_600_000, ...(loginNames[token] ? { loginName: loginNames[token] } : {}) }; } };
  const access = new OrganizationWebAccess(identities, store, () => 1_800_000_000_000);
  for (const subject of Object.keys(loginNames)) await access.provision({ organizationId: config.organizationId, workspaceId: config.workspaceId, actorId: identityActor(issuer, subject), active: true, roles: ['viewer', 'operator'], version: 1, updatedAt: '2026-10-11T00:00:00.000Z' });
  const seen: CliBinding[] = [];
  const transport: OrganizationWorkerTransport = { async invoke(binding) { seen.push(binding); return { ok: true, result: { connectionId: binding.connectionId, accountId: binding.accountId, roleName: binding.roleName, region: binding.region, status: 'connected' } }; } };
  const connections = new OrganizationConnections(store, access, transport, [config], () => 1_800_000_000_000, undefined, { identityPolicy });
  t.after(async () => { await connections.close(); store.close(); await rm(directory, { recursive: true, force: true }); });
  const session = (subject: string) => access.authenticate(`Bearer ${subject}`, config.organizationId, config.workspaceId);
  return { connections, session, seen };
}

test('policy off: no login name goes into the binding and nothing changes', async t => {
  const s = await fixture(t, undefined, { 'employee-a': 'employee-a@example.invalid' });
  const session = await s.session('employee-a'), connection = await s.connections.create(session, { configurationId: 'aws-read', requestKey: randomUUID() });
  await s.connections.status(session, connection.id);
  assert.ok(s.seen.length > 0); assert.ok(s.seen.every(binding => !('loginName' in binding)));
});

test('policy on: the verified login name is part of the server-built binding; a login without a name cannot create a connection', async t => {
  const s = await fixture(t, { requireLoginNameMatch: true }, { 'employee-a': 'employee-a@example.invalid', 'employee-nameless': undefined });
  const session = await s.session('employee-a'), connection = await s.connections.create(session, { configurationId: 'aws-read', requestKey: randomUUID() });
  await s.connections.status(session, connection.id);
  assert.ok(s.seen.length > 0); assert.ok(s.seen.every(binding => binding.loginName === 'employee-a@example.invalid'));
  // The supervisor's own authorization of this exact binding (before it creates a worker) must accept it, and refuse a binding with another name.
  await s.connections.workerAuthorization(s.seen[0]);
  await assert.rejects(s.connections.workerAuthorization({ ...s.seen[0]!, loginName: 'employee-b@example.invalid' }), code('connection_unavailable'));
  const { loginName: _removed, ...withoutName } = s.seen[0]!;
  await assert.rejects(s.connections.workerAuthorization(withoutName), code('connection_unavailable'));
  const nameless = await s.session('employee-nameless');
  await assert.rejects(s.connections.create(nameless, { configurationId: 'aws-read', requestKey: randomUUID() }), code('web_login_name_missing'));
});

test('policy on: a connection stored before the policy (no login name in its binding) is unavailable instead of silently skipping the match', async t => {
  const before = await fixture(t, undefined, { 'employee-a': 'employee-a@example.invalid' });
  // Same store, policy switched on afterwards: rebuild the manager over the existing records.
  const session = await before.session('employee-a'), connection = await before.connections.create(session, { configurationId: 'aws-read', requestKey: randomUUID() });
  const strict = new OrganizationConnections((before.connections as unknown as { store: SqliteCloudStore }).store, (before.connections as unknown as { access: OrganizationWebAccess }).access,
    { async invoke() { return { ok: false as const, code: 'unsupported' }; } }, [config], () => 1_800_000_000_000, undefined, { identityPolicy: { requireLoginNameMatch: true } });
  t.after(async () => { await strict.close(); });
  await assert.rejects(strict.status(session, connection.id), code('connection_unavailable'));
});
