import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { OrganizationWorkerRouter } from './modules/aws/organization/organization-worker-router';
import { OrganizationCliWorker } from './modules/aws/organization/organization-cli-worker';
import { serveCliWorker } from './modules/aws/organization/organization-cli-protocol';
import type { CliBinding } from './modules/aws/organization/organization-cli-contract';
import { directorySnapshotSchema } from '../src/modules/aws/domain/directory';
import { CloudOperationError } from '../src/domain/cloud-workflow';

const binding: CliBinding = { connectionId: '44444444-4444-4444-8444-444444444444', organizationId: 'synthetic-org', workspaceId: 'workspace-a', actorId: 'actor-a', startUrl: 'https://synthetic-example.awsapps.com/start', ssoRegion: 'us-east-1', region: 'ap-northeast-2', accountId: '123456789012', roleName: 'ReadOnlyAccess' };
const unavailable = (error: unknown) => error instanceof CloudOperationError && error.code === 'worker_unavailable';
function workerPipe(owner: CliBinding) {
  const input = new PassThrough(), output = new PassThrough(); let calls = 0, stops = 0;
  const worker = new OrganizationCliWorker(owner, { run: async (operation, _signal, _output, input) => { calls++; const query = input && 'parentId' in input ? input : undefined;
    if (operation === 'directory-organization') return { stdout: JSON.stringify({ Id: owner.directory!.awsOrganizationId, MasterAccountId: owner.accountId }) };
    if (operation === 'directory-parent') return { stdout: JSON.stringify({ Items: [{ Id: 'r-demo', Name: 'Synthetic root', Arn: `arn:aws:organizations::${owner.accountId}:root/${owner.directory!.awsOrganizationId}/r-demo` }], HasMore: false }) };
    if (operation === 'directory-accounts') return { stdout: JSON.stringify({ Items: [], HasMore: !query?.nextToken, NextToken: query?.nextToken ? null : 'private-synthetic-page-token' }) };
    if (operation === 'directory-ous') return { stdout: JSON.stringify({ Items: [], HasMore: false }) };
    return { stdout: JSON.stringify({ Account: owner.accountId, Arn: `arn:aws:sts::${owner.accountId}:assumed-role/AWSReservedSSO_${owner.roleName}_0123456789abcdef/synthetic-session`, UserId: `SYNTHETIC:${owner.actorId}` }) }; } });
  const serving = serveCliWorker(worker, input, output);
  return { input, output, serving, calls: () => calls, stops: () => stops, stop: async () => { stops++; input.end(); await serving; output.destroy(); } };
}
test('router verifies the full binding before routing private commands and isolates disconnects across users', async t => {
  const router = new OrganizationWorkerRouter(), a = workerPipe(binding), other = { ...binding, connectionId: '55555555-5555-4555-8555-555555555555', actorId: 'actor-b' }, b = workerPipe(other);
  t.after(async () => { router.close(); await Promise.all([a.serving, b.serving]); });
  await router.attach(binding, a.input, a.output, a.stop); await router.attach(other, b.input, b.output, b.stop);
  await assert.rejects(router.invoke({ ...binding, actorId: 'actor-b' }, { id: randomUUID(), operation: 'verify' }, new AbortController().signal), unavailable);
  assert.equal(a.calls(), 0);
  assert.equal((await router.invoke(binding, { id: randomUUID(), operation: 'verify' }, new AbortController().signal)).ok, true); assert.equal(a.calls(), 1);
  router.detach(binding); await nextTurn(); assert.equal(a.stops(), 1); assert.equal(b.stops(), 0);
  assert.equal((await router.invoke(other, { id: randomUUID(), operation: 'verify' }, new AbortController().signal)).ok, true);
  await assert.rejects(router.invoke(binding, { id: randomUUID(), operation: 'status' }, new AbortController().signal), unavailable);
});

test('a mismatched worker with identical account/connection IDs is rejected before any AWS operation', async () => {
  const router = new OrganizationWorkerRouter(), wrong = workerPipe({ ...binding, actorId: 'wrong-user' });
  await assert.rejects(router.attach(binding, wrong.input, wrong.output, wrong.stop), unavailable);
  await wrong.serving; assert.equal(wrong.calls(), 0); assert.equal(wrong.stops(), 1); router.close();
});

test('controller cancellation drops late replies and malformed worker output closes the owned channel', async t => {
  const router = new OrganizationWorkerRouter(), worker = workerPipe(binding);
  t.after(async () => { router.close(); await worker.serving; });
  await router.attach(binding, worker.input, worker.output, worker.stop);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(router.invoke(binding, { id: randomUUID(), operation: 'verify' }, abort.signal), unavailable); assert.equal(worker.calls(), 0);
  worker.output.write('not a protocol response\n'); await nextTurn();
  await assert.rejects(router.invoke(binding, { id: randomUUID(), operation: 'status' }, new AbortController().signal), unavailable); assert.equal(worker.stops(), 1);
});


test('private router and protocol carry opaque directory cursors and replay without repeating CLI reads', async t => {
  const owner = { ...binding, directory: { awsOrganizationId: 'o-synthetic1', parentId: 'r-demo' } }, router = new OrganizationWorkerRouter(), worker = workerPipe(owner);
  t.after(async () => { router.close(); await worker.serving; }); await router.attach(owner, worker.input, worker.output, worker.stop);
  const invoke = (operation: 'verify' | 'directory', cursor?: string, id = randomUUID()) => router.invoke(owner, { id, operation, ...(cursor ? { cursor } : {}) }, new AbortController().signal);
  assert.equal((await invoke('verify')).ok, true); const rootReply = await invoke('directory'); assert.equal(rootReply.ok, true); if (!rootReply.ok) assert.fail();
  const root = directorySnapshotSchema.parse(rootReply.result); if (root.accounts.status !== 'collected') assert.fail(); assert.ok(root.accounts.nextCursor);
  assert.ok(!JSON.stringify(rootReply).includes('private-synthetic-page-token'));
  const id = randomUUID(), nextReply = await invoke('directory', root.accounts.nextCursor, id); assert.equal(nextReply.ok, true); if (!nextReply.ok) assert.fail();
  const next = directorySnapshotSchema.parse(nextReply.result); if (next.accounts.status !== 'collected') assert.fail(); assert.equal(next.accounts.pageNumber, 2); assert.equal(next.accounts.hasMore, false);
  const before = worker.calls(); assert.deepEqual(await invoke('directory', root.accounts.nextCursor, id), nextReply); assert.equal(worker.calls(), before);
  assert.deepEqual(await invoke('directory', randomUUID()), { ok: false, code: 'directory_cursor_invalid' }); assert.equal(worker.calls(), before);
});
