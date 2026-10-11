import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { identityActor, OrganizationWebAccess } from '../../apps/host/src/identity/web-access';
import { DynamoDbCloudStore } from '../../apps/host/src/storage/dynamodb-store';
import { cloudStoreConformance } from '../contract/storage/store-conformance';
import { OrganizationConnections } from '../../apps/host/src/connections/connections';

// Opt-in: DynamoDB Local only (loopback endpoint, dummy credentials). Never point this at an AWS account.
const endpoint = process.env.CLOUDOPS_DYNAMODB_LOCAL_ENDPOINT ?? '';
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(endpoint)) throw new Error('Set CLOUDOPS_DYNAMODB_LOCAL_ENDPOINT=http://127.0.0.1:<port> (DynamoDB Local).');
const credentials = async () => ({ accessKeyId: 'local', secretAccessKey: 'local' });
async function table() {
  const tableName = `cloudops-conformance-${randomUUID()}`, config = { tableName, region: 'us-east-1', endpoint };
  const admin = new DynamoDbCloudStore(config, { credentials });
  await admin.call('CreateTable', { TableName: tableName, BillingMode: 'PAY_PER_REQUEST', AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }], KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }] });
  return { store: new DynamoDbCloudStore(config, { credentials }), reopen: async () => new DynamoDbCloudStore(config, { credentials }),
    close: async () => { await admin.call('DeleteTable', { TableName: tableName }); } };
}
cloudStoreConformance('DynamoDbCloudStore (DynamoDB Local)', table);

test('organization membership and connection registry run on DynamoDB Local', async () => {
  const subject = await table();
  try {
    const issuer = 'https://idp.example.invalid/synthetic', actorId = identityActor(issuer, 'employee-a');
    const access = new OrganizationWebAccess({ async verify() { return { actorId, expiresAt: Date.now() + 600_000 }; } }, subject.store);
    await access.provision({ organizationId: 'synthetic-org', workspaceId: 'synthetic-workspace', actorId, active: true, roles: ['viewer'], version: 1, updatedAt: new Date().toISOString() });
    const connections = new OrganizationConnections(subject.store, access, { async invoke() { return { ok: false, code: 'worker_unavailable' }; } },
      [{ configurationId: 'aws-read', label: 'Synthetic', organizationId: 'synthetic-org', workspaceId: 'synthetic-workspace', startUrl: 'https://synthetic-example.awsapps.com/start', ssoRegion: 'us-east-1', region: 'us-east-1', accountId: '123456789012', roleName: 'ReadOnlyAccess' }]);
    const session = await access.authenticate('Bearer synthetic', 'synthetic-org', 'synthetic-workspace');
    const requestKey = randomUUID(), created = await connections.create(session, { configurationId: 'aws-read', requestKey });
    assert.deepEqual(await connections.create(session, { configurationId: 'aws-read', requestKey }), created, 'idempotent replay');
    assert.deepEqual((await connections.list(session)).items.map(item => item.id), [created.id]);
    await access.provision({ organizationId: 'synthetic-org', workspaceId: 'synthetic-workspace', actorId, active: false, roles: ['viewer'], version: 2, updatedAt: new Date().toISOString() });
    await assert.rejects(connections.list(session));
  } finally { await subject.close(); }
});
