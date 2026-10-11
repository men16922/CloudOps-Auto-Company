import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import type { VerifiedCloudContext } from '../src/domain/cloud-operations';
import { CloudOperationError } from '../src/domain/cloud-workflow';
import { cliArguments, cliConfig, cliProfile, configExpression, type CliBinding, type CliOperation, type CliRuntime, type CliTarget, type DirectoryQuery, type ReadQuery } from './modules/aws/organization/organization-cli-contract';
import { OrganizationCliWorker } from './modules/aws/organization/organization-cli-worker';
import { configItem } from './modules/aws/organization/organization-sync';

const payer = '111111111111', memberA = '222222222222', memberB = '333333333333', suspended = '444444444444', outside = '999999999999';
const base: CliBinding = { connectionId: '11111111-1111-4111-8111-111111111111', organizationId: 'synthetic-org', workspaceId: 'workspace-a', actorId: 'actor-a', startUrl: 'https://synthetic-example.awsapps.com/start',
  ssoRegion: 'us-east-1', region: 'us-east-1', accountId: payer, roleName: 'ReadOnlyAccess', directory: { awsOrganizationId: 'o-synthetic1', parentId: 'r-demo' } };
const context: VerifiedCloudContext = { actorId: base.actorId, owner: { kind: 'organization', organizationId: base.organizationId }, workspaceId: base.workspaceId, channel: 'web', roles: ['viewer'] };
const identity = (account: string, session = 'actor-a') => JSON.stringify({ Account: account, Arn: `arn:aws:sts::${account}:assumed-role/AWSReservedSSO_ReadOnlyAccess_0123456789abcdef/${session}`, UserId: `AROA_SYNTHETIC:${session}` });
const code = (expected: string) => (error: unknown) => error instanceof CloudOperationError && error.code === expected;
type Call = { operation: CliOperation; input?: DirectoryQuery | ReadQuery; target?: CliTarget };
type Responder = (call: Call) => unknown;
function fixture(binding: CliBinding, respond: Responder) {
  const calls: Call[] = [];
  const runtime: CliRuntime = { async run(operation, _signal, _output, input, target) {
    calls.push({ operation, input, target });
    const value = respond({ operation, input, target });
    if (value instanceof CloudOperationError) throw value;
    return { stdout: typeof value === 'string' ? value : JSON.stringify(value) };
  } };
  return { worker: new OrganizationCliWorker(binding, runtime), calls };
}
async function finished(worker: OrganizationCliWorker) {
  for (let n = 0; n < 500; n++) { const job = worker.syncStatus(context); if (job.state !== 'running') return job; await nextTurn(); }
  assert.fail('sync did not finish');
}
const denied = () => new CloudOperationError(403, 'access_denied', 'synthetic');
/** A small organization: payer (no tagged VPC), member A (tagged VPC in ap-northeast-2), member B (not assigned), one suspended account. */
const organization: Responder = ({ operation, target }) => {
  const account = target?.accountId ?? payer, region = target?.region ?? base.region;
  switch (operation) {
    case 'identity': return account === memberB ? denied() : identity(account);
    case 'directory-all-accounts': return { Items: [{ Id: payer, Name: 'Payer', State: 'ACTIVE' }, { Id: memberA, Name: 'Workload A', State: 'ACTIVE' }, { Id: memberB, Name: 'Workload B', State: 'ACTIVE' }, { Id: suspended, Name: 'Old', State: 'SUSPENDED' }], HasMore: false, NextToken: null };
    case 'regions': return { Items: [{ name: 'us-east-1', state: 'opt-in-not-required' }, { name: 'ap-northeast-2', state: 'opt-in-not-required' }, { name: 'eu-west-1', state: 'opt-in-not-required' }], HasMore: false };
    case 'vpcs': return account === memberA && region === 'ap-northeast-2' ? { Total: 2, Tagged: 1, HasMore: false } : { Total: 1, Tagged: 0, HasMore: false };
    case 'msk': return account === memberA ? denied() : { Items: [], HasMore: false };
    case 'ec2': return { Items: [{ id: 'i-0123456789abcdef0', name: `${account}-${region}`, state: 'running', type: 't3.micro' }], HasMore: false };
    case 'metrics': return { Items: [], HasMore: false };
    case 'automation': return { Items: [], HasMore: false };
    case 'apigateway-rest': case 'apigateway-http': return { Items: [], HasMore: false };
    case 'eks': return { Items: [], HasMore: false };
    default: return { Items: [], HasMore: false };
  }
};

test('sync covers the organization scope: per-account STS, tagged-VPC regions only, per-unit failures and unassigned accounts', async t => {
  const s = fixture(base, organization); t.after(() => s.worker.close());
  await s.worker.verify(context);
  const started = s.worker.startSync(context);
  assert.equal(started.state, 'running'); assert.throws(() => s.worker.startSync(context), code('connection_busy'));
  const job = await finished(s.worker);
  assert.equal(job.state, 'partial');
  const byId = new Map(job.accounts.map(account => [account.accountId, account]));
  assert.equal(byId.get(memberA)!.access, 'verified'); assert.equal(byId.get(memberB)!.access, 'denied'); assert.equal(byId.get(suspended)!.code, 'account_not_active');
  assert.deepEqual(byId.get(memberA)!.regions.filter(region => region.taggedVpcs > 0).map(region => region.region), ['ap-northeast-2']);
  assert.equal(byId.get(memberA)!.candidateRegions, 3);
  // Payer: no tagged VPC, but its home region is server-fixed; member A: only the tagged region; B/suspended: nothing.
  assert.deepEqual([...new Set(job.units.filter(unit => unit.service !== 'health').map(unit => `${unit.accountId}:${unit.region}`))].sort(), [`${payer}:us-east-1`, `${memberA}:ap-northeast-2`]);
  assert.deepEqual(job.units.filter(unit => unit.service === 'health').map(unit => unit.accountId).sort(), [payer, memberA], 'AWS Health once per verified account');
  assert.ok(!s.calls.some(call => call.target?.accountId === memberB && call.operation !== 'identity'), 'an unassigned account is never read');
  assert.ok(!s.calls.some(call => call.target?.accountId === memberA && call.target.region === 'eu-west-1' && call.operation !== 'vpcs'), 'unused regions are only probed for VPCs');
  const failed = job.units.find(unit => unit.service === 'msk' && unit.accountId === memberA)!;
  assert.equal(failed.code, 'read_access_denied');
  const ec2 = job.units.find(unit => unit.service === 'ec2' && unit.accountId === memberA)!;
  assert.deepEqual(s.worker.syncUnit(context, ec2.id).unit.items, [{ id: 'i-0123456789abcdef0', name: `${memberA}-ap-northeast-2`, state: 'running', type: 't3.micro' }]);
  assert.equal(s.worker.status(context).status, 'connected', 'per-account/unit failures keep the session');
  assert.throws(() => s.worker.syncUnit(context, '00000000-0000-4000-8000-000000000000'), code('sync_unit_not_found'));
  await s.worker.logout(context); assert.throws(() => s.worker.syncStatus(context), code('sync_not_found'), 'logout discards sync results');
});

test('a member account answered by a different Identity Center user stops the sync and the session', async t => {
  const s = fixture(base, call => call.operation === 'identity' && call.target?.accountId === memberA ? identity(memberA, 'someone-else') : organization(call));
  t.after(() => s.worker.close()); await s.worker.verify(context);
  s.worker.startSync(context);
  for (let n = 0; n < 500 && s.worker.status(context).status === 'connected'; n++) await nextTurn();
  assert.notEqual(s.worker.status(context).status, 'connected');
  assert.throws(() => s.worker.syncStatus(context), code('sync_not_found'));
});

test('an OU scope is walked through its own child OUs only, and the account cap is enforced', async t => {
  const binding: CliBinding = { ...base, directory: { awsOrganizationId: 'o-synthetic1', parentId: 'ou-demo-11111111' }, inventory: { regions: ['us-east-1'], maxAccounts: 3 } };
  const s = fixture(binding, call => {
    if (call.operation === 'directory-accounts') { const parent = (call.input as DirectoryQuery).parentId;
      return { Items: parent === 'ou-demo-11111111' ? [{ Id: memberA, Name: 'A', State: 'ACTIVE' }] : [{ Id: memberB, Name: 'B', State: 'ACTIVE' }, { Id: suspended, Name: 'C', State: 'ACTIVE' }], HasMore: false, NextToken: null }; }
    if (call.operation === 'directory-ous') return { Items: (call.input as DirectoryQuery).parentId === 'ou-demo-11111111' ? [{ Id: 'ou-demo-22222222', Name: 'child' }] : [], HasMore: false, NextToken: null };
    if (call.operation === 'identity') return identity(call.target?.accountId ?? payer);
    return organization(call);
  });
  t.after(() => s.worker.close()); await s.worker.verify(context);
  s.worker.startSync(context); const job = await finished(s.worker);
  assert.deepEqual(job.accounts.map(account => account.accountId), [payer, memberA, memberB]);
  assert.ok(!s.calls.some(call => call.operation === 'directory-all-accounts' || call.operation === 'regions'), 'configured regions skip region discovery');
  assert.deepEqual([...new Set(s.calls.filter(call => call.operation.startsWith('directory-')).map(call => (call.input as DirectoryQuery).parentId))].sort(), ['ou-demo-11111111', 'ou-demo-22222222']);
});

test('aggregator mode reads inventory and VPC tags from AWS Config, drops accounts outside the scope and still checks operations directly', async t => {
  const binding: CliBinding = { ...base, inventory: { config: { aggregator: 'org-aggregator', accountId: memberA, region: 'us-east-1' } } };
  const row = (value: object) => JSON.stringify(value);
  const s = fixture(binding, call => {
    if (call.operation === 'config-query') {
      const type = (call.input as Extract<ReadQuery, { kind: 'config' }>).resourceType;
      const rows = type === 'AWS::EC2::VPC' ? [row({ accountId: memberA, awsRegion: 'eu-west-1', resourceId: 'vpc-1', tags: [{ key: 'Name', value: 'main' }] }), row({ accountId: memberA, awsRegion: 'us-west-2', resourceId: 'vpc-2', tags: [] }), row({ accountId: outside, awsRegion: 'eu-west-1', resourceId: 'vpc-3', tags: [{ key: 'x', value: 'y' }] })]
        : type === 'AWS::EKS::Cluster' ? [row({ accountId: memberA, awsRegion: 'eu-west-1', resourceId: 'arn', resourceName: 'platform', configuration: { Version: '1.33' } })]
        : type === 'AWS::EC2::Instance' ? [row({ accountId: outside, awsRegion: 'eu-west-1', resourceId: 'i-0000000000000001', configuration: { state: { name: 'running' } } })] : [];
      return { Results: rows, NextToken: null };
    }
    if (call.operation === 'eks-versions') return { Items: [{ name: '1.33', state: 'EXTENDED_SUPPORT' }], HasMore: false };
    if (call.operation === 'identity') return identity(call.target?.accountId ?? payer);
    return organization(call);
  });
  t.after(() => s.worker.close()); await s.worker.verify(context);
  const started = s.worker.startSync(context); assert.equal(started.mode, 'config');
  const job = await finished(s.worker);
  const a = job.accounts.find(account => account.accountId === memberA)!;
  assert.deepEqual(a.regions, [{ region: 'eu-west-1', vpcs: 1, taggedVpcs: 1 }, { region: 'us-west-2', vpcs: 1, taggedVpcs: 0 }]);
  assert.ok(!job.accounts.some(account => account.accountId === outside) && !job.units.some(unit => unit.accountId === outside), 'aggregator rows outside the scope are dropped');
  const eks = job.units.find(unit => unit.service === 'eks' && unit.accountId === memberA)!;
  assert.deepEqual(s.worker.syncUnit(context, eks.id).unit.items, [{ name: 'platform', version: '1.33', support: 'EXTENDED_SUPPORT' }]);
  assert.equal(s.worker.syncUnit(context, eks.id).unit.source, 'config');
  assert.ok(!s.calls.some(call => call.operation === 'vpcs'), 'no per-region VPC probes in aggregator mode');
  assert.ok(s.calls.some(call => call.operation === 'alarms' && call.target?.accountId === memberA && call.target.region === 'eu-west-1'), 'operational checks still read the used region directly');
  assert.ok(!s.calls.some(call => call.operation === 'ec2' && call.target?.accountId === memberA), 'inventory comes from Config, not per-region reads');
});

test('per-account profiles live in separate fixed config files; targets and Config queries use fixed arguments', () => {
  assert.equal(cliProfile(base, memberA), `cloudops-${base.connectionId}-a${memberA}`); assert.equal(cliProfile(base, payer), cliProfile(base));
  const config = cliConfig(base, memberA);
  assert.ok(config.includes(`[profile ${cliProfile(base, memberA)}]\nsso_session = ${cliProfile(base)}\nsso_account_id = ${memberA}\nsso_role_name = ReadOnlyAccess`));
  assert.throws(() => cliConfig(base, '12345'));
  const args = cliArguments(base, 'vpcs', undefined, { accountId: memberA, region: 'eu-west-1' });
  assert.deepEqual(args.slice(args.indexOf('--profile'), args.indexOf('--profile') + 4), ['--profile', cliProfile(base, memberA), '--region', 'eu-west-1']);
  for (const target of [{ accountId: '12', region: 'eu-west-1' }, { accountId: memberA, region: 'mars-1' }]) assert.throws(() => cliArguments(base, 'vpcs', undefined, target as CliTarget));
  assert.throws(() => cliArguments(base, 'directory-accounts', { parentId: 'r-demo' }, { accountId: memberA, region: 'us-east-1' }), code('invalid_read_query'));
  assert.throws(() => cliArguments(base, 'directory-all-accounts', { parentId: 'ou-demo-11111111' }), code('directory_scope_mismatch'));
  assert.throws(() => cliArguments(base, 'config-query', { kind: 'config', resourceType: 'AWS::EC2::VPC' }), code('config_not_configured'));
  const withConfig: CliBinding = { ...base, inventory: { config: { aggregator: 'org-aggregator', accountId: memberA, region: 'eu-west-1' } } };
  const query = cliArguments(withConfig, 'config-query', { kind: 'config', resourceType: 'AWS::EKS::Cluster' });
  assert.equal(query[query.indexOf('--expression') + 1], configExpression('AWS::EKS::Cluster'));
  assert.deepEqual(query.slice(query.indexOf('--profile'), query.indexOf('--profile') + 4), ['--profile', cliProfile(withConfig, memberA), '--region', 'eu-west-1']);
  assert.match(configExpression('AWS::RDS::DBInstance'), /^SELECT accountId, awsRegion, resourceId, resourceName, resourceType, .+ WHERE resourceType = 'AWS::RDS::DBInstance'$/);
});

test('Config rows map to items without guessing; malformed values are dropped', () => {
  assert.deepEqual(configItem('AWS::EC2::Instance', { resourceId: 'i-0000000000000001', configuration: { state: { name: 'running' }, instanceType: 't3.large' } }, [{ key: 'Name', value: 'web' }]),
    { service: 'ec2', item: { id: 'i-0000000000000001', name: 'web', state: 'running', type: 't3.large', tags: ['Name'] } });
  assert.deepEqual(configItem('AWS::RDS::DBInstance', { resourceId: 'db-ABC', resourceName: 'orders', configuration: { engine: 'postgres', engineVersion: '16.4', dBInstanceStatus: 'available' } }, []),
    { service: 'rds', item: { name: 'orders', state: 'available', version: 'postgres 16.4', tags: [] } });
  assert.deepEqual(configItem('AWS::DynamoDB::Table', { resourceName: 'events', configuration: { tableStatus: 'ACTIVE' } }, undefined),
    { service: 'dynamodb', item: { name: 'events', state: 'ACTIVE' } }, 'no tags column: tags stay unknown, not "untagged"');
  assert.equal(configItem('AWS::Lambda::Function', { configuration: { runtime: 'python3.12' } }, []), undefined, 'no name, no item');
  assert.equal(configItem('AWS::EC2::VPC', { resourceId: 'vpc-1' }, []), undefined);
});

test('governance reads: Security Hub/GuardDuty per used region, Health once per account, tag keys, and "not enabled" is a state, not a failure', async t => {
  const detector = 'a'.repeat(32), finding = 'b'.repeat(32);
  const binding: CliBinding = { ...base, directory: undefined, inventory: { regions: ['us-east-1'], requiredTags: ['Owner'] } };
  const s = fixture(binding, ({ operation, target }) => {
    switch (operation) {
      case 'identity': return identity(target?.accountId ?? payer);
      case 'vpcs': return { Total: 1, Tagged: 1, HasMore: false };
      case 'securityhub': return new CloudOperationError(409, 'service_not_enabled', 'synthetic');
      case 'health': return new CloudOperationError(409, 'service_not_subscribed', 'synthetic');
      case 'guardduty-detectors': return { Items: [detector], HasMore: false };
      case 'guardduty-findings': return { Items: [finding], HasMore: false };
      case 'guardduty-details': return { Items: [{ id: finding, name: 'Synthetic port probe', value: 8, type: 'Recon:EC2/PortProbeUnprotectedPort', detail: 'Instance', modified: '2026-10-10T00:00:00Z' }], HasMore: false };
      case 'lambda': return { Items: [{ name: 'fn-a', runtime: 'python3.12' }, { name: 'fn-b', runtime: 'python3.12' }], HasMore: false };
      case 'tagged-resources': return { Items: [{ arn: `arn:aws:lambda:us-east-1:${payer}:function:fn-a`, tags: ['Owner'] }], HasMore: false };
      case 'ec2': return { Items: [{ id: 'i-0123456789abcdef0', name: 'web', state: 'running', tags: ['Name', 'Owner'] }], HasMore: false };
      default: return { Items: [], HasMore: false };
    }
  });
  t.after(() => s.worker.close());
  await s.worker.verify(context); s.worker.startSync(context);
  const job = await finished(s.worker);
  assert.equal(job.state, 'completed', 'not enabled / not subscribed do not make the sync partial');
  const ref = (service: string) => job.units.find(unit => unit.service === service)!;
  assert.equal(ref('securityhub').code, 'read_not_enabled');
  assert.deepEqual([ref('health').region, ref('health').code], ['us-east-1', 'read_not_subscribed']);
  assert.equal(s.calls.filter(call => call.operation === 'health').length, 1, 'Health once per account');
  assert.deepEqual(s.calls.find(call => call.operation === 'guardduty-details')!.input, { kind: 'guardduty-details', detectorId: detector, findingIds: [finding] });
  const unit = (service: string) => s.worker.syncUnit(context, ref(service).id).unit;
  assert.deepEqual(unit('guardduty').items.map(item => [item.name, item.value]), [['Synthetic port probe', 8]]);
  assert.deepEqual(unit('lambda').items.map(item => [item.name, item.tags]), [['fn-a', ['Owner']], ['fn-b', []]], 'absent from a complete tagging page = no tags');
  assert.deepEqual(unit('ec2').items[0]!.tags, ['Name', 'Owner']);
});

test('tag keys stay unknown when the tagging page is incomplete or the tagging read fails; GuardDuty without a detector is "not enabled"', async t => {
  let tagging: unknown = { Items: [{ arn: `arn:aws:dynamodb:us-east-1:${payer}:table/orders`, tags: ['Owner'] }], HasMore: true };
  const binding: CliBinding = { ...base, directory: undefined, inventory: { regions: ['us-east-1'] } };
  const s = fixture(binding, ({ operation, target }) => operation === 'identity' ? identity(target?.accountId ?? payer) : operation === 'vpcs' ? { Total: 1, Tagged: 1, HasMore: false }
    : operation === 'dynamodb' ? { Items: [{ name: 'orders' }, { name: 'audit' }], HasMore: false } : operation === 'tagged-resources' ? tagging
    : operation === 'guardduty-detectors' ? { Items: [], HasMore: false } : { Items: [], HasMore: false });
  t.after(() => s.worker.close());
  await s.worker.verify(context);
  const read = async () => (await s.worker.inspect(context, 'dynamodb')).items.map(item => [item.name, item.tags]);
  assert.deepEqual(await read(), [['orders', ['Owner']], ['audit', undefined]]);
  tagging = denied();
  assert.deepEqual(await read(), [['orders', undefined], ['audit', undefined]], 'a denied tagging read leaves tags unknown and the inventory intact');
  await assert.rejects(s.worker.inspect(context, 'guardduty'), code('read_not_enabled'));
  assert.equal(s.worker.status(context).status, 'connected');
});

test('governance CLI arguments are fixed: findings limited to the target account/region, Health on us-east-1, IDs validated', () => {
  const target = { accountId: memberA, region: 'ap-northeast-2' };
  const hub = cliArguments(base, 'securityhub', undefined, target), input = JSON.parse(hub[hub.indexOf('--cli-input-json') + 1]!);
  assert.deepEqual([input.Filters.AwsAccountId[0].Value, input.Filters.Region[0].Value, input.Filters.SeverityLabel.map((entry: { Value: string }) => entry.Value)], [memberA, 'ap-northeast-2', ['CRITICAL', 'HIGH']]);
  const health = cliArguments(base, 'health', undefined, target);
  assert.deepEqual(health.slice(health.indexOf('--profile'), health.indexOf('--profile') + 4), ['--profile', cliProfile(base, memberA), '--region', 'us-east-1']);
  const listed = cliArguments(base, 'guardduty-findings', { kind: 'guardduty-findings', detectorId: 'c'.repeat(32) }, target);
  assert.deepEqual(JSON.parse(listed[listed.indexOf('--cli-input-json') + 1]!).FindingCriteria.Criterion.accountId, { Equals: [memberA] });
  assert.throws(() => cliArguments(base, 'guardduty-details', { kind: 'guardduty-details', detectorId: 'c'.repeat(32), findingIds: ['../x'] } as unknown as ReadQuery, target), code('invalid_read_query'));
  assert.throws(() => cliArguments(base, 'tagged-resources', { kind: 'tags', resourceType: 'ec2:instance' } as unknown as ReadQuery, target), code('invalid_read_query'));
  assert.match(cliArguments(base, 'ec2').join(' '), /tags:Tags\[\]\.Key \|\| `\[\]`/);
});
