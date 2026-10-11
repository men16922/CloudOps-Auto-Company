import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { CloudOperationError } from '../../../packages/contracts/errors';
import { DynamoDbCloudStore, dynamoDbStoreConfigSchema, environmentCredentials, signAwsRequest } from '../../../apps/host/src/storage/dynamodb-store';
import { cloudStoreConformance } from './store-conformance';

// No AWS endpoint is contacted: signatures are compared with botocore/AWS-documented vectors and the
// store runs against an in-process fake that implements the DynamoDB calls this adapter uses.
const example = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' }, date = new Date('2015-08-30T12:36:00Z');
test('SigV4 matches the AWS documentation example and botocore for DynamoDB and encoded paths/queries', () => {
  const signature = (headers: Record<string, string>) => headers.authorization!.split('Signature=')[1];
  assert.equal(signature(signAwsRequest({ method: 'GET', url: 'https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08', region: 'us-east-1', service: 'iam', body: '',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' }, credentials: example, date })), '5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7');
  const dynamo = signAwsRequest({ method: 'POST', url: 'https://dynamodb.ap-northeast-2.amazonaws.com/', region: 'ap-northeast-2', service: 'dynamodb',
    body: '{"TableName":"cloudops-records","Key":{"pk":{"S":"membership:abc"}},"ConsistentRead":true}',
    headers: { 'Content-Type': 'application/x-amz-json-1.0', 'X-Amz-Target': 'DynamoDB_20120810.GetItem' }, credentials: { ...example, sessionToken: 'synthetic-session-token' }, date });
  assert.equal(signature(dynamo), 'f0a2a00545f9fb15e1638a0a99167956ebc4c89ade327d557415b4884498b3d2');
  assert.match(dynamo.authorization!, /SignedHeaders=content-type;host;x-amz-date;x-amz-security-token;x-amz-target,/);
  assert.equal(signature(signAwsRequest({ method: 'GET', url: 'https://example.amazonaws.com/a%20b/c?b=2&a=1&a=0&sp=x%20y', region: 'us-west-2', service: 'service', body: '', headers: {}, credentials: example, date })),
    'ec3088372345415eb21e5324849fde789741edc5883bc94b433037c8104a2922');
});

type Record_ = { version: number; payload: string };
/** Minimal DynamoDB semantics for GetItem/TransactWriteItems with version/attribute_not_exists conditions. */
async function fakeDynamo(options: { dropFirstCommitResponse?: boolean; failures?: number } = {}) {
  const table = new Map<string, Record_>(), tokens = new Map<string, string>(), calls: string[] = [];
  let dropped = false, failures = options.failures ?? 0;
  const server: Server = createServer(async (request, response) => {
    let text = ''; for await (const chunk of request) text += chunk;
    const target = String(request.headers['x-amz-target']).replace('DynamoDB_20120810.', ''); calls.push(target);
    const send = (status: number, value: unknown) => { response.writeHead(status, { 'Content-Type': 'application/x-amz-json-1.0' }); response.end(JSON.stringify(value)); };
    assert.match(String(request.headers.authorization), /^AWS4-HMAC-SHA256 Credential=synthetic\/\d{8}\/us-east-1\/dynamodb\/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-target, Signature=[a-f0-9]{64}$/);
    const body = JSON.parse(text);
    if (target === 'GetItem') {
      assert.equal(body.ConsistentRead, true);
      const item = table.get(body.Key.pk.S); send(200, item ? { Item: { pk: { S: body.Key.pk.S }, version: { N: String(item.version) }, payload: { S: item.payload } } } : {}); return;
    }
    if (target !== 'TransactWriteItems') { send(400, { __type: 'com.amazonaws.dynamodb.v20120810#UnknownOperationException' }); return; }
    if (failures > 0) { failures--; send(500, { __type: 'com.amazonaws.dynamodb.v20120810#InternalServerError' }); return; }
    const fingerprint = JSON.stringify(body.TransactItems);
    if (tokens.has(body.ClientRequestToken)) { assert.equal(tokens.get(body.ClientRequestToken), fingerprint); send(200, {}); return; }
    const reasons = body.TransactItems.map((item: Record<string, { Key?: { pk: { S: string } }; Item?: { pk: { S: string } }; ConditionExpression: string; ExpressionAttributeValues?: Record<string, { N: string }> }>) => {
      const action = item.Put ?? item.ConditionCheck!, key = (action.Item ?? action.Key)!.pk.S, current = table.get(key);
      const ok = action.ConditionExpression === 'attribute_not_exists(pk)' ? !current : current?.version === Number(action.ExpressionAttributeValues![':v']!.N);
      return ok ? 'None' : 'ConditionalCheckFailed';
    });
    if (reasons.some((reason: string) => reason !== 'None')) { send(400, { __type: 'com.amazonaws.dynamodb.v20120810#TransactionCanceledException', CancellationReasons: reasons.map((Code: string) => ({ Code })) }); return; }
    for (const item of body.TransactItems) if (item.Put) table.set(item.Put.Item.pk.S, { version: Number(item.Put.Item.version.N), payload: item.Put.Item.payload.S });
    tokens.set(body.ClientRequestToken, fingerprint);
    if (options.dropFirstCommitResponse && !dropped) { dropped = true; request.socket.destroy(); return; }
    send(200, {});
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const store = () => new DynamoDbCloudStore({ tableName: 'cloudops-records', region: 'us-east-1', endpoint }, { credentials: async () => ({ accessKeyId: 'synthetic', secretAccessKey: 'synthetic-secret' }) });
  return { table, calls, store, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

cloudStoreConformance('DynamoDbCloudStore (in-process fake)', async () => {
  const fake = await fakeDynamo();
  return { store: fake.store(), reopen: async () => fake.store(), close: fake.close };
});

test('a lost commit response is resent with the same token and applied exactly once', async t => {
  const fake = await fakeDynamo({ dropFirstCommitResponse: true }); t.after(fake.close);
  await fake.store().transact(async tx => { await tx.get('k'); tx.put('k', { value: 1 }); });
  assert.deepEqual(fake.table.get('k'), { version: 1, payload: '{"value":1}' });
  assert.deepEqual(fake.calls.filter(call => call === 'TransactWriteItems').length, 2);
});

test('repeated server failures report store_unavailable without retrying the callback as a conflict', async t => {
  const fake = await fakeDynamo({ failures: 3 }); t.after(fake.close);
  let calls = 0;
  await assert.rejects(fake.store().transact(async tx => { calls++; await tx.get('k'); tx.put('k', 1); }), (error: unknown) => error instanceof CloudOperationError && error.code === 'store_unavailable');
  assert.equal(calls, 1); assert.equal(fake.table.size, 0);
});

test('single reads skip the commit call; multi-key read-only transactions are validated', async t => {
  const fake = await fakeDynamo(); t.after(fake.close);
  const store = fake.store();
  await store.transact(tx => tx.get('a'));
  assert.deepEqual(fake.calls, ['GetItem']);
  await store.transact(async tx => [await tx.get('a'), await tx.get('b')]);
  assert.deepEqual(fake.calls, ['GetItem', 'GetItem', 'GetItem', 'TransactWriteItems']);
});

test('configuration and credentials fail closed', async () => {
  for (const endpoint of ['http://dynamodb.example.invalid', 'https://dynamodb.example.invalid/path', 'ftp://127.0.0.1']) assert.equal(dynamoDbStoreConfigSchema.safeParse({ tableName: 'cloudops-records', region: 'us-east-1', endpoint }).success, false, endpoint);
  assert.ok(dynamoDbStoreConfigSchema.parse({ tableName: 'cloudops-records', region: 'ap-northeast-2' }));
  await assert.rejects(environmentCredentials({})(), (error: unknown) => error instanceof CloudOperationError && error.code === 'store_credentials_unavailable');
  assert.deepEqual(await environmentCredentials({ AWS_ACCESS_KEY_ID: 'synthetic', AWS_SECRET_ACCESS_KEY: 'secret' })(), { accessKeyId: 'synthetic', secretAccessKey: 'secret' });
});
