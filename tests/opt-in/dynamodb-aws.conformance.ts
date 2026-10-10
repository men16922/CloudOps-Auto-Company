import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { identityActor, OrganizationWebAccess } from '../../server/cloud-auth';
import { DynamoDbCloudStore, environmentCredentials } from '../../server/cloud-dynamodb-store';
import { cloudStoreConformance } from '../../server/cloud-store-conformance';
import type { CloudStore } from '../../server/cloud-store';
import { OrganizationConnections } from '../../server/modules/aws/organization/organization-connections';

// Opt-in, explicitly approved runs only: creates ONE temporary provisioned 5/5 table, runs the CloudStore
// conformance and registry flow with synthetic data under per-test key prefixes, then deletes the table.
if (process.env.CLOUDOPS_DYNAMODB_AWS_APPROVED !== '1') throw new Error('Set CLOUDOPS_DYNAMODB_AWS_APPROVED=1 for an approved real DynamoDB run.');
const region = process.env.CLOUDOPS_DYNAMODB_AWS_REGION ?? 'us-east-1', tableName = `cloudops-conformance-${randomUUID()}`;
const admin = new DynamoDbCloudStore({ tableName, region }, { credentials: environmentCredentials() });
const prefixed = (store: CloudStore, prefix: string): CloudStore => ({
  transact: body => store.transact(tx => body({ get: key => tx.get(`${prefix}${key}`), put: (key, value) => tx.put(`${prefix}${key}`, value) })),
});
const status = async () => ((await admin.call('DescribeTable', { TableName: tableName })) as { Table: { TableStatus: string } }).Table.TableStatus;
before(async () => {
  await admin.call('CreateTable', { TableName: tableName, BillingMode: 'PROVISIONED', ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
    AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }], KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
    Tags: [{ Key: 'purpose', Value: 'cloudops-conformance-temporary' }] });
  for (let attempt = 0; attempt < 60 && await status() !== 'ACTIVE'; attempt++) await new Promise(resolve => setTimeout(resolve, 2000));
  console.log(`temporary table ACTIVE in ${region}`);
});
after(async () => {
  await admin.call('DeleteTable', { TableName: tableName });
  let gone = false;
  for (let attempt = 0; attempt < 60 && !gone; attempt++) { try { await status(); await new Promise(resolve => setTimeout(resolve, 2000)); } catch { gone = true; } }
  console.log(gone ? 'temporary table deleted' : 'temporary table deletion requested (still DELETING)');
});
const store = () => new DynamoDbCloudStore({ tableName, region }, { credentials: environmentCredentials() });
cloudStoreConformance('DynamoDbCloudStore (AWS DynamoDB)', async () => {
  const prefix = `${randomUUID()}:`;
  return { store: prefixed(store(), prefix), reopen: async () => prefixed(store(), prefix), close: async () => undefined };
});
test('organization membership and connection registry run on AWS DynamoDB', async () => {
  const subject = prefixed(store(), `${randomUUID()}:`), issuer = 'https://idp.example.invalid/synthetic', actorId = identityActor(issuer, 'employee-a');
  const access = new OrganizationWebAccess({ async verify() { return { actorId, expiresAt: Date.now() + 600_000 }; } }, subject);
  await access.provision({ organizationId: 'synthetic-org', workspaceId: 'synthetic-workspace', actorId, active: true, roles: ['viewer'], version: 1, updatedAt: new Date().toISOString() });
  const connections = new OrganizationConnections(subject, access, { async invoke() { return { ok: false, code: 'worker_unavailable' }; } },
    [{ configurationId: 'aws-read', label: 'Synthetic', organizationId: 'synthetic-org', workspaceId: 'synthetic-workspace', startUrl: 'https://synthetic-example.awsapps.com/start', ssoRegion: 'us-east-1', region: 'us-east-1', accountId: '123456789012', roleName: 'ReadOnlyAccess' }]);
  const session = await access.authenticate('Bearer synthetic', 'synthetic-org', 'synthetic-workspace');
  const requestKey = randomUUID(), created = await connections.create(session, { configurationId: 'aws-read', requestKey });
  assert.deepEqual(await connections.create(session, { configurationId: 'aws-read', requestKey }), created);
  assert.deepEqual((await connections.list(session)).items.map(item => item.id), [created.id]);
  await access.provision({ organizationId: 'synthetic-org', workspaceId: 'synthetic-workspace', actorId, active: false, roles: ['viewer'], version: 2, updatedAt: new Date().toISOString() });
  await assert.rejects(connections.list(session));
});
