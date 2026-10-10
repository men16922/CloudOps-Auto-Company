import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, type RequestListener } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { identityActor } from './cloud-auth';
import { SqliteCloudStore } from './cloud-sqlite-store';
import { composeOrganizationApi, organizationDeploymentSchema } from './modules/aws/organization';
import { checkedConfiguration, deploymentSummary, dockerProvisionerFromConfig, provisionLocalMembership, reconcileLocalWorker, startLocalOrganizationHost } from './organization-local-host';
import { OrganizationWorkerLeases, workerLeaseHandle } from './modules/aws/organization/organization-worker-leases';
import { OrganizationWebAccess } from './cloud-auth';
import { OrganizationConnections } from './modules/aws/organization/organization-connections';
import { OidcJwtVerifier, type OidcVerifierConfig } from './oidc-web-identity';

// Synthetic deployment, keys and memberships only. No IdP, AWS CLI, Docker or company endpoint is used.
const issuer = 'https://idp.example.invalid/tenant', audience = 'cloudops-synthetic-api';
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const webIdentity = { kind: 'oidc', issuer, audience, jwks: { keys: [{ ...keys.publicKey.export({ format: 'jwk' }), kid: 'synthetic-1', use: 'sig' }] } } as OidcVerifierConfig;
const example = JSON.parse(readFileSync('deploy/organization-web.example.json', 'utf8')) as { publicOrigin: string; web: { configured: true; scope: { organizationId: string; workspaceId: string } }; connections: Array<Record<string, unknown>> };
const scope = example.web.scope;
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
function token(subject: string, claims: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  const data = `${b64({ alg: 'RS256', typ: 'JWT', kid: 'synthetic-1' })}.${b64({ iss: issuer, aud: audience, sub: subject, iat: now, exp: now + 600, ...claims })}`;
  return `${data}.${sign('sha256', Buffer.from(data), keys.privateKey).toString('base64url')}`;
}
const membership = (subject: string, version = 1, active = true) => ({ organizationId: scope.organizationId, workspaceId: scope.workspaceId, actorId: identityActor(issuer, subject), active, roles: ['viewer'], version, updatedAt: new Date().toISOString() });
async function storeFor(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'cloudops-organization-deployment-')), store = new SqliteCloudStore(join(directory, 'cloud.sqlite'));
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, store };
}
/** Listen first so the trusted publicOrigin can name the real loopback port. */
async function listen(t: TestContext) {
  let handler: RequestListener = (_request, response) => { response.writeHead(503); response.end(); };
  const server = createServer((request, response) => handler(request, response));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const { port } = server.address() as { port: number };
  return { origin: `http://127.0.0.1:${port}`, use: (value: RequestListener) => { handler = value; } };
}
const browserHeaders = (origin: string, extra: Record<string, string> = {}) => ({ Origin: origin, 'Sec-Fetch-Site': 'same-origin', ...extra });

test('the deployment example validates and unsafe or cross-scope deployments are rejected', () => {
  assert.equal(organizationDeploymentSchema.parse(example).connections.length, 1);
  const [connection] = example.connections;
  const invalid: unknown[] = [
    { ...example, publicOrigin: 'http://cloudops.example.invalid' },
    { ...example, publicOrigin: 'https://cloudops.example.invalid/app' },
    { ...example, web: { ...example.web, identity: { method: 'firebase-google', firebase: { apiKey: 'A'.repeat(39), projectId: 'synthetic-project', authDomain: 'synthetic.example.invalid', appId: '1:2:web:3' } } } },
    { ...example, connections: [{ ...connection, workspaceId: 'another-workspace' }] },
    { ...example, connections: [connection, { ...connection }] },
    { ...example, connections: [{ ...connection, profile: 'default' }] },
    { ...example, connections: [{ ...connection, startUrl: 'https://login.example.invalid/start' }] },
    { publicOrigin: example.publicOrigin, web: { configured: false }, connections: [connection] },
    { ...example, verifier: webIdentity },
  ];
  for (const value of invalid) assert.equal(organizationDeploymentSchema.safeParse(value).success, false, JSON.stringify(value).slice(0, 160));
  assert.ok(organizationDeploymentSchema.parse({ publicOrigin: 'http://127.0.0.1:5176', web: { configured: false }, connections: [] }));
});

test('composition without a verifier stays unconfigured and fails closed', async t => {
  const { store } = await storeFor(t), local = await listen(t);
  const composition = composeOrganizationApi({ deployment: { ...example, publicOrigin: local.origin }, store });
  t.after(() => composition.close());
  assert.equal(composition.configured, false); local.use(composition.listener);
  assert.deepEqual(await (await fetch(`${local.origin}/api/organizations/config`)).json(), { configured: false });
  assert.equal((await fetch(`${local.origin}/api/organizations/v1/${scope.organizationId}/workspaces/${scope.workspaceId}/aws/connections`, { headers: { Authorization: `Bearer ${token('employee-a')}` } })).status, 503);
});

test('OIDC composition authenticates, rechecks membership and keeps worker calls unavailable without a provisioner', async t => {
  const { store } = await storeFor(t), local = await listen(t);
  const composition = composeOrganizationApi({ deployment: { ...example, publicOrigin: local.origin }, store, verifier: new OidcJwtVerifier(webIdentity) });
  t.after(() => composition.close());
  assert.equal(composition.configured, true); local.use(composition.listener);
  await provisionLocalMembership(store, membership('employee-a'));
  await assert.rejects(provisionLocalMembership(store, membership('employee-a')), 'membership versions only move forward');
  const base = `${local.origin}/api/organizations/v1/${scope.organizationId}/workspaces/${scope.workspaceId}/aws/connections`;
  const config = await fetch(`${local.origin}/api/organizations/config`, { headers: { 'Sec-Fetch-Site': 'same-origin' } });
  assert.deepEqual(await config.json(), example.web);
  const list = await fetch(base, { headers: browserHeaders(local.origin, { Authorization: `Bearer ${token('employee-a')}` }) });
  assert.equal(list.status, 200);
  assert.deepEqual((await list.json() as { configurations: Array<{ id: string }> }).configurations.map(item => item.id), ['aws-read']);
  assert.equal((await fetch(base, { headers: browserHeaders(local.origin, { Authorization: `Bearer ${token('employee-b')}` }) })).status, 403, 'a valid sign-in without membership is not access');
  assert.equal((await fetch(base, { headers: browserHeaders(local.origin, { Authorization: `Bearer ${token('employee-a', { aud: 'another-api' })}` }) })).status, 401);
  assert.equal((await fetch(base, { headers: browserHeaders('https://attacker.example.invalid', { Authorization: `Bearer ${token('employee-a')}` }) })).status, 403);
  const created = await fetch(base, { method: 'POST', body: JSON.stringify({ configurationId: 'aws-read' }),
    headers: browserHeaders(local.origin, { Authorization: `Bearer ${token('employee-a')}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }) });
  assert.equal(created.status, 200);
  const { id } = await created.json() as { id: string };
  const status = await fetch(`${base}/${id}/status`, { headers: browserHeaders(local.origin, { Authorization: `Bearer ${token('employee-a')}` }) });
  assert.equal(status.status, 503); assert.equal((await status.json() as { code: string }).code, 'worker_unavailable');
  await provisionLocalMembership(store, membership('employee-a', 2, false));
  assert.equal((await fetch(base, { headers: browserHeaders(local.origin, { Authorization: `Bearer ${token('employee-a')}` }) })).status, 403, 'revoked membership is rechecked per request');
});

test('the loopback host serves the web build same-origin, contains static paths and refuses non-loopback or mismatched origins', async t => {
  const { directory, store } = await storeFor(t), webRoot = join(directory, 'web'), secret = join(directory, 'outside.txt');
  await mkdir(join(webRoot, 'assets'), { recursive: true });
  await writeFile(join(webRoot, 'index.html'), '<!doctype html><title>synthetic</title>'); await writeFile(join(webRoot, 'assets', 'app.js'), 'console.log(1)');
  await writeFile(secret, 'outside'); await symlink(secret, join(webRoot, 'assets', 'link.txt'));
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const { port } = probe.address() as { port: number }; await new Promise<void>(resolve => probe.close(() => resolve()));
  const origin = `http://127.0.0.1:${port}`;
  await assert.rejects(startLocalOrganizationHost({ deployment: { ...example, publicOrigin: origin }, webIdentity, store, webRoot, host: '0.0.0.0', port }));
  await assert.rejects(startLocalOrganizationHost({ deployment: example, webIdentity, store, webRoot, host: '127.0.0.1', port }), /publicOrigin/);
  const host = await startLocalOrganizationHost({ deployment: { ...example, publicOrigin: origin }, webIdentity, store, webRoot, host: '127.0.0.1', port });
  t.after(() => host.close());
  assert.equal(host.configured, true);
  const index = await fetch(`${origin}/`);
  assert.equal(index.status, 200); assert.match(index.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/); assert.equal(index.headers.get('cache-control'), 'no-store');
  assert.equal((await fetch(`${origin}/assets/app.js`)).headers.get('content-type'), 'text/javascript; charset=utf-8');
  for (const path of ['/assets/link.txt', '/%2e%2e/outside.txt', '/assets', '/missing.js']) assert.equal((await fetch(`${origin}${path}`)).status, 404, path);
  assert.equal((await fetch(`${origin}/`, { method: 'POST' })).status, 405);
  assert.deepEqual(await (await fetch(`${origin}/api/organizations/config`, { headers: { 'Sec-Fetch-Site': 'same-origin' } })).json(), example.web);
  assert.equal((await fetch(`${origin}/api/state`)).status, 404);
});

test('browser OIDC and server verifier must pair, and the operator summary masks company values', () => {
  const oidc = { issuer, clientId: audience, authorizationEndpoint: 'https://idp.example.invalid/authorize', tokenEndpoint: 'https://idp.example.invalid/token' };
  const paired = { ...example, web: { ...example.web, identity: { method: 'company', oidc } } };
  assert.equal(checkedConfiguration(paired, webIdentity).browser?.bearer, 'id_token');
  assert.throws(() => checkedConfiguration({ ...paired, web: { ...paired.web, identity: { method: 'company', oidc: { ...oidc, clientId: 'another-client' } } } }, webIdentity), /must match/);
  assert.throws(() => checkedConfiguration({ ...paired, web: { ...paired.web, identity: { method: 'company', oidc: { ...oidc, issuer: 'https://idp.example.invalid/other' } } } }, webIdentity), /must match/);
  assert.ok(checkedConfiguration({ ...paired, web: { ...paired.web, identity: { method: 'company', oidc: { ...oidc, clientId: 'web-client', bearer: 'access_token' } } } }, webIdentity), 'access_token audience is the API, not the client');
  assert.throws(() => checkedConfiguration({ ...paired, web: { ...paired.web, identity: { method: 'company', oidc: { ...oidc, tokenEndpoint: 'http://idp.example.invalid/token' } } } }));
  const summary = deploymentSummary(paired, webIdentity), text = JSON.stringify(summary);
  assert.equal(summary.connections[0]!.account, '********9012'); assert.equal(summary.verifier?.jwks, 'static');
  for (const secret of ['123456789012', 'synthetic-example.awsapps.com', 'cloudops.example.invalid']) assert.equal(text.includes(secret), false, secret);
  assert.deepEqual(summary.warnings, []);
  assert.match(deploymentSummary(example).warnings.join(' '), /no browser oidc settings.*no server verifier/);
});

test('the opt-in Docker driver refuses to start in offline verification even when enabled', async t => {
  const { store } = await storeFor(t), previous = process.env.CLOUDOPS_ORGANIZATION_DOCKER_ENABLED;
  process.env.CLOUDOPS_ORGANIZATION_DOCKER_ENABLED = '1';
  t.after(() => { if (previous === undefined) delete process.env.CLOUDOPS_ORGANIZATION_DOCKER_ENABLED; else process.env.CLOUDOPS_ORGANIZATION_DOCKER_ENABLED = previous; });
  assert.equal(process.env.CLOUDOPS_OFFLINE_TEST, '1');
  const config = { executable: '/usr/local/bin/docker', socketPath: '/var/run/docker.sock', metadataRoot: '/var/lib/cloudops-synthetic', daemonId: 'synthetic-daemon', imageId: `sha256:${'a'.repeat(64)}`, network: 'cloudops-workers' };
  assert.throws(() => dockerProvisionerFromConfig(store, config), /CLOUDOPS_ORGANIZATION_DOCKER_ENABLED/);
});

test('the loopback host can serve TLS for an IdP that refuses http callbacks', async t => {
  const { directory, store } = await storeFor(t), webRoot = join(directory, 'web');
  await mkdir(webRoot, { recursive: true }); await writeFile(join(webRoot, 'index.html'), '<!doctype html><title>synthetic</title>');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', join(directory, 'tls.key'), '-out', join(directory, 'tls.crt'),
    '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  const tls = { cert: await readFile(join(directory, 'tls.crt'), 'utf8'), key: await readFile(join(directory, 'tls.key'), 'utf8') };
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const { port } = probe.address() as { port: number }; await new Promise<void>(resolve => probe.close(() => resolve()));
  await assert.rejects(startLocalOrganizationHost({ deployment: { ...example, publicOrigin: `http://127.0.0.1:${port}` }, webIdentity, store, webRoot, host: '127.0.0.1', port, tls }), /https:\/\/127\.0\.0\.1/);
  const host = await startLocalOrganizationHost({ deployment: { ...example, publicOrigin: `https://127.0.0.1:${port}` }, webIdentity, store, webRoot, host: '127.0.0.1', port, tls });
  t.after(() => host.close());
  const get = (path: string, headers: Record<string, string> = {}) => new Promise<{ status: number; body: string }>((resolve, reject) => {
    const request = httpsRequest({ host: '127.0.0.1', port, path, ca: tls.cert, headers }, response => { let body = ''; response.on('data', chunk => { body += chunk; }); response.on('end', () => resolve({ status: response.statusCode ?? 0, body })); });
    request.on('error', reject); request.end();
  });
  assert.equal((await get('/')).status, 200);
  assert.deepEqual(JSON.parse((await get('/api/organizations/config', { 'Sec-Fetch-Site': 'same-origin' })).body), example.web);
});

test('reconcile-worker retires only an expired lease and only with a stop/cache receipt', async t => {
  const { store } = await storeFor(t);
  let now = 1_800_000_000_000;
  const access = new OrganizationWebAccess({ async verify() { return { actorId: identityActor(issuer, 'employee-a'), expiresAt: now + 600_000 }; } }, store, () => now);
  await access.provision({ ...membership('employee-a'), updatedAt: new Date(now).toISOString() });
  const connections = new OrganizationConnections(store, access, { async invoke() { return { ok: false, code: 'worker_unavailable' }; } }, example.connections, () => now);
  const session = await access.authenticate('Bearer synthetic', scope.organizationId, scope.workspaceId);
  const { id } = await connections.create(session, { configurationId: 'aws-read', requestKey: randomUUID() });
  const stops: string[] = [];
  const provisioner = { async provision(): Promise<never> { throw new Error('not used'); },
    async fenceAndStop(allocation: { handle: ReturnType<typeof workerLeaseHandle> }) { stops.push(allocation.handle.leaseId); return { ...allocation.handle, stopped: true as const, cacheAccessRevoked: true as const }; } };
  assert.equal(await reconcileLocalWorker(store, id, provisioner as never, () => now), 'no-lease');
  await assert.rejects(reconcileLocalWorker(store, randomUUID(), provisioner as never, () => now), /Unknown connection/);
  const record = await store.transact(tx => tx.get<{ binding: unknown }>(`organization-connection:${id}`));
  const leases = new OrganizationWorkerLeases(store, { now: () => now });
  await leases.claim(record!.binding, randomUUID(), randomUUID());
  await assert.rejects(reconcileLocalWorker(store, id, provisioner as never, () => now), /still active/);
  assert.deepEqual(stops, [], 'a live lease is never fenced');
  now += 3_600_000;
  assert.equal(await reconcileLocalWorker(store, id, provisioner as never, () => now), 'retired');
  assert.equal(stops.length, 1);
  assert.equal(await reconcileLocalWorker(store, id, provisioner as never, () => now), 'already-retired');
});
