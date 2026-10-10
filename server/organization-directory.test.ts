import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import type { VerifiedCloudContext } from '../src/domain/cloud-operations';
import { CloudOperationError } from '../src/domain/cloud-workflow';
import { directorySnapshotSchema } from '../src/modules/aws/domain/directory';
import { bindingDigest, cliArguments, cliFailure, type CliBinding, type CliOperation, type CliRuntime, type DirectoryQuery } from './modules/aws/organization/organization-cli-contract';
import { OrganizationCliWorker } from './modules/aws/organization/organization-cli-worker';

const binding: CliBinding = { connectionId: '11111111-1111-4111-8111-111111111111', organizationId: 'synthetic-org', workspaceId: 'workspace-a', actorId: 'actor-a', startUrl: 'https://synthetic-example.awsapps.com/start', ssoRegion: 'us-east-1', region: 'us-east-1', accountId: '123456789012', roleName: 'ReadOnlyAccess', directory: { awsOrganizationId: 'o-synthetic1', parentId: 'r-demo' } };
const context: VerifiedCloudContext = { actorId: binding.actorId, owner: { kind: 'organization', organizationId: binding.organizationId }, workspaceId: binding.workspaceId, channel: 'web', roles: ['viewer'] };
const arn = (kind: string, id: string) => `arn:aws:organizations::${binding.accountId}:${kind}/${binding.directory!.awsOrganizationId}/${id}`;
const account = (id: string, state?: string) => ({ Id: id, Name: `Synthetic ${id}`, Arn: arn('account', id), ...(state ? { State: state } : {}) });
const denied = (expected: string) => (error: unknown) => error instanceof CloudOperationError && error.code === expected;
function fixture(input = binding) {
  const calls: CliOperation[] = [], queries: { operation: CliOperation; query?: DirectoryQuery }[] = [], values: Partial<Record<CliOperation, unknown>> = {
    'directory-organization': { Id: binding.directory!.awsOrganizationId, MasterAccountId: binding.accountId },
    'directory-parent': { Items: [{ Id: 'r-demo', Name: 'Synthetic root', Arn: arn('root', 'r-demo') }], HasMore: false },
    'directory-accounts': { Items: [account('123456789012', 'ACTIVE'), account('222222222222', 'SUSPENDED'), account('333333333333')], HasMore: true, NextToken: 'synthetic-next-token' },
    'directory-ous': { Items: [{ Id: 'ou-demo-12345678', Name: 'Synthetic OU', Arn: arn('ou', 'ou-demo-12345678') }], HasMore: false },
  };
  let now = Date.parse('2026-10-10T00:00:00Z');
  let identity = 'synthetic-a', held: CliOperation | undefined, release = () => {}, entered = false;
  const runtime: CliRuntime = { async run(operation, signal, _output, query) {
    queries.push({ operation, query }); calls.push(operation); if (operation === held) { entered = true; await new Promise<void>(resolve => { release = resolve; }); }
    if (signal.aborted) throw cliFailure('cli_cancelled');
    if (operation === 'identity') return { stdout: JSON.stringify({ Account: input.accountId, Arn: `arn:aws:sts::${input.accountId}:assumed-role/AWSReservedSSO_${input.roleName}_0123456789abcdef/${identity}`, UserId: `SYNTHETIC:${identity}` }) };
    const source = values[operation]; const value = typeof source === 'function' ? await source(query) : source; if (value instanceof Error) throw value;
    return { stdout: JSON.stringify(value) };
  } };
  const worker = new OrganizationCliWorker(input, runtime, () => now);
  return { worker, calls, values, queries, advance: (ms: number) => { now += ms; }, hold: (operation: CliOperation) => { held = operation; }, entered: () => entered, release: () => release(), changeIdentity: () => { identity = 'other-user'; } };
}

test('directory commands use only the pinned organization parent, one page and minimal non-secret metadata', () => {
  for (const operation of ['directory-organization', 'directory-parent', 'directory-accounts', 'directory-ous'] as const) {
    const args = cliArguments(binding, operation); assert.equal(args[0], 'organizations'); assert.ok(args.includes('--no-paginate'));
    assert.ok(!args.includes('--starting-token')); assert.ok(!args.join(' ').includes('Email')); assert.ok(!args.join(' ').includes('Status:'));
    assert.throws(() => cliArguments({ ...binding, directory: undefined }, operation));
  }
  assert.equal(JSON.parse(cliArguments(binding, 'directory-accounts')[cliArguments(binding, 'directory-accounts').indexOf('--cli-input-json') + 1]).ParentId, 'r-demo');
  assert.ok(cliArguments({ ...binding, directory: { ...binding.directory!, parentId: 'ou-demo-12345678' } }, 'directory-parent').includes('describe-organizational-unit'));
  assert.notEqual(bindingDigest(binding), bindingDigest({ ...binding, directory: { ...binding.directory!, parentId: 'r-other' } }));
  const tokenArgs = cliArguments(binding, 'directory-accounts', { parentId: 'r-demo', nextToken: '--profile evil\n$(id)' });
  assert.equal(JSON.parse(tokenArgs[tokenArgs.indexOf('--cli-input-json') + 1]).NextToken, '--profile evil\n$(id)'); assert.equal(tokenArgs.filter(value => value === '--profile').length, 1);
  assert.throws(() => cliArguments(binding, 'directory-accounts', { parentId: 'ou-other-12345678' }), denied('directory_scope_mismatch'));
});

test('directory observes bounded direct children and lifecycle separately from access and service health', async t => {
  const s = fixture(); t.after(() => s.worker.close()); await s.worker.verify(context);
  const result = await s.worker.directory(context); assert.equal(result.coverage, 'direct-children-page');
  assert.equal(result.accounts.status, 'collected'); assert.equal(result.organizationalUnits.status, 'collected');
  if (result.accounts.status !== 'collected') assert.fail();
  assert.deepEqual(result.accounts.items.map(item => item.lifecycle), ['ACTIVE', 'SUSPENDED', 'UNKNOWN']); assert.equal(result.accounts.hasMore, true);
  assert.ok(result.accounts.items.every(item => item.access === 'not-checked' && item.inspection === 'not-collected'));
  assert.deepEqual(s.calls, ['identity', 'identity', 'directory-organization', 'directory-parent', 'directory-accounts', 'directory-ous', 'identity']);
  assert.ok(!JSON.stringify(result).includes('arn:')); assert.equal(s.worker.status(context).status, 'connected');
});

test('empty account page with continuation stays partial and account denial preserves independent OU evidence', async t => {
  for (const failed of [false, true]) {
    const s = fixture(); t.after(() => s.worker.close()); await s.worker.verify(context);
    s.values['directory-accounts'] = failed ? cliFailure('sso_denied') : { Items: [], HasMore: true, NextToken: 'synthetic-next-token' };
    const result = await s.worker.directory(context);
    if (failed) { assert.equal(result.accounts.status, 'denied'); assert.ok(!('items' in result.accounts)); }
    else { assert.equal(result.accounts.status, 'collected'); if (result.accounts.status !== 'collected') assert.fail(); assert.deepEqual(result.accounts.items, []); assert.equal(result.accounts.hasMore, true); }
    assert.equal(result.organizationalUnits.status, 'collected'); assert.equal(s.worker.status(context).status, 'connected');
  }
});

test('missing organization permission and throttling are not zero accounts or failed SSO authentication', async t => {
  for (const failure of ['sso_denied', 'organization_not_in_use', 'cli_throttled']) {
    const s = fixture(); t.after(() => s.worker.close()); await s.worker.verify(context); s.values['directory-organization'] = cliFailure(failure);
    const result = await s.worker.directory(context); assert.notEqual(result.accounts.status, 'collected'); assert.ok(!('items' in result.accounts));
    assert.equal(result.accounts.source, 'organizations:DescribeOrganization'); assert.equal(result.organizationalUnits.source, 'organizations:DescribeOrganization');
    assert.deepEqual(s.calls, ['identity', 'identity', 'directory-organization', 'identity']); assert.equal(s.worker.status(context).status, 'connected');
  }
});

test('unexpected lifecycle is unknown; deprecated Status cannot imply ACTIVE and malformed/secret output is rejected', async t => {
  const s = fixture(); t.after(() => s.worker.close()); await s.worker.verify(context);
  s.values['directory-accounts'] = { Items: [account('123456789012', 'FUTURE_STATE')], HasMore: false };
  const future = await s.worker.directory(context); assert.equal(future.accounts.status, 'collected'); if (future.accounts.status !== 'collected') assert.fail(); assert.equal(future.accounts.items[0].lifecycle, 'UNKNOWN');
  for (const item of [{ ...account('123456789012'), Status: 'ACTIVE' }, { ...account('123456789012'), Email: 'synthetic@example.invalid' }]) {
    s.values['directory-accounts'] = { Items: [item], HasMore: false };
    const result = await s.worker.directory(context); assert.equal(result.accounts.status, 'unavailable'); assert.ok(!JSON.stringify(result).includes('example.invalid'));
  }
  assert.equal(directorySnapshotSchema.safeParse({ ...future, nextToken: 'synthetic-secret' }).success, false);
});

test('foreign organization, parent or account evidence cannot cross the pinned directory scope', async t => {
  for (const operation of ['directory-organization', 'directory-parent', 'directory-accounts'] as const) {
    const s = fixture(); t.after(() => s.worker.close()); await s.worker.verify(context);
    s.values[operation] = operation === 'directory-organization' ? { Id: 'o-otherorg12', MasterAccountId: binding.accountId } : operation === 'directory-parent'
      ? { Items: [{ Id: 'r-demo', Name: 'Foreign', Arn: arn('root', 'r-demo').replace('o-synthetic1', 'o-otherorg12') }], HasMore: false }
      : { Items: [{ ...account('123456789012'), Arn: arn('account', '123456789012').replace('o-synthetic1', 'o-otherorg12') }], HasMore: false };
    await assert.rejects(s.worker.directory(context), denied('directory_scope_mismatch')); assert.equal(s.worker.status(context).status, 'failed'); assert.ok(!s.calls.includes('directory-ous'));
  }
});

test('unconfigured or foreign users cannot issue directory calls, and identity change or disconnect discards observations', async t => {
  const noScope = fixture({ ...binding, directory: undefined }); t.after(() => noScope.worker.close()); await noScope.worker.verify(context);
  await assert.rejects(noScope.worker.directory(context), denied('directory_not_configured')); assert.deepEqual(noScope.calls, ['identity']);
  for (const disconnect of [false, true]) {
    const s = fixture(); t.after(() => s.worker.close()); await s.worker.verify(context);
    await assert.rejects(s.worker.directory({ ...context, actorId: 'other' }), denied('connection_unavailable'));
    s.hold('directory-ous'); const pending = s.worker.directory(context);
    while (!s.entered()) await nextTurn();
    if (disconnect) s.worker.disconnect(context); else s.changeIdentity(); s.release();
    await assert.rejects(pending, denied(disconnect ? 'cli_cancelled' : 'identity_changed'));
    assert.notEqual(s.worker.status(context).status, 'connected');
  }
});

function navigable() {
  const s = fixture();
  s.values['directory-parent'] = (query: DirectoryQuery) => ({ Items: [{ Id: query.parentId, Name: query.parentId === 'r-demo' ? 'Synthetic root' : 'Synthetic child', Arn: arn(query.parentId.startsWith('r-') ? 'root' : 'ou', query.parentId) }], HasMore: false });
  s.values['directory-ancestors'] = { Items: [{ Id: 'r-demo', Type: 'ROOT' }], HasMore: false };
  s.values['directory-accounts'] = (query: DirectoryQuery) => query.parentId === 'r-demo'
    ? { Items: query.nextToken === 'page-a' ? [] : [account(query.nextToken === 'page-b' ? '444444444444' : '123456789012', 'ACTIVE')], HasMore: query.nextToken !== 'page-b', NextToken: query.nextToken === 'page-b' ? null : query.nextToken === 'page-a' ? 'page-b' : 'page-a' }
    : { Items: [account('555555555555', 'PENDING_CLOSURE')], HasMore: false };
  return s;
}

test('directory navigation follows user-selected pages including empty continuations without exposing AWS tokens', async t => {
  const s = navigable(); t.after(() => s.worker.close()); await s.worker.verify(context);
  const first = await s.worker.directory(context); if (first.accounts.status !== 'collected') assert.fail();
  assert.equal(first.accounts.pageNumber, 1); assert.ok(first.accounts.nextCursor); assert.ok(!JSON.stringify(first).includes('page-a'));
  const afterFirst = s.calls.length; await nextTurn(); assert.equal(s.calls.length, afterFirst);
  const second = await s.worker.directory(context, first.accounts.nextCursor); if (second.accounts.status !== 'collected') assert.fail();
  assert.equal(second.accounts.pageNumber, 2); assert.deepEqual(second.accounts.items, []); assert.equal(second.accounts.hasMore, true); assert.ok(second.accounts.nextCursor);
  const third = await s.worker.directory(context, second.accounts.nextCursor); if (third.accounts.status !== 'collected') assert.fail();
  assert.equal(third.accounts.pageNumber, 3); assert.equal(third.accounts.items[0].id, '444444444444'); assert.equal(third.accounts.hasMore, false); assert.equal(third.accounts.nextCursor, undefined);
  assert.deepEqual(s.queries.filter(item => item.operation === 'directory-accounts').map(item => item.query?.nextToken), [undefined, 'page-a', 'page-b']);
});

test('OU descent and breadcrumb return preserve configured scope and verify the ancestor chain before and after reads', async t => {
  const s = navigable(); t.after(() => s.worker.close()); await s.worker.verify(context);
  const root = await s.worker.directory(context); if (root.organizationalUnits.status !== 'collected') assert.fail();
  const childCursor = root.organizationalUnits.items[0].browseCursor!;
  s.values['directory-ous'] = { Items: [], HasMore: false };
  const child = await s.worker.directory(context, childCursor);
  assert.equal(child.scope.parentId, 'r-demo'); assert.equal(child.parentId, 'ou-demo-12345678'); assert.deepEqual(child.navigation.path.map(item => item.id), ['r-demo', 'ou-demo-12345678']);
  assert.equal(s.calls.filter(item => item === 'directory-ancestors').length, 2);
  assert.ok(s.queries.filter(item => item.operation === 'directory-accounts').at(-1)?.query?.parentId === 'ou-demo-12345678');
  const back = await s.worker.directory(context, child.navigation.path[0].cursor); assert.equal(back.parentId, 'r-demo'); assert.equal(back.navigation.path.length, 1);
});

test('cursor is worker-local, expires, and cannot survive fresh root collection, reauthentication or disconnect', async t => {
  const s = navigable(), other = navigable(); t.after(() => s.worker.close()); t.after(() => other.worker.close()); await s.worker.verify(context); await other.worker.verify(context);
  const first = await s.worker.directory(context); if (first.accounts.status !== 'collected') assert.fail(); const cursor = first.accounts.nextCursor!;
  const calls = other.calls.length; await assert.rejects(other.worker.directory(context, cursor), denied('directory_cursor_invalid')); assert.equal(other.calls.length, calls);
  await assert.rejects(s.worker.directory({ ...context, actorId: 'other' }, cursor), denied('connection_unavailable'));
  s.advance(600_001); const prior = s.calls.length; await assert.rejects(s.worker.directory(context, cursor), denied('directory_cursor_expired')); assert.equal(s.calls.length, prior); assert.equal(s.worker.status(context).status, 'connected');
  for (const action of ['refresh', 'verify', 'disconnect'] as const) {
    const view = await s.worker.directory(context); if (view.accounts.status !== 'collected') assert.fail(); const old = view.accounts.nextCursor!;
    if (action === 'refresh') await s.worker.directory(context); else if (action === 'verify') await s.worker.verify(context); else { s.worker.disconnect(context); await s.worker.verify(context); }
    await assert.rejects(s.worker.directory(context, old), denied('directory_cursor_invalid'));
  }
});

test('an OU moved outside its observed path before or during collection never releases account observations', async t => {
  for (const moveAfter of [false, true]) {
    const s = navigable(); t.after(() => s.worker.close()); await s.worker.verify(context);
    const root = await s.worker.directory(context); if (root.organizationalUnits.status !== 'collected') assert.fail(); const cursor = root.organizationalUnits.items[0].browseCursor!;
    s.values['directory-ous'] = { Items: [], HasMore: false }; let checks = 0;
    s.values['directory-ancestors'] = () => ({ Items: [{ Id: ++checks > (moveAfter ? 1 : 0) ? 'r-other' : 'r-demo', Type: 'ROOT' }], HasMore: false });
    const before = s.calls.filter(item => item === 'directory-accounts').length;
    await assert.rejects(s.worker.directory(context, cursor), denied('directory_scope_mismatch'));
    assert.equal(s.calls.filter(item => item === 'directory-accounts').length, before + (moveAfter ? 1 : 0)); assert.equal(s.worker.status(context).status, 'failed');
  }
});

test('cyclic continuation tokens and incomplete ancestry are not interpreted as a complete inventory', async t => {
  const s = navigable(); t.after(() => s.worker.close()); await s.worker.verify(context);
  const first = await s.worker.directory(context); if (first.accounts.status !== 'collected' || first.organizationalUnits.status !== 'collected') assert.fail();
  s.values['directory-accounts'] = { Items: [], HasMore: true, NextToken: 'page-a' };
  const cycle = await s.worker.directory(context, first.accounts.nextCursor); assert.equal(cycle.accounts.status, 'unavailable'); assert.ok(!('nextCursor' in cycle.accounts));
  s.values['directory-ancestors'] = { Items: [], HasMore: true };
  const unverified = await s.worker.directory(context, first.organizationalUnits.items[0].browseCursor); assert.equal(unverified.accounts.status, 'unavailable'); assert.equal(unverified.accounts.source, 'organizations:ListParents');
  assert.equal(s.worker.status(context).status, 'connected');
});
