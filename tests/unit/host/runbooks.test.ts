import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OrganizationWebAccess, identityActor } from '../../../apps/host/src/identity/web-access';
import { SqliteCloudStore } from '../../../apps/host/src/storage/sqlite-store';
import { OrganizationConnections, type OrganizationWorkerTransport } from '../../../apps/host/src/connections/connections';
import { FileObservationCache } from '../../../apps/host/src/connections/observation-cache';
import { RunbookService } from '../../../apps/host/src/runbooks/runbooks';
import { CloudOperationError } from '../../../packages/contracts/errors';

const issuer = 'https://company.example.invalid';
const config = { configurationId: 'aws-read', label: 'Synthetic AWS', organizationId: 'synthetic-org', workspaceId: 'workspace-a', startUrl: 'https://synthetic-example.awsapps.com/start', ssoRegion: 'us-east-1',
  region: 'ap-northeast-2', accountId: '111111111111', roleName: 'ReadOnlyAccess', runbooks: { roleName: 'RunbookOperator', allowed: ['connectivity-check', 'ec2-restart'] } };
const executionId = '0d0d0d0d-1111-4222-8333-444444444444';
const code = (expected: string) => (error: unknown) => error instanceof CloudOperationError && error.code === expected;
const instance = { accountId: '111111111111', region: 'ap-northeast-2', instanceId: 'i-0123456789abcdef0' };

async function fixture(t: TestContext, policy: unknown = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'cloudops-runbooks-')), store = new SqliteCloudStore(join(directory, 'cloud.sqlite'));
  const identities = { async verify(token: string) { return { actorId: identityActor(issuer, token), expiresAt: 1_800_003_600_000 }; } };
  const access = new OrganizationWebAccess(identities, store, () => 1_800_000_000_000);
  const roles: Record<string, string[]> = { requester: ['viewer', 'operator'], reviewer: ['viewer', 'reviewer'], watcher: ['viewer'], lead: ['viewer', 'operator', 'reviewer'] };
  for (const [subject, list] of Object.entries(roles)) await access.provision({ organizationId: config.organizationId, workspaceId: config.workspaceId, actorId: identityActor(issuer, subject), active: true, roles: list, version: 1, updatedAt: '2026-10-11T00:00:00.000Z' });
  const worker = { busy: false, lose: false, status: 'InProgress', starts: 0 };
  const transport: OrganizationWorkerTransport = { async invoke(binding, command) {
    if (command.operation === 'status') return { ok: true, result: { connectionId: binding.connectionId, accountId: binding.accountId, roleName: binding.roleName, region: binding.region, status: 'connected' } };
    if (command.operation === 'runbook-start') {
      if (worker.lose) throw new Error('reply lost');
      if (worker.busy) return { ok: false, code: 'connection_busy' };
      worker.starts += 1; return { ok: true, result: { executionId } };
    }
    if (command.operation === 'runbook-status') return { ok: true, result: { executionId, status: worker.status } };
    return { ok: false, code: 'unsupported' };
  } };
  const cache = new FileObservationCache(join(directory, 'observations'));
  const connections = new OrganizationConnections(store, access, transport, [config, { ...config, configurationId: 'aws-read-only', runbooks: undefined }], () => 1_800_000_000_000, cache);
  const runbooks = new RunbookService(store, connections, policy, () => 1_800_000_000_000);
  t.after(async () => { runbooks.close(); await connections.close(); store.close(); await rm(directory, { recursive: true, force: true }); });
  const member = async (subject: string, configurationId = 'aws-read') => {
    const session = await access.authenticate(`Bearer ${subject}`, config.organizationId, config.workspaceId);
    const connection = await connections.create(session, { configurationId, requestKey: randomUUID() });
    const send = (command: Record<string, unknown>, requestKey = randomUUID()) => runbooks.command(session, connection.id, { ...command, requestKey });
    return { session, connection, send, state: () => runbooks.state(session, connection.id) };
  };
  const synced = async (who: Awaited<ReturnType<typeof member>>) => {
    const { scope } = await connections.ownedConnection(who.session, who.connection.id);
    await cache.saveUnit(scope, `${instance.accountId}|${instance.region}|ec2`, 'job', { accountId: instance.accountId, region: instance.region, service: 'ec2', collectedAt: '2026-10-11T00:00:00.000Z', hasMore: false, source: 'direct',
      items: [{ id: instance.instanceId, name: 'synthetic-web', state: 'running' }] });
  };
  return { member, synced, worker, runbooks };
}
const restart = { operation: 'request', runbook: 'ec2-restart', target: instance, reason: 'Synthetic memory leak after deploy' };

test('roles, synced targets, idempotent requests and two-person approval', async t => {
  const s = await fixture(t), requester = await s.member('requester'), reviewer = await s.member('reviewer'), watcher = await s.member('watcher');
  assert.deepEqual((({ enabled, allowed, canRequest, canApprove, selfApproval }) => ({ enabled, allowed, canRequest, canApprove, selfApproval }))(await requester.state()),
    { enabled: true, allowed: ['connectivity-check', 'ec2-restart'], canRequest: true, canApprove: false, selfApproval: false });
  await assert.rejects(watcher.send(restart), code('runbook_operator_required'));
  await assert.rejects(requester.send(restart), code('runbook_target_not_synced'), 'only instances from the requester’s own sync');
  await assert.rejects(requester.send({ ...restart, runbook: 'ec2-stop' }), code('runbook_not_allowed'));
  await assert.rejects(requester.send({ operation: 'request', runbook: 'connectivity-check', target: { accountId: '111111111111', region: 'us-east-1' }, reason: 'Synthetic check' }), code('invalid_runbook_target'));
  await s.synced(requester);
  const key = randomUUID(), first = await requester.send(restart, key), again = await requester.send(restart, key);
  assert.equal(first.requests.length, 1); assert.equal(again.requests.length, 1, 'a retried request key does not create a second request');
  await assert.rejects(requester.send({ ...restart, reason: 'Different body' }, key), code('request_key_conflict'));
  const request = first.requests[0]!;
  assert.deepEqual([request.state, request.target.name, request.requester.self], ['pending', 'synthetic-web', true]);
  assert.equal((await watcher.state()).requests[0]!.requester.self, false, 'the team sees the same queue');
  await assert.rejects(requester.send({ operation: 'approve', requestId: request.id }), code('runbook_reviewer_required'));
  await assert.rejects(reviewer.send({ operation: 'execute', requestId: request.id }), code('runbook_operator_required'));
  const approved = await reviewer.send({ operation: 'approve', requestId: request.id, note: 'Synthetic change window' });
  assert.deepEqual([approved.requests[0]!.state, approved.requests[0]!.decision?.approved, approved.requests[0]!.decision?.by.self], ['approved', true, true]);
  await assert.rejects(reviewer.send({ operation: 'reject', requestId: request.id }), code('runbook_request_not_pending'));
  const other = await s.member('requester', 'aws-read-only');
  assert.deepEqual([(await other.state()).enabled, (await other.state()).requests.length], [false, 0], 'another payer configuration has its own queue and no runbooks');
});

test('execution by the requester, status followed to the end, busy and lost starts handled without retries', async t => {
  const s = await fixture(t), me = await s.member('requester'), reviewer = await s.member('reviewer');
  await s.synced(me);
  const check = { operation: 'request', runbook: 'connectivity-check', target: { accountId: '111111111111', region: 'ap-northeast-2' }, reason: 'Synthetic permission check' };
  const pending = (await me.send(check)).requests[0]!;
  await assert.rejects(me.send({ operation: 'execute', requestId: pending.id }), code('runbook_request_not_approved'));
  await reviewer.send({ operation: 'approve', requestId: pending.id });
  s.worker.busy = true;
  await assert.rejects(me.send({ operation: 'execute', requestId: pending.id }), code('connection_busy'));
  assert.equal((await me.state()).requests[0]!.state, 'approved', 'a busy worker started nothing; the request stays runnable');
  s.worker.busy = false;
  const running = (await me.send({ operation: 'execute', requestId: pending.id })).requests[0]!;
  assert.deepEqual([running.state, running.execution?.executionId, s.worker.starts], ['running', executionId, 1]);
  s.worker.status = 'Success';
  const done = (await reviewer.send({ operation: 'refresh', requestId: pending.id })).requests[0]!;
  assert.equal(done.state, 'succeeded');
  assert.deepEqual(done.events.map(event => event.action), ['requested', 'approved', 'starting', 'start-busy', 'starting', 'started', 'succeeded']);
  const lost = (await me.send({ ...restart, reason: 'Synthetic restart after leak' })).requests[0]!;
  await reviewer.send({ operation: 'approve', requestId: lost.id });
  s.worker.lose = true;
  await assert.rejects(me.send({ operation: 'execute', requestId: lost.id }), code('runbook_start_unknown'));
  assert.equal((await me.state()).requests.find(item => item.id === lost.id)!.state, 'unknown', 'a lost start reply is never retried');
  await assert.rejects(me.send({ operation: 'execute', requestId: lost.id }), code('runbook_request_not_approved'));
  assert.equal(s.worker.starts, 1);
});

test('self-approval needs both the server policy and the reviewer role', async t => {
  const strict = await fixture(t), lead = await strict.member('lead');
  const own = (await lead.send({ operation: 'request', runbook: 'connectivity-check', target: { accountId: '111111111111', region: 'ap-northeast-2' }, reason: 'Synthetic own request' })).requests[0]!;
  await assert.rejects(lead.send({ operation: 'approve', requestId: own.id }), code('self_approval_not_allowed'));
  const relaxed = await fixture(t, { allowSelfApproval: true }), single = await relaxed.member('lead'), operator = await relaxed.member('requester');
  const mine = (await single.send({ operation: 'request', runbook: 'connectivity-check', target: { accountId: '111111111111', region: 'ap-northeast-2' }, reason: 'Synthetic single operator' })).requests[0]!;
  assert.equal((await single.send({ operation: 'approve', requestId: mine.id })).requests[0]!.state, 'approved');
  assert.equal((await single.state()).selfApproval, true);
  const theirs = (await operator.send({ operation: 'request', runbook: 'connectivity-check', target: { accountId: '111111111111', region: 'ap-northeast-2' }, reason: 'Synthetic operator only' })).requests[0]!;
  await assert.rejects(operator.send({ operation: 'approve', requestId: theirs.id }), code('runbook_reviewer_required'));
  await assert.rejects(operator.send({ operation: 'cancel', requestId: mine.id }), code('runbook_requester_required'));
  assert.equal((await operator.send({ operation: 'cancel', requestId: theirs.id })).requests.find(item => item.id === theirs.id)!.state, 'cancelled');
});
