import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessOperations, consoleLink, serviceData, withDirectReads, type Service } from '../../../packages/assessment/operations-assessment';
import { lambdaRuntimeStatus, lifecycleRows } from '../../../packages/assessment/eos-rules';
import type { InventoryUnit } from '../../../packages/contracts/aws/inventory';

const unit = (service: Service, items: InventoryUnit['items'], options: Partial<InventoryUnit> = {}): InventoryUnit => ({ accountId: '123456789012', region: 'ap-northeast-2', service, collectedAt: '2026-10-11T00:00:00.000Z', hasMore: false, items, source: 'direct', ...options });
const now = Date.parse('2026-10-11T00:00:00Z');
const group = (units: InventoryUnit[]) => { const grouped: Partial<Record<Service, InventoryUnit[]>> = {}; for (const value of units) (grouped[value.service] ??= []).push(value); return serviceData(grouped); };
const assess = (units: InventoryUnit[], open?: Parameters<typeof assessOperations>[2]) => assessOperations(undefined, group(units), open, now);

test('nothing collected stays unknown; nothing is presumed healthy', () => {
  const result = assessOperations(undefined, {});
  assert.equal(result.overall, 'unknown'); assert.deepEqual(result.findings, []);
});

test('ALARM is an action item, missing data and deprecated runtimes are attention, stopped instances are info; findings carry account and region', () => {
  const result = assess([
    unit('alarms', [{ name: 'api-5xx', state: 'ALARM' }, { name: 'queue-age', state: 'INSUFFICIENT_DATA' }, { name: 'cpu', state: 'OK' }]),
    unit('lambda', [{ name: 'legacy', runtime: 'python3.8' }, { name: 'current', runtime: 'python3.12' }], { hasMore: true }),
    unit('ec2', [{ id: 'i-0123456789abcdef0', name: 'batch', state: 'stopped', type: 't3.micro' }, { id: 'i-0123456789abcdef1', name: 'web', state: 'running' }], { accountId: '210987654321', region: 'us-east-1' }),
    unit('dynamodb', [{ name: 'orders' }]),
  ]);
  assert.equal(result.overall, 'action');
  assert.deepEqual(result.counts, { critical: 1, warning: 2, info: 1 });
  assert.deepEqual(result.findings.map(item => `${item.severity}:${item.kind}:${item.subject}:${item.accountId}:${item.region}`), ['critical:alarm:api-5xx:123456789012:ap-northeast-2', 'warning:eos:legacy:123456789012:ap-northeast-2',
    'warning:alarm-data:queue-age:123456789012:ap-northeast-2', 'info:instance:batch:210987654321:us-east-1']);
  assert.equal(result.findings[3]!.link, consoleLink.ec2('us-east-1', 'i-0123456789abcdef0'), 'console links use the resource region');
  assert.deepEqual(result.metrics.lambda, { total: 2, deprecated: 1, partial: true, runtimes: [['python3.8', 1], ['python3.12', 1]] });
  assert.deepEqual(result.metrics.ec2, { total: 2, running: 1, stopped: 1, partial: false });
});

test('the console opener receives the resource account (Identity Center shortcut links)', () => {
  const result = assess([unit('alarms', [{ name: 'x y', state: 'ALARM' }], { accountId: '210987654321' })], (account, url) => `portal:${account}:${url}`);
  assert.equal(result.findings[0]!.link, `portal:210987654321:${consoleLink.alarm('ap-northeast-2', 'x y')}`);
  assert.match(consoleLink.lambda('us-east-1', 'a/b c'), /functions\/a%2Fb%20c$/);
});

test('EKS extended support is attention and unsupported is action; unknown support is not a finding', () => {
  const result = assess([unit('eks', [
    { name: 'legacy', state: 'ACTIVE', version: '1.29', support: 'UNSUPPORTED' }, { name: 'old', state: 'ACTIVE', version: '1.33', support: 'EXTENDED_SUPPORT', eos: '2027-07-29T00:00:00+00:00' },
    { name: 'current', state: 'ACTIVE', version: '1.35', support: 'STANDARD_SUPPORT', eos: '2027-12-01T00:00:00+00:00' }, { name: 'pending' }, { name: 'upgrading', state: 'UPDATING', version: '1.35' }])]);
  assert.deepEqual(result.findings.map(item => `${item.severity}:${item.kind}:${item.subject}`), ['critical:eos:legacy', 'warning:eos:old', 'info:resource-state:upgrading']);
  assert.deepEqual(result.findings[1]!.eos, { component: 'EKS', status: 'extended', current: 'Kubernetes 1.33', date: '2027-07-29T00:00:00+00:00', daysLeft: 291 });
  assert.deepEqual(result.metrics.eks, { total: 5, partial: false, active: 3, extended: 1, unsupported: 1 });
});

test('RDS, ElastiCache and MSK states: failures are action, transitions are info, available/ACTIVE are not findings', () => {
  const result = assess([
    unit('rds', [{ name: 'orders', state: 'available' }, { name: 'full', state: 'storage-full' }, { name: 'tuning', state: 'modifying' }]),
    unit('elasticache', [{ name: 'sessions', state: 'available' }, { name: 'broken', state: 'incompatible-network' }]),
    unit('msk', [{ name: 'events', state: 'ACTIVE' }, { name: 'heal', state: 'HEALING' }, { name: 'dead', state: 'FAILED' }]),
  ]);
  assert.deepEqual(result.findings.map(item => `${item.severity}:${item.subject}`), ['critical:broken', 'critical:dead', 'critical:full', 'warning:heal', 'info:tuning']);
});

test('standard metric thresholds: CPU and disk peaks, low free storage, failed status checks and Lambda errors', () => {
  const gib = 1024 ** 3;
  const result = assess([unit('metrics', [
    { name: 'i-0123456789abcdef0', id: 'i-0123456789abcdef0', metric: 'ec2_cpu', value: 40, peak: 95 }, { name: 'i-0123456789abcdef1', id: 'i-0123456789abcdef1', metric: 'ec2_cpu', value: 10, peak: 60 },
    { name: 'i-0123456789abcdef2', id: 'i-0123456789abcdef2', metric: 'ec2_status', value: 0, peak: 1 },
    { name: 'orders', metric: 'rds_storage', value: 3 * gib, peak: 1.5 * gib }, { name: 'reports', metric: 'rds_storage', value: 50 * gib, peak: 8 * gib }, { name: 'big', metric: 'rds_storage', value: 90 * gib, peak: 80 * gib },
    { name: 'events', metric: 'msk_disk', value: 86, peak: 88 }, { name: 'fn', metric: 'lambda_errors', value: 0, peak: 3 }])]);
  assert.deepEqual(result.findings.map(item => `${item.severity}:${item.metric}:${item.subject}`), [
    'critical:ec2_status:i-0123456789abcdef2', 'critical:rds_storage:orders', 'warning:msk_disk:events', 'warning:ec2_cpu:i-0123456789abcdef0', 'warning:rds_storage:reports', 'info:lambda_errors:fn']);
});

test('SSM: running EC2 without a managed node is reported only where the SSM read succeeded; lost agents, patch and automation failures', () => {
  const result = assess([
    unit('ec2', [{ id: 'i-0000000000000001', name: 'managed', state: 'running' }, { id: 'i-0000000000000002', name: 'bare', state: 'running' }, { id: 'i-0000000000000003', name: 'off', state: 'stopped' }]),
    unit('ec2', [{ id: 'i-0000000000000004', name: 'unknown-coverage', state: 'running' }], { region: 'us-west-2' }),
    unit('ssm', [{ id: 'i-0000000000000001', name: 'managed', state: 'Online' }, { id: 'i-0000000000000009', name: 'gone', state: 'ConnectionLost' }]),
    unit('ssm', [], { region: 'us-west-2', code: 'read_access_denied' }),
    unit('patch', [{ id: 'i-0000000000000001', name: 'i-0000000000000001', state: 'NON_COMPLIANT', detail: 'CRITICAL' }, { id: 'i-0000000000000002', name: 'i-0000000000000002', state: 'COMPLIANT' }]),
    unit('automation', [{ id: '11111111-2222-3333-4444-555555555555', name: 'AWS-RestartEC2Instance', state: 'Failed' }, { id: '11111111-2222-3333-4444-555555555556', name: 'AWS-StopEC2Instance', state: 'Success' }]),
  ]);
  const kinds = result.findings.map(item => `${item.severity}:${item.kind}:${item.subject}`);
  assert.ok(kinds.includes('info:ssm-unmanaged:bare')); assert.ok(!kinds.some(kind => kind.includes('unknown-coverage')), 'a failed SSM read is not evidence of an unmanaged instance');
  assert.ok(kinds.includes('warning:ssm-lost:gone')); assert.ok(kinds.includes('critical:patch:i-0000000000000001')); assert.ok(kinds.includes('warning:automation:AWS-RestartEC2Instance'));
  assert.ok(kinds.includes('info:read-failed:ssm'), 'failed account/region reads stay visible as coverage gaps');
  assert.deepEqual(result.metrics.ssm, { total: 2, partial: false, online: 1, unmanaged: 1 });
});

test('the account/region scope filter keeps only matching units', () => {
  const grouped = { ec2: [unit('ec2', [{ name: 'a', state: 'running' }]), unit('ec2', [{ name: 'b', state: 'running' }], { accountId: '210987654321' })] };
  assert.deepEqual(serviceData(grouped, value => value.accountId === '210987654321').ec2?.items.map(item => item.name), ['b']);
});

test('lifecycle: API states for EKS/RDS/MSK and documented dates for Lambda, ElastiCache, MSK and operating systems; unknown is never "supported"', () => {
  const rows = lifecycleRows(group([
    unit('rds', [{ name: 'pg', version: 'postgres 11.22', support: 'EXTENDED_SUPPORT', eos: '2027-02-28T00:00:00+00:00' }, { name: 'oracle', version: 'oracle-ee 19.0' }, { name: 'soon', version: 'mysql 8.0.40', support: 'STANDARD_SUPPORT', eos: '2026-11-30T00:00:00+00:00' }]),
    unit('lambda', [{ name: 'old', runtime: 'nodejs12.x' }, { name: 'dep', runtime: 'python3.9' }, { name: 'next', runtime: 'python3.10' }, { name: 'ok', runtime: 'python3.12' }, { name: 'image', runtime: null }, { name: 'new', runtime: 'python9.9' }]),
    unit('elasticache', [{ name: 'r5', version: 'redis 5.0.6' }, { name: 'r6', version: 'redis 6.2.6' }, { name: 'r3', version: 'redis 3.2.10' }, { name: 'vk', version: 'valkey 8.0' }]),
    unit('msk', [{ name: 'k36', version: '3.6.0' }, { name: 'k39', version: '3.9.x', support: 'STANDARD_SUPPORT' }, { name: 'k28', version: '2.8.1', support: 'DEPRECATED' }]),
    unit('ssm', [{ id: 'i-1', name: 'al2', version: 'Amazon Linux', detail: '2' }, { id: 'i-2', name: 'al2023', version: 'Amazon Linux', detail: '2023' }, { id: 'i-3', name: 'win16', version: 'Microsoft Windows Server 2016 Datacenter', detail: '10.0.14393' },
      { id: 'i-4', name: 'centos', version: 'CentOS Linux', detail: '7.9.2009' }, { id: 'i-5', name: 'mystery', version: 'Plan 9', detail: '4' }]),
  ]), now);
  const by = Object.fromEntries(rows.map(row => [row.name, `${row.status}${row.date ? `@${row.date.slice(0, 10)}` : ''}`]));
  assert.deepEqual(by, { pg: 'extended@2027-02-28', oracle: 'unknown', soon: 'upcoming@2026-11-30', old: 'ended@2023-04-30', dep: 'deprecated@2027-08-31', next: 'upcoming@2026-10-31', ok: 'supported@2028-10-31', new: 'unknown',
    r5: 'extended@2029-01-31', r6: 'supported@2027-01-31', r3: 'ended@2023-07-31', vk: 'unknown', k36: 'ended@2026-06-01', k39: 'supported', k28: 'deprecated',
    al2: 'ended@2026-06-30', al2023: 'supported@2027-06-30', win16: 'supported@2027-01-12', centos: 'ended@2024-06-30', mystery: 'unknown' });
  assert.ok(!rows.some(row => row.name === 'image'), 'container images carry their own runtime');
  assert.deepEqual(rows.slice(0, 5).map(row => row.status), ['ended', 'ended', 'ended', 'ended', 'ended'], 'ended first');
  assert.equal(lambdaRuntimeStatus('python3.8', now), 'deprecated'); assert.equal(lambdaRuntimeStatus('nodejs22.x', now), 'supported'); assert.equal(lambdaRuntimeStatus(undefined, now), undefined);
  const findings = assessOperations(undefined, group([unit('lambda', [{ name: 'next', runtime: 'python3.10' }, { name: 'later', runtime: 'dotnet8' }])]), undefined, now).findings;
  assert.deepEqual(findings.map(item => `${item.severity}:${item.subject}`), ['warning:next', 'info:later'], 'ending within 30 days is attention, within 90 days info');
});

test('governance: Security Hub/GuardDuty aggregate per account/region, "not enabled" is attention (not a read failure), tags and Health stay evidence-based', () => {
  const result = assessOperations(undefined, group([
    unit('securityhub', [{ name: 'S3 bucket public', state: 'CRITICAL' }, { name: 'Root MFA', state: 'HIGH' }, { name: 'Port 22 open', state: 'HIGH' }]),
    unit('securityhub', [], { region: 'us-east-1', code: 'read_not_enabled' }),
    unit('guardduty', [{ id: 'b'.repeat(32), name: 'Port probe', value: 8 }]),
    unit('guardduty', [], { region: 'us-east-1', code: 'read_access_denied' }),
    unit('health', [{ name: 'AWS_EC2_INSTANCE_RETIREMENT_SCHEDULED', type: 'EC2', version: 'scheduledChange', state: 'upcoming', detail: 'ap-northeast-2' }], { region: 'us-east-1' }),
    unit('health', [], { accountId: '210987654321', region: 'us-east-1', code: 'read_not_subscribed' }),
    unit('ec2', [{ id: 'i-0123456789abcdef0', name: 'web', state: 'running', tags: ['Name', 'Owner'] }, { id: 'i-0123456789abcdef1', name: 'batch', state: 'running', tags: ['Name'] }]),
    unit('dynamodb', [{ name: 'orders' }]),
  ]), undefined, now, ['Owner', 'CostCenter']);
  const kinds = result.findings.map(item => `${item.severity}:${item.kind}:${item.detail}:${item.region}`);
  assert.ok(kinds.includes('critical:security-hub:CRITICAL:ap-northeast-2') && kinds.includes('warning:security-hub:HIGH:ap-northeast-2'));
  assert.equal(result.findings.find(item => item.kind === 'security-hub' && item.detail === 'HIGH')!.value, 2, 'one finding per account/region and severity');
  assert.ok(kinds.includes('critical:guardduty:HIGH:ap-northeast-2'));
  assert.ok(kinds.includes('warning:security-off:not_enabled:us-east-1'));
  assert.ok(kinds.includes('info:read-failed:read_access_denied:us-east-1'), 'a denied read is a read failure');
  assert.ok(!kinds.some(kind => kind.includes('read_not_')), 'not enabled / not subscribed are states, not read failures');
  assert.ok(kinds.includes('warning:health:EC2 · scheduledChange · upcoming:ap-northeast-2'), 'Health findings use the event region');
  assert.deepEqual(result.metrics.tags, { compliant: 0, missing: 2, unknown: 1 }, 'DynamoDB without collected tags is unknown');
  assert.deepEqual(result.findings.filter(item => item.kind === 'tags').map(item => [item.subject, item.value, item.detail]), [['ec2', 2, 'CostCenter, Owner']]);
  assert.deepEqual([result.metrics.securityhub?.off, result.metrics.guardduty?.threats, result.metrics.health?.unavailable], [1, 1, 1]);
  assert.equal(assessOperations(undefined, group([unit('ec2', [{ id: 'i-0123456789abcdef0', name: 'web', tags: [] }])]), undefined, now).findings.filter(item => item.kind === 'tags').length, 0, 'no required tags configured, no tag findings');
});

test('single-connection reads fill places the multi-account inventory has not read, never replacing an inventory unit', () => {
  const page = (operation: 'lambda' | 'ec2', region: string) => ({ connectionId: '11111111-1111-4111-8111-111111111111', accountId: '123456789012', region, operation, collectedAt: '2026-10-10T00:00:00.000Z', items: [{ name: `synthetic-${operation}-${region}` }], hasMore: false });
  const synced = unit('lambda', [{ name: 'synthetic-synced' }]);
  const merged = withDirectReads({ lambda: [synced] }, { lambda: page('lambda', 'ap-northeast-2'), ec2: page('ec2', 'us-east-1') });
  assert.deepEqual(merged.lambda?.map(value => value.items[0]?.name), ['synthetic-synced'], 'the synced unit for the same place wins');
  assert.deepEqual(merged.ec2?.map(value => [value.region, value.source, value.items[0]?.name]), [['us-east-1', 'direct', 'synthetic-ec2-us-east-1']]);
  assert.equal(assessOperations(undefined, serviceData(merged), undefined, now).overall, 'clear');
  assert.equal(assessOperations(undefined, serviceData(withDirectReads({}, {})), undefined, now).overall, 'unknown');
});
