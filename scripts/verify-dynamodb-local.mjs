// Opt-in: start DynamoDB Local in Docker on loopback, run the CloudStore conformance and registry checks, then run the
// built local host on a DynamoDB store (membership bootstrap, OIDC sign-in, connection create/list), and stop it.
// NOT part of `make check`. No AWS account, credentials or network endpoint is used.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DynamoDbCloudStore } from '../dist-company-api/organization.mjs';

const image = process.env.CLOUDOPS_DYNAMODB_LOCAL_IMAGE ?? 'amazon/dynamodb-local@sha256:d89f8fcc6b1a39cb35976c248ed42a28c66ae00dc043099210f5571e42648ab4', port = process.env.CLOUDOPS_DYNAMODB_LOCAL_PORT ?? '18000';
const name = `cloudops-dynamodb-local-${process.pid}`, endpoint = `http://127.0.0.1:${port}`;
const localEnv = { ...process.env, AWS_ACCESS_KEY_ID: 'local', AWS_SECRET_ACCESS_KEY: 'local', AWS_SESSION_TOKEN: '', AWS_PROFILE: '' };
delete localEnv.AWS_SESSION_TOKEN;
execFileSync('docker', ['run', '--rm', '-d', '--name', name, '-p', `127.0.0.1:${port}:8000`, image, '-jar', 'DynamoDBLocal.jar', '-inMemory'], { stdio: ['ignore', 'ignore', 'inherit'] });
const directory = await mkdtemp(join(tmpdir(), 'cloudops-dynamodb-host-'));
let host;
try {
  for (let attempt = 0; attempt < 60; attempt++) { try { await fetch(endpoint); break; } catch { await new Promise(resolve => setTimeout(resolve, 500)); } }
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', 'tests/opt-in/dynamodb-local.conformance.ts'], { stdio: 'inherit', env: { ...localEnv, CLOUDOPS_DYNAMODB_LOCAL_ENDPOINT: endpoint } });
  if (result.status !== 0) throw new Error('DynamoDB Local conformance failed.');

  const tableName = `cloudops-host-${randomUUID()}`, storeConfig = { tableName, region: 'us-east-1', endpoint };
  await new DynamoDbCloudStore(storeConfig, { credentials: async () => ({ accessKeyId: 'local', secretAccessKey: 'local' }) }).call('CreateTable', {
    TableName: tableName, BillingMode: 'PAY_PER_REQUEST', AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }], KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }] });
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const hostPort = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const origin = `http://127.0.0.1:${hostPort}`, issuer = 'https://idp.example.invalid/dynamodb-host', audience = 'cloudops-dynamodb-host';
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 }), part = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const token = () => { const now = Math.floor(Date.now() / 1000), data = `${part({ alg: 'RS256', typ: 'JWT', kid: 'h1' })}.${part({ iss: issuer, aud: audience, sub: 'employee-a', iat: now, exp: now + 600 })}`; return `${data}.${sign('sha256', Buffer.from(data), keys.privateKey).toString('base64url')}`; };
  const scope = { organizationId: 'synthetic-org', workspaceId: 'synthetic-workspace' };
  const env = { ...localEnv, CLOUDOPS_LOCAL_PORT: String(hostPort), CLOUDOPS_DYNAMODB_STORE: join(directory, 'store.json'), CLOUDOPS_DEPLOYMENT: join(directory, 'deployment.json'), CLOUDOPS_WEB_IDENTITY: join(directory, 'identity.json') };
  await writeFile(env.CLOUDOPS_DYNAMODB_STORE, JSON.stringify(storeConfig));
  await writeFile(env.CLOUDOPS_DEPLOYMENT, JSON.stringify({ publicOrigin: origin, web: { configured: true, scope: { ...scope, label: 'Synthetic DynamoDB host' }, identity: { method: 'company' } },
    connections: [{ configurationId: 'aws-read', label: 'Synthetic read', ...scope, startUrl: 'https://synthetic-example.awsapps.com/start', ssoRegion: 'us-east-1', region: 'us-east-1', accountId: '123456789012', roleName: 'ReadOnlyAccess' }] }));
  await writeFile(env.CLOUDOPS_WEB_IDENTITY, JSON.stringify({ kind: 'oidc', issuer, audience, jwks: { keys: [{ ...keys.publicKey.export({ format: 'jwk' }), kid: 'h1', use: 'sig' }] } }));
  const cli = (...args) => spawnSync(process.execPath, ['dist-company-api/local.mjs', ...args], { env, encoding: 'utf8' });
  await writeFile(join(directory, 'membership.json'), JSON.stringify({ ...scope, actorId: cli('actor', '--issuer', issuer, '--subject', 'employee-a').stdout.trim(), active: true, roles: ['viewer'], version: 1, updatedAt: new Date().toISOString() }));
  const provisioned = cli('provision-membership', join(directory, 'membership.json'));
  if (provisioned.status !== 0) throw new Error(`membership bootstrap failed: ${provisioned.stderr}`);
  host = spawn(process.execPath, ['dist-company-api/local.mjs', 'serve'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; host.stdout.on('data', chunk => { output += chunk; }); host.stderr.on('data', chunk => { output += chunk; });
  for (let i = 0; i < 100 && !output.includes('Local organization host'); i++) { if (host.exitCode !== null) throw new Error(output); await new Promise(resolve => setTimeout(resolve, 50)); }
  const base = `${origin}/api/organizations/v1/${scope.organizationId}/workspaces/${scope.workspaceId}/aws/connections`, headers = () => ({ Origin: origin, Authorization: `Bearer ${token()}` });
  const created = await fetch(base, { method: 'POST', headers: { ...headers(), 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: JSON.stringify({ configurationId: 'aws-read' }) });
  const list = await (await fetch(base, { headers: headers() })).json();
  const ok = created.status === 200 && list.items.length === 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} local host on DynamoDB store — create ${created.status}, listed ${list.items.length}`);
  process.exitCode = ok ? 0 : 1;
} finally {
  if (host && host.exitCode === null) { host.kill('SIGTERM'); await once(host, 'exit'); }
  spawnSync('docker', ['stop', name], { stdio: 'ignore' });
  await rm(directory, { recursive: true, force: true });
}
