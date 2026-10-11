import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CloudOperationError } from '../../../packages/contracts/errors';
import { checkedCliIdentity, cliBindingSchema } from '../../../packages/worker-protocol/cli-contract';

// Synthetic values only. The Identity Center user name is the role session name at the end of the STS ARN.
const base = cliBindingSchema.parse({ connectionId: '11111111-1111-4111-8111-111111111111', organizationId: 'synthetic-org', workspaceId: 'workspace-a', actorId: 'actor-a',
  startUrl: 'https://synthetic-example.awsapps.com/start', ssoRegion: 'us-east-1', region: 'us-east-1', accountId: '123456789012', roleName: 'ReadOnlyAccess' });
const raw = (session: string) => JSON.stringify({ Account: base.accountId, Arn: `arn:aws:sts::${base.accountId}:assumed-role/AWSReservedSSO_${base.roleName}_0123456789abcdef/${session}`, UserId: `AROA_SYNTHETIC:${session}` });
const code = (expected: string) => (error: unknown) => error instanceof CloudOperationError && error.code === expected;

test('without a login name the identity check is unchanged (the match is a deployment option, off by default)', () => {
  assert.equal(checkedCliIdentity(raw('anyone@example.invalid'), base).accountId, base.accountId);
});

test('with a login name, the AWS session name must be the same person (case-insensitive); another approver is refused', () => {
  const binding = cliBindingSchema.parse({ ...base, loginName: 'Employee-A@example.invalid' });
  assert.equal(checkedCliIdentity(raw('employee-a@example.invalid'), binding).userId, 'AROA_SYNTHETIC:employee-a@example.invalid');
  assert.throws(() => checkedCliIdentity(raw('employee-b@example.invalid'), binding), code('web_identity_mismatch'));
  // A prefix or suffix of the name is not a match.
  assert.throws(() => checkedCliIdentity(raw('employee-a@example.invalid.evil'), binding), code('web_identity_mismatch'));
  // The account/role checks still come first.
  assert.throws(() => checkedCliIdentity(raw('employee-a@example.invalid').replace('ReadOnlyAccess', 'Other'), binding), code('identity_mismatch'));
});

test('the login name is part of the binding digest input, so a stored connection without it no longer matches', () => {
  assert.notDeepEqual(JSON.stringify(cliBindingSchema.parse({ ...base, loginName: 'a@example.invalid' })), JSON.stringify(base));
  assert.throws(() => cliBindingSchema.parse({ ...base, loginName: '' }));
});
