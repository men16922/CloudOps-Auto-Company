import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { VerifiedCloudContext } from '../../../packages/contracts/access-context';
import { CloudOperationError } from '../../../packages/contracts/errors';
import { cliArguments, cliProfile, metricQueries, type CliBinding, type CliOperation, type CliRuntime, type ReadQuery } from '../../../packages/worker-protocol/cli-contract';
import { OrganizationCliWorker } from '../../../apps/worker/src/cli-worker';

const a: CliBinding = { connectionId: '11111111-1111-4111-8111-111111111111', organizationId: 'synthetic-org', workspaceId: 'workspace-a', actorId: 'actor-a', startUrl: 'https://synthetic-example.awsapps.com/start', ssoRegion: 'us-east-1', region: 'ap-northeast-2', accountId: '123456789012', roleName: 'ReadOnlyAccess' };
const context: VerifiedCloudContext = { actorId: a.actorId, owner: { kind: 'organization', organizationId: a.organizationId }, workspaceId: a.workspaceId, channel: 'web', roles: ['viewer'] };
const code = (expected: string) => (error: unknown) => error instanceof CloudOperationError && error.code === expected;
const identity = JSON.stringify({ Account: a.accountId, Arn: `arn:aws:sts::${a.accountId}:assumed-role/AWSReservedSSO_${a.roleName}_0123456789abcdef/actor-a`, UserId: 'AROA_SYNTHETIC:actor-a' });
type Responder = (operation: CliOperation, input?: ReadQuery) => unknown;
function fixture(respond: Responder, step = 0) {
  let now = 1_800_000_000_000;
  const calls: Array<{ operation: CliOperation; input?: unknown }> = [];
  const runtime: CliRuntime = { async run(operation, _signal, _output, input) {
    calls.push({ operation, input }); now += step;
    if (operation === 'identity') return { stdout: identity };
    const value = respond(operation, input as ReadQuery | undefined);
    if (value instanceof CloudOperationError) throw value;
    return { stdout: JSON.stringify(value) };
  } };
  return { worker: new OrganizationCliWorker(a, runtime, () => now), calls };
}
const denied = () => new CloudOperationError(502, 'access_denied', 'synthetic');

test('new read services use fixed arguments; EKS names and metric windows are validated internal inputs', () => {
  for (const operation of ['eks', 'eks-versions', 'rds', 'elasticache', 'msk', 'alarms', 'ec2', 'lambda', 'dynamodb'] as const) {
    const args = cliArguments(a, operation); assert.equal(args[args.indexOf('--profile') + 1], cliProfile(a)); assert.ok(args.includes('--query'));
    assert.ok(!args.some(arg => ['--debug', '--endpoint-url', '--no-verify-ssl'].includes(arg)));
    assert.throws(() => cliArguments(a, operation, { kind: 'eks-cluster', name: 'synthetic' }), code('invalid_directory_query'));
  }
  assert.deepEqual(cliArguments(a, 'eks-cluster', { kind: 'eks-cluster', name: 'synthetic-cluster' }).slice(0, 4), ['eks', 'describe-cluster', '--name', 'synthetic-cluster']);
  for (const name of ['--profile', '-x', 'a b', '$(id)', 'x'.repeat(101)]) assert.throws(() => cliArguments(a, 'eks-cluster', { kind: 'eks-cluster', name }), code('invalid_read_query'));
  assert.throws(() => cliArguments(a, 'eks-cluster'), code('invalid_read_query'));
  assert.throws(() => cliArguments(a, 'metrics'), code('invalid_read_query'));
  assert.throws(() => cliArguments(a, 'metrics', { kind: 'eks-cluster', name: 'synthetic' }), code('invalid_read_query'));
  const args = cliArguments(a, 'metrics', { kind: 'metrics', end: '2026-10-11T01:02:59.000Z' });
  const body = JSON.parse(args[args.indexOf('--cli-input-json') + 1]);
  assert.equal(body.StartTime, '2026-10-11T00:02:00.000Z'); assert.equal(body.EndTime, '2026-10-11T01:02:00.000Z');
  assert.deepEqual(body.MetricDataQueries.map((query: { Id: string }) => query.Id), metricQueries.map(metric => metric.id));
  assert.ok(body.MetricDataQueries.every((query: { Expression: string; Label: string }) => /^SEARCH\('\{AWS\/(EC2|RDS|ElastiCache|Kafka|Lambda),/.test(query.Expression) && query.Label.startsWith("${PROP('Dim.")));
});

test('a service-level access denial is reported for that read only; the session stays connected', async t => {
  const s = fixture(operation => operation === 'msk' ? denied() : { Items: [{ name: 'synthetic-db', state: 'available', type: 'db.t4g.micro', version: 'postgres 16.4', runtime: null }], HasMore: false });
  t.after(() => s.worker.close()); await s.worker.verify(context);
  await assert.rejects(s.worker.inspect(context, 'msk'), code('read_access_denied'));
  assert.equal(s.worker.status(context).status, 'connected');
  assert.deepEqual(s.calls.slice(-3).map(call => call.operation), ['identity', 'msk', 'identity'], 'identity is still checked after the failed read');
  const page = await s.worker.inspect(context, 'rds');
  assert.deepEqual(page.items, [{ name: 'synthetic-db', state: 'available', type: 'db.t4g.micro', version: 'postgres 16.4' }]);
});

test('a changed identity after a failed read still invalidates the session', async t => {
  let after = false;
  const runtime: CliRuntime = { async run(operation) {
    if (operation === 'identity') return { stdout: after ? identity.replace('actor-a"', 'actor-b"').replace('/actor-a', '/actor-b') : identity };
    after = true; throw denied();
  } };
  const worker = new OrganizationCliWorker(a, runtime); t.after(() => worker.close());
  await worker.verify(context); after = false;
  await assert.rejects(worker.inspect(context, 'rds'), code('identity_changed'));
  assert.notEqual(worker.status(context).status, 'connected');
});

test('EKS merges AWS version support status and stops cluster details at the time budget', async t => {
  const names = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta'];
  const s = fixture((operation, input) => {
    if (operation === 'eks') return { Items: names.map(name => ({ name })), HasMore: false };
    if (operation === 'eks-versions') return { Items: [{ name: '1.33', state: 'EXTENDED_SUPPORT' }, { name: '1.35', state: 'STANDARD_SUPPORT' }, { name: '1.20', state: null }], HasMore: false };
    const name = (input as { name: string }).name;
    return { name, state: 'ACTIVE', version: name === 'alpha' ? '1.33' : '1.35', type: 'eks.5', modified: '2026-01-01T00:00:00Z' };
  }, 2_000);
  t.after(() => s.worker.close()); await s.worker.verify(context);
  const page = await s.worker.inspect(context, 'eks');
  assert.equal(page.items[0].support, 'EXTENDED_SUPPORT'); assert.equal(page.items[1].support, 'STANDARD_SUPPORT');
  const described = page.items.filter(item => item.version).length;
  assert.ok(described >= 1 && described < names.length, `described ${described}`);
  assert.deepEqual(page.items.slice(described).map(item => Object.keys(item)), names.slice(described).map(() => ['name']));
  assert.equal(page.hasMore, true);
  const empty = fixture(() => ({ Items: [], HasMore: false }));
  t.after(() => empty.worker.close()); await empty.worker.verify(context);
  assert.deepEqual((await empty.worker.inspect(context, 'eks')).items, []);
  assert.ok(!empty.calls.some(call => call.operation === 'eks-versions' || call.operation === 'eks-cluster'), 'no clusters, no extra calls');
});

test('EKS without version access still lists clusters with unknown support', async t => {
  const s = fixture(operation => operation === 'eks' ? { Items: [{ name: 'alpha' }], HasMore: false } : operation === 'eks-versions' ? denied() : { name: 'alpha', state: 'ACTIVE', version: '1.33' });
  t.after(() => s.worker.close()); await s.worker.verify(context);
  assert.deepEqual((await s.worker.inspect(context, 'eks')).items, [{ name: 'alpha', state: 'ACTIVE', version: '1.33' }]);
});

test('standard metrics keep the worst ten per metric, ignore series without data, fail closed on unresolved labels and collapse nodes', async t => {
  const rows = [
    ...Array.from({ length: 12 }, (_, index) => ({ id: 'ec2_cpu', name: `i-${String(index).padStart(8, '0')}`, latest: index, max: index * 5, min: 0, sum: index })),
    { id: 'ec2_cpu', name: "${PROP('Dim.InstanceId')}", latest: null, max: null, min: null, sum: 0 },
    { id: 'ec2_cpu', name: 'i-ffffffff', latest: null, max: null, min: null, sum: 0 },
    { id: 'rds_storage', name: 'db-large', latest: 9e10, max: 9e10, min: 8e10, sum: 1 },
    { id: 'rds_storage', name: 'db-small', latest: 3e9, max: 4e9, min: 1e9, sum: 1 },
    { id: 'cache_memory', name: 'cache-a', latest: 40, max: 50, min: 10, sum: 1 },
    { id: 'cache_memory', name: 'cache-a', latest: 70, max: 92, min: 20, sum: 1 },
    { id: 'lambda_errors', name: 'synthetic-function', latest: 0, max: 3, min: 0, sum: 7 },
  ];
  const s = fixture(operation => operation === 'metrics' ? { Items: rows, HasMore: false } : { Items: [], HasMore: false });
  t.after(() => s.worker.close()); await s.worker.verify(context);
  const page = await s.worker.inspect(context, 'metrics');
  const call = s.calls.find(item => item.operation === 'metrics')!;
  assert.equal((call.input as ReadQuery).kind, 'metrics');
  const cpu = page.items.filter(item => item.metric === 'ec2_cpu');
  assert.equal(cpu.length, 10); assert.equal(cpu[0].name, 'i-00000011'); assert.equal(cpu[0].peak, 55); assert.equal(cpu[0].id, 'i-00000011');
  assert.ok(!page.items.some(item => item.name.includes('PROP') || item.name === 'i-ffffffff'));
  assert.deepEqual(page.items.filter(item => item.metric === 'rds_storage').map(item => item.name), ['db-small', 'db-large'], 'lowest free storage first');
  assert.deepEqual(page.items.filter(item => item.metric === 'cache_memory'), [{ name: 'cache-a', metric: 'cache_memory', value: 70, peak: 92 }]);
  assert.equal(page.items.find(item => item.metric === 'lambda_errors')?.peak, 7, 'errors are summed over the window');
  for (const row of [{ id: 'unknown_metric', name: 'x', latest: 1, max: 1, min: 1, sum: 1 }, { id: 'ec2_cpu', name: "${PROP('Dim.InstanceId')}", latest: 99, max: 99, min: 99, sum: 99 }, { id: 'rds_cpu', name: null, latest: 5, max: 5, min: 5, sum: 5 }]) {
    const broken = fixture(operation => operation === 'metrics' ? { Items: [row], HasMore: false } : {});
    t.after(() => broken.worker.close()); await broken.worker.verify(context);
    await assert.rejects(broken.worker.inspect(context, 'metrics'), code('read_invalid_result'), 'unknown metrics and unresolved labels with data fail closed');
    assert.equal(broken.worker.status(context).status, 'connected');
  }
});
