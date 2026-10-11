import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OrganizationWebAccess, identityActor } from '../../../apps/host/src/identity/web-access';
import { SqliteCloudStore } from '../../../apps/host/src/storage/sqlite-store';
import { OrganizationConnections, type OrganizationWorkerTransport } from '../../../apps/host/src/connections/connections';
import { FileObservationCache } from '../../../apps/host/src/connections/observation-cache';
import { EmailAlerts } from '../../../apps/host/src/notifications/email-alerts';
import type { MailMessage } from '../../../apps/host/src/notifications/smtp';
import { CloudOperationError } from '../../../packages/contracts/errors';
import type { InventoryUnit, SyncJob } from '../../../packages/contracts/aws/inventory';

const issuer = 'https://company.example.invalid';
const config = { configurationId: 'aws-read', label: 'Synthetic AWS', organizationId: 'synthetic-org', workspaceId: 'workspace-a', startUrl: 'https://synthetic-example.awsapps.com/start', ssoRegion: 'us-east-1', region: 'ap-northeast-2',
  accountId: '111111111111', roleName: 'ReadOnlyAccess', directory: { awsOrganizationId: 'o-synthetic1', parentId: 'r-demo' } };
const errorCode = (expected: string) => (error: unknown) => error instanceof CloudOperationError && error.code === expected;
const unit = (accountId: string, region: string, service: InventoryUnit['service'], names: string[]): InventoryUnit => ({ accountId, region, service, collectedAt: '2026-10-11T00:00:00.000Z', hasMore: false, items: names.map(name => ({ name })), source: 'direct' });

async function fixture(t: TestContext, options: { alerts?: (cache: FileObservationCache) => EmailAlerts } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'cloudops-sync-host-')), store = new SqliteCloudStore(join(directory, 'cloud.sqlite'));
  const identities = { async verify(token: string) { return { actorId: identityActor(issuer, token === 'valid-a' ? 'employee-a' : 'employee-b'), expiresAt: 1_800_003_600_000 }; } };
  const access = new OrganizationWebAccess(identities, store, () => 1_800_000_000_000);
  for (const subject of ['employee-a', 'employee-b']) await access.provision({ organizationId: config.organizationId, workspaceId: config.workspaceId, actorId: identityActor(issuer, subject), active: true, roles: ['viewer'], version: 1, updatedAt: '2026-10-11T00:00:00.000Z' });
  // A synthetic worker job: the transport plays the worker side of the private protocol.
  let job: SyncJob | undefined; const units = new Map<string, InventoryUnit>(); const fetched: string[] = []; let tamper = false;
  const transport: OrganizationWorkerTransport = { async invoke(binding, command) {
    if (command.operation === 'sync') {
      job = { connectionId: binding.connectionId, jobId: randomUUID(), mode: 'direct', state: 'running', startedAt: '2026-10-11T00:00:00.000Z', progress: { done: 0, total: 3 }, accounts: [
        { accountId: '111111111111', access: 'verified', regions: [], candidateRegions: 2 }, { accountId: '222222222222', name: 'Workload', lifecycle: 'ACTIVE', access: 'verified', regions: [{ region: 'eu-west-1', vpcs: 2, taggedVpcs: 1 }], candidateRegions: 2 }], units: [] };
      return { ok: true, result: job };
    }
    if (command.operation === 'sync-status') return job ? { ok: true, result: job } : { ok: false, code: 'sync_not_found' };
    if (command.operation === 'sync-unit') {
      fetched.push(command.unit!); const value = units.get(command.unit!);
      return value ? { ok: true, result: { connectionId: binding.connectionId, jobId: job!.jobId, unitId: command.unit, unit: tamper ? { ...value, accountId: '999999999999' } : value } } : { ok: false, code: 'sync_unit_not_found' };
    }
    return { ok: false, code: 'unsupported' };
  } };
  const cache = new FileObservationCache(join(directory, 'observations'));
  const connections = new OrganizationConnections(store, access, transport, [config], () => 1_800_000_000_000, cache, options.alerts?.(cache));
  t.after(async () => { await connections.close(); store.close(); await rm(directory, { recursive: true, force: true }); });
  const add = (value: InventoryUnit) => { const id = randomUUID(); units.set(id, value); job!.units.push({ id, accountId: value.accountId, region: value.region, service: value.service, count: value.items.length }); return id; };
  return { connections, cache, directory, fetched, add, job: () => job!, tamper: () => { tamper = true; },
    session: (token = 'valid-a') => access.authenticate(`Bearer ${token}`, config.organizationId, config.workspaceId) };
}

test('host fetches finished sync units into the per-user disk cache and serves them without a worker', async t => {
  const s = await fixture(t), session = await s.session();
  const connection = await s.connections.create(session, { configurationId: 'aws-read', requestKey: randomUUID() });
  await assert.rejects(s.connections.syncStatus(session, connection.id), errorCode('sync_not_found'));
  const started = await s.connections.perform(session, connection.id, { requestKey: randomUUID(), operation: 'sync' }) as { state: string; cachedUnits: number; live: boolean };
  assert.deepEqual([started.state, started.cachedUnits, started.live], ['running', 0, true]);
  s.add(unit('111111111111', 'ap-northeast-2', 'ec2', ['payer-web'])); s.add(unit('222222222222', 'eu-west-1', 'ec2', ['member-web', 'member-batch']));
  const progress = await s.connections.syncStatus(session, connection.id);
  assert.equal(progress.cachedUnits, 2); assert.equal(progress.live, true); assert.ok(!('units' in progress), 'the browser never receives unit references');
  const again = await s.connections.syncStatus(session, connection.id);
  assert.equal(again.cachedUnits, 2); assert.equal(s.fetched.length, 2, 'already cached units are not fetched again');
  const inventory = await s.connections.inventory(session, connection.id, 'ec2');
  assert.deepEqual(inventory.units.map(value => `${value.accountId}:${value.region}:${value.items.map(item => item.name).join(',')}`), ['111111111111:ap-northeast-2:payer-web', '222222222222:eu-west-1:member-web,member-batch']);
  assert.equal((await s.connections.inventory(session, connection.id, 'all')).units.length, 2);
  await assert.rejects(s.connections.inventory(session, connection.id, 'shell'));
  // Another user cannot see this connection's progress or inventory.
  const other = await s.session('valid-b');
  await assert.rejects(s.connections.syncStatus(other, connection.id), errorCode('connection_unavailable'));
  await assert.rejects(s.connections.inventory(other, connection.id, 'ec2'), errorCode('connection_unavailable'));
  // Cache files are private and the summary survives without a worker (served from disk, not live).
  const root = join(s.directory, 'observations'), entries = await readdir(root);
  assert.equal((await stat(root)).mode & 0o777, 0o700);
  for (const entry of entries) assert.equal((await stat(join(root, entry))).mode & 0o777, entry.endsWith('.units') ? 0o700 : 0o600);
  const observations = await s.connections.observations(session, connection.id) as { sync?: { live: boolean; cachedUnits: number } };
  assert.deepEqual([observations.sync?.live, observations.sync?.cachedUnits], [false, 2]);
});

test('a completed sync prunes units it no longer produced; a unit that does not match its reference is refused', async t => {
  const s = await fixture(t), session = await s.session();
  const connection = await s.connections.create(session, { configurationId: 'aws-read', requestKey: randomUUID() });
  await s.connections.perform(session, connection.id, { requestKey: randomUUID(), operation: 'sync' });
  s.add(unit('222222222222', 'eu-west-1', 'rds', ['old-db'])); await s.connections.syncStatus(session, connection.id);
  // A new sync no longer sees that region (no tagged VPC) and completes.
  await s.connections.perform(session, connection.id, { requestKey: randomUUID(), operation: 'sync' });
  s.add(unit('111111111111', 'ap-northeast-2', 'rds', ['payer-db'])); s.job().state = 'completed';
  await s.connections.syncStatus(session, connection.id);
  assert.deepEqual((await s.connections.inventory(session, connection.id, 'rds')).units.map(value => value.accountId), ['111111111111']);
  await s.connections.perform(session, connection.id, { requestKey: randomUUID(), operation: 'sync' });
  s.add(unit('222222222222', 'eu-west-1', 'ec2', ['x'])); s.tamper();
  await assert.rejects(s.connections.syncStatus(session, connection.id), errorCode('invalid_worker_result'));
  assert.deepEqual((await s.connections.inventory(session, connection.id, 'ec2')).units, []);
});

test('a finished sync records one assessment snapshot per job for the trend report (owner only, from that job\'s units)', async t => {
  const s = await fixture(t), session = await s.session(), finishedAt = new Date(1_800_000_000_000 - 3_600_000).toISOString();
  const connection = await s.connections.create(session, { configurationId: 'aws-read', requestKey: randomUUID() });
  assert.deepEqual(await s.connections.report(session, connection.id), { snapshots: [] });
  await s.connections.perform(session, connection.id, { requestKey: randomUUID(), operation: 'sync' });
  s.add({ ...unit('222222222222', 'eu-west-1', 'alarms', []), items: [{ name: 'cpu-high', state: 'ALARM' }] });
  // A running job is not assessed yet.
  await s.connections.syncStatus(session, connection.id);
  assert.equal((await s.connections.report(session, connection.id)).snapshots.length, 0);
  Object.assign(s.job(), { state: 'completed', finishedAt });
  const done = await s.connections.syncStatus(session, connection.id);
  assert.equal(done.remaining, 0);
  const first = (await s.connections.report(session, connection.id)).snapshots;
  assert.equal(first.length, 1); assert.equal(first[0]!.jobId, s.job().jobId); assert.equal(first[0]!.at, finishedAt);
  assert.deepEqual(first[0]!.counts, { critical: 1, warning: 0, info: 0 }); assert.deepEqual(first[0]!.verified, ['111111111111', '222222222222']);
  assert.equal(first[0]!.findings[0]!.id, 'alarm:222222222222:eu-west-1:cpu-high'); assert.ok(!('link' in first[0]!.findings[0]!), 'console links are not stored');
  await s.connections.syncStatus(session, connection.id);
  assert.equal((await s.connections.report(session, connection.id)).snapshots.length, 1, 'one snapshot per job');
  // The next sync only counts its own units (the old alarm unit is not reused), and partial jobs are recorded too.
  await s.connections.perform(session, connection.id, { requestKey: randomUUID(), operation: 'sync' });
  s.add({ ...unit('222222222222', 'eu-west-1', 'alarms', []), items: [{ name: 'cpu-high', state: 'OK' }] }); s.add({ ...unit('111111111111', 'ap-northeast-2', 'rds', []), code: 'read_access_denied' });
  Object.assign(s.job(), { state: 'partial', finishedAt: new Date(1_800_000_000_000 - 60_000).toISOString() });
  await s.connections.syncStatus(session, connection.id);
  const both = (await s.connections.report(session, connection.id)).snapshots;
  assert.deepEqual(both.map(item => [item.state, item.counts.critical, item.counts.info]), [['completed', 1, 0], ['partial', 0, 1]]);
  await assert.rejects(s.connections.report(await s.session('valid-b'), connection.id), errorCode('connection_unavailable'));
});

test('saved views are per-user server settings: upsert by name, idempotent requests, bounded and page-scoped', async t => {
  const s = await fixture(t), session = await s.session(), other = await s.session('valid-b');
  const connection = await s.connections.create(session, { configurationId: 'aws-read', requestKey: randomUUID() });
  assert.deepEqual(await s.connections.views(session, connection.id), { items: [] });
  const view = { name: 'Prod EKS', page: 'eks', accounts: ['222222222222'], regions: ['eu-west-1'], queries: { 'eks.eks': { operation: 'and', tokens: [{ propertyKey: 'support', operator: '=', value: 'EXTENDED_SUPPORT' }] } } };
  const key = randomUUID(), saved = await s.connections.updateViews(session, connection.id, { requestKey: key, operation: 'save', view });
  assert.equal(saved.items.length, 1); assert.equal(saved.items[0]!.view.name, 'Prod EKS');
  assert.deepEqual(await s.connections.updateViews(session, connection.id, { requestKey: key, operation: 'save', view }), saved, 'a retried request returns the same list');
  await assert.rejects(s.connections.updateViews(session, connection.id, { requestKey: key, operation: 'delete', id: saved.items[0]!.id }), errorCode('request_key_conflict'));
  const ec2 = await s.connections.updateViews(session, connection.id, { requestKey: randomUUID(), operation: 'save', view: { ...view, name: 'EC2 batch', page: 'ec2', queries: { 'ec2.ec2': { operation: 'and', tokens: [{ operator: ':', value: 'batch' }] } } } });
  assert.deepEqual(ec2.items.map(item => item.view.name), ['EC2 batch', 'Prod EKS'], 'table ids may contain digits (ec2.ec2)');
  await s.connections.updateViews(session, connection.id, { requestKey: randomUUID(), operation: 'delete', id: ec2.items[0]!.id });
  const replaced = await s.connections.updateViews(session, connection.id, { requestKey: randomUUID(), operation: 'save', view: { ...view, page: 'rds', queries: {} } });
  assert.deepEqual(replaced.items.map(item => [item.id, item.view.page]), [[saved.items[0]!.id, 'rds']], 'the same name replaces the view and keeps its id');
  await assert.rejects(s.connections.updateViews(session, connection.id, { requestKey: randomUUID(), operation: 'save', view: { ...view, page: 'rds' } }), 'conditions of another page are refused');
  await assert.rejects(s.connections.updateViews(session, connection.id, { requestKey: randomUUID(), operation: 'save', view: { ...view, accounts: ['not-an-account'] } }));
  // Another user can neither read nor change this user's views through this connection, and has an empty list for their own.
  await assert.rejects(s.connections.views(other, connection.id), errorCode('connection_unavailable'));
  const own = await s.connections.create(other, { configurationId: 'aws-read', requestKey: randomUUID() });
  assert.deepEqual(await s.connections.views(other, own.id), { items: [] });
  for (let index = 1; index < 30; index++) await s.connections.updateViews(session, connection.id, { requestKey: randomUUID(), operation: 'save', view: { ...view, name: `View ${index}`, queries: {} } });
  await assert.rejects(s.connections.updateViews(session, connection.id, { requestKey: randomUUID(), operation: 'save', view: { ...view, name: 'One too many', queries: {} } }), errorCode('view_limit'));
  const removed = await s.connections.updateViews(session, connection.id, { requestKey: randomUUID(), operation: 'delete', id: saved.items[0]!.id });
  assert.equal(removed.items.length, 29); assert.ok(!removed.items.some(item => item.id === saved.items[0]!.id));
});

test('after a sync starts the host drains its results without the browser, records the snapshot and sends the alert once', async t => {
  const mails: MailMessage[] = [];
  const s = await fixture(t, { alerts: cache => new EmailAlerts({ cache, labels: new Map([['aws-read', 'Synthetic AWS']]), publicOrigin: 'http://127.0.0.1:5176', now: () => 1_800_000_000_000, send: async message => { mails.push(message); },
    config: { from: 'alerts@example.invalid', smtp: { host: 'smtp.example.invalid', port: 465, security: 'tls', username: 'alerts@example.invalid', passwordFile: '/synthetic/password' }, routes: [{ configurationId: 'aws-read', to: ['ops@example.invalid'] }] } }) });
  const session = await s.session(), connection = await s.connections.create(session, { configurationId: 'aws-read', requestKey: randomUUID() });
  s.connections.followIntervalMs = 10;
  await s.connections.perform(session, connection.id, { requestKey: randomUUID(), operation: 'sync' });
  s.add(unit('111111111111', 'ap-northeast-2', 'alarms', [])); s.add(unit('222222222222', 'eu-west-1', 'ec2', ['member-web']));
  Object.assign(s.job(), { state: 'completed', finishedAt: new Date(1_800_000_000_000 - 60_000).toISOString() });
  // No syncStatus call: nobody keeps the page open.
  for (let wait = 0; wait < 200 && !mails.length; wait += 1) await new Promise(resolve => setTimeout(resolve, 10));
  await s.connections.idle();
  assert.equal(s.fetched.length, 2, 'every finished unit was fetched by the host');
  assert.equal((await s.connections.inventory(session, connection.id, 'all')).units.length, 2);
  assert.equal((await s.connections.report(session, connection.id)).snapshots.length, 1);
  assert.equal(mails.length, 1); assert.match(mails[0]!.subject, /Synthetic AWS/);
  const status = await s.connections.alerts(session, connection.id);
  assert.deepEqual([status.configured, status.recipients, status.history.map(event => [event.kind, event.outcome])], [true, ['o•••@example.invalid'], [['baseline', 'sent']]]);
  // The browser's poll after the fact finds the job done and sends nothing again.
  const summary = await s.connections.syncStatus(session, connection.id); await s.connections.idle();
  assert.deepEqual([summary.remaining, mails.length], [0, 1]);
  await assert.rejects(s.connections.alerts(await s.session('valid-b'), connection.id), errorCode('connection_unavailable'), 'another user cannot read the alert status');
});
