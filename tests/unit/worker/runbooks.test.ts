import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { VerifiedCloudContext } from '../../../packages/contracts/access-context';
import { CloudOperationError } from '../../../packages/contracts/errors';
import { cliArguments, cliBindingSchema, cliConfig, cliProfile, type CliBinding, type CliOperation, type CliRuntime, type CliTarget, type RunbookQuery } from '../../../packages/worker-protocol/cli-contract';
import { workerCommandSchema } from '../../../packages/worker-protocol/commands';
import { OrganizationCliWorker } from '../../../apps/worker/src/cli-worker';

const binding: CliBinding = cliBindingSchema.parse({ connectionId: '11111111-1111-4111-8111-111111111111', organizationId: 'synthetic-org', workspaceId: 'workspace-a', actorId: 'actor-a',
  startUrl: 'https://synthetic-example.awsapps.com/start', ssoRegion: 'us-east-1', region: 'ap-northeast-2', accountId: '111111111111', roleName: 'ReadOnlyAccess',
  runbooks: { roleName: 'RunbookOperator', allowed: ['connectivity-check', 'ec2-restart'] } });
const context: VerifiedCloudContext = { actorId: binding.actorId, owner: { kind: 'organization', organizationId: binding.organizationId }, workspaceId: binding.workspaceId, channel: 'web', roles: ['viewer'] };
const code = (expected: string) => (error: unknown) => error instanceof CloudOperationError && error.code === expected;
const target: CliTarget = { accountId: '111111111111', region: 'ap-northeast-2' };
const executionId = '0d0d0d0d-1111-4222-8333-444444444444';
const identity = (role: string, person = 'synthetic.user', account = '111111111111') => JSON.stringify({ Account: account, UserId: 'AROASYNTHETIC:synthetic.user', Arn: `arn:aws:sts::${account}:assumed-role/AWSReservedSSO_${role}_0123456789abcdef/${person}` });

test('runbook CLI arguments come only from the catalog and use the separate runbook profile', () => {
  const start = cliArguments(binding, 'automation-start', { kind: 'start', runbook: 'ec2-restart', instanceId: 'i-0123456789abcdef0' }, target);
  assert.deepEqual(start.slice(0, 5), ['ssm', 'start-automation-execution', '--document-name', 'AWS-RestartEC2Instance', '--cli-input-json']);
  assert.deepEqual(JSON.parse(start[5]!), { Parameters: { InstanceId: ['i-0123456789abcdef0'] } });
  assert.equal(start[start.indexOf('--profile') + 1], `${cliProfile(binding)}-runbook`, 'never the read profile');
  assert.deepEqual(JSON.parse(cliArguments(binding, 'automation-start', { kind: 'start', runbook: 'connectivity-check' }, target)[5]!), {});
  assert.throws(() => cliArguments(binding, 'automation-start', { kind: 'start', runbook: 'ec2-stop', instanceId: 'i-0123456789abcdef0' }, target), code('runbook_not_allowed'));
  assert.throws(() => cliArguments(binding, 'automation-start', { kind: 'start', runbook: 'ec2-restart' }, target), code('invalid_runbook_target'));
  assert.throws(() => cliArguments(binding, 'automation-start', { kind: 'start', runbook: 'connectivity-check', instanceId: 'i-0123456789abcdef0' }, target), code('invalid_runbook_target'));
  assert.throws(() => cliArguments(binding, 'automation-start', { kind: 'start', runbook: 'ec2-restart', instanceId: 'i-0123;rm' } as RunbookQuery, target));
  assert.throws(() => cliArguments({ ...binding, runbooks: undefined }, 'runbook-identity', undefined, target), code('runbooks_not_configured'));
  const get = cliArguments(binding, 'automation-get', { kind: 'get', executionId }, { accountId: '222222222222', region: 'us-east-1' });
  assert.deepEqual(get.slice(0, 4), ['ssm', 'get-automation-execution', '--automation-execution-id', executionId]);
  assert.equal(get[get.indexOf('--profile') + 1], `${cliProfile(binding, '222222222222')}-runbook`);
  const config = cliConfig(binding, '222222222222');
  assert.match(config, new RegExp(`\\[profile ${cliProfile(binding)}-runbook\\][^\\[]*sso_role_name = RunbookOperator`));
  assert.match(config, new RegExp(`\\[profile ${cliProfile(binding)}\\][^\\[]*sso_role_name = ReadOnlyAccess`));
  assert.doesNotMatch(cliConfig({ ...binding, runbooks: undefined }), /runbook/, 'no runbook profile unless the server configured runbooks');
  assert.equal(workerCommandSchema.safeParse({ id: executionId, operation: 'runbook-start' }).success, false, 'a start always names the runbook and target');
  assert.equal(workerCommandSchema.safeParse({ id: executionId, operation: 'sync', runbook: { id: 'ec2-restart', ...target } }).success, false);
});

function worker(respond: (operation: CliOperation, input: unknown, target?: CliTarget) => string) {
  const calls: Array<{ operation: CliOperation; target?: CliTarget }> = [];
  const runtime: CliRuntime = { async run(operation, _signal, sink, input, target) {
    calls.push({ operation, target });
    if (operation === 'login') { sink?.('Browser will not be automatically opened.\nPlease visit the following URL:\n\nhttps://device.sso.us-east-1.amazonaws.com/\n\nThen enter the code:\n\nDEMO-CODE\n\nAlternatively, you may visit the following URL which will autofill the code upon loading:\nhttps://device.sso.us-east-1.amazonaws.com/?user_code=DEMO-CODE\n'); return { stdout: '' }; }
    return { stdout: respond(operation, input, target) };
  } };
  return { worker: new OrganizationCliWorker(binding, runtime, () => 1_800_000_000_000), calls };
}
const settle = async (value: OrganizationCliWorker) => { for (let index = 0; index < 50 && value.status(context).status !== 'connected'; index += 1) await new Promise(resolve => setTimeout(resolve, 1)); };

test('a runbook runs only for the same person on the runbook permission set, inside the verified scope', async () => {
  let runbookPerson = 'synthetic.user';
  const { worker: value, calls } = worker((operation, input) => {
    if (operation === 'identity') return identity('ReadOnlyAccess');
    if (operation === 'runbook-identity') return identity('RunbookOperator', runbookPerson);
    if (operation === 'automation-start') return JSON.stringify({ executionId });
    if (operation === 'automation-get') return JSON.stringify({ status: 'Success', startedAt: '2026-10-11T10:00:00.000+09:00', endedAt: '2026-10-11T10:00:03.000+09:00', failure: null });
    throw new Error(`unexpected ${operation} ${JSON.stringify(input)}`);
  });
  await assert.rejects(value.runbookStart(context, { id: 'connectivity-check', ...target }), code('connection_unavailable'), 'no AWS session yet');
  value.start(context); await settle(value);
  assert.deepEqual(await value.runbookStart(context, { id: 'connectivity-check', ...target }), { executionId });
  assert.deepEqual(calls.slice(-3).map(call => call.operation), ['identity', 'runbook-identity', 'automation-start']);
  assert.deepEqual(await value.runbookStatus(context, { id: executionId, ...target }), { executionId, status: 'Success', startedAt: '2026-10-11T01:00:00.000Z', endedAt: '2026-10-11T01:00:03.000Z' });
  await assert.rejects(value.runbookStart(context, { id: 'ec2-stop', ...target, instanceId: 'i-0123456789abcdef0' }), code('runbook_not_allowed'));
  await assert.rejects(value.runbookStart(context, { id: 'connectivity-check', accountId: '999999999999', region: 'ap-northeast-2' }), code('runbook_account_out_of_scope'), 'only the payer or accounts a sync verified');
  runbookPerson = 'someone.else';
  await assert.rejects(value.runbookStart(context, { id: 'connectivity-check', ...target }), code('runbook_identity_mismatch'));
  assert.equal(calls.filter(call => call.operation === 'automation-start').length, 1, 'nothing starts after an identity mismatch');
  assert.equal(value.status(context).status, 'connected', 'a missing runbook assignment fails only that call');
});
