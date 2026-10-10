// Opt-in fault injection for isolation procedure step 8. NOT part of `make check`.
// Real Docker driver + built local host, synthetic OIDC/membership, internal network (the AWS CLI cannot reach AWS).
// Scenario: host SIGKILL with a ready worker -> restart refuses new generations (also after lease expiry)
// -> operator reconcile-worker fences/removes and retires -> only then a new generation is provisioned.
//   CLOUDOPS_ORGANIZATION_DOCKER_ENABLED=1 node scripts/verify-worker-recovery.mjs
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.env.CLOUDOPS_ORGANIZATION_DOCKER_ENABLED !== '1' || process.env.CLOUDOPS_OFFLINE_TEST === '1') throw new Error('Set CLOUDOPS_ORGANIZATION_DOCKER_ENABLED=1 for an authorized recovery run.');
const network = process.env.CLOUDOPS_WORKER_NETWORK ?? 'cloudops-workers-isolation', executable = process.env.CLOUDOPS_DOCKER_EXECUTABLE ?? '/usr/local/bin/docker';
const docker = (...args) => execFileSync(executable, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
if (docker('network', 'inspect', network, '--format', '{{.Internal}}') !== 'true') throw new Error(`Network ${network} must be internal.`);
const ours = () => docker('container', 'ls', '--all', '--no-trunc', '--filter', 'label=cloudops.auto.kind=organization-worker', '--format', '{{.ID}}').split('\n').filter(Boolean);
const before = new Set(ours()), fresh = () => ours().filter(id => !before.has(id));
const results = [], check = (id, pass, detail) => { results.push({ id, pass: Boolean(pass) }); console.log(`${pass ? 'PASS' : 'FAIL'} ${id}${detail ? ` — ${detail}` : ''}`); };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

const directory = await realpath(await mkdtemp(join(tmpdir(), 'cloudops-recovery-')));
const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
const origin = `http://127.0.0.1:${port}`, issuer = 'https://idp.example.invalid/recovery', audience = 'cloudops-recovery-api';
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 }), part = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const token = () => { const now = Math.floor(Date.now() / 1000), data = `${part({ alg: 'RS256', typ: 'JWT', kid: 'r1' })}.${part({ iss: issuer, aud: audience, sub: 'employee-a', iat: now, exp: now + 900 })}`; return `${data}.${sign('sha256', Buffer.from(data), keys.privateKey).toString('base64url')}`; };
const scope = { organizationId: 'synthetic-org', workspaceId: 'synthetic-workspace' };
const env = { ...process.env, CLOUDOPS_ORGANIZATION_DOCKER_ENABLED: '1', CLOUDOPS_LOCAL_PORT: String(port), CLOUDOPS_LOCAL_STORE: join(directory, 'store.sqlite'),
  CLOUDOPS_DEPLOYMENT: join(directory, 'deployment.json'), CLOUDOPS_WEB_IDENTITY: join(directory, 'identity.json'), CLOUDOPS_DOCKER_WORKER_CONFIG: join(directory, 'docker.json') };
await writeFile(env.CLOUDOPS_DEPLOYMENT, JSON.stringify({ publicOrigin: origin, web: { configured: true, scope: { ...scope, label: 'Synthetic recovery' }, identity: { method: 'company' } },
  connections: [{ configurationId: 'aws-read', label: 'Synthetic read', ...scope, startUrl: 'https://synthetic-example.awsapps.com/start', ssoRegion: 'us-east-1', region: 'us-east-1', accountId: '123456789012', roleName: 'ReadOnlyAccess' }] }));
await writeFile(env.CLOUDOPS_WEB_IDENTITY, JSON.stringify({ kind: 'oidc', issuer, audience, jwks: { keys: [{ ...keys.publicKey.export({ format: 'jwk' }), kid: 'r1', use: 'sig' }] } }));
const socketPath = JSON.parse(docker('context', 'inspect', '--format', '{{json .Endpoints.docker.Host}}')).replace(/^unix:\/\//, '');
await writeFile(env.CLOUDOPS_DOCKER_WORKER_CONFIG, JSON.stringify({ executable, socketPath, metadataRoot: join(directory, 'metadata'), daemonId: JSON.parse(docker('info', '--format', '{{json .ID}}')),
  imageId: docker('image', 'inspect', '--format', '{{.Id}}', process.env.CLOUDOPS_WORKER_IMAGE ?? 'cloudops-organization-cli:local'), network }));
const cli = (...args) => { const result = spawnSync(process.execPath, ['dist-company-api/local.mjs', ...args], { env, encoding: 'utf8' }); return { status: result.status, out: `${result.stdout}${result.stderr}`.trim() }; };
const actorId = cli('actor', '--issuer', issuer, '--subject', 'employee-a').out;
await writeFile(join(directory, 'membership.json'), JSON.stringify({ ...scope, actorId, active: true, roles: ['viewer'], version: 1, updatedAt: new Date().toISOString() }));
if (cli('provision-membership', join(directory, 'membership.json')).status !== 0) throw new Error('membership bootstrap failed');

let host;
async function startHost() {
  const child = spawn(process.execPath, ['dist-company-api/local.mjs', 'serve'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  for (let i = 0; i < 100 && !output.includes('Local organization host'); i++) { if (child.exitCode !== null) throw new Error(output); await delay(50); }
  return child;
}
const stopHost = async (child, signal) => { if (child.exitCode !== null) return; child.kill(signal); await once(child, 'exit'); };
const api = (path = '', body) => fetch(`${origin}/api/organizations/v1/${scope.organizationId}/workspaces/${scope.workspaceId}/aws/connections${path}`, {
  method: body ? 'POST' : 'GET', headers: { Origin: origin, Authorization: `Bearer ${token()}`, ...(body ? { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() } : {}) },
  ...(body ? { body: JSON.stringify(body) } : {}) }).then(async response => ({ status: response.status, body: await response.json() }));

try {
  host = await startHost();
  const created = await api('', { configurationId: 'aws-read' }), id = created.body.id;
  const first = await api(`/${id}/actions`, { operation: 'login' });
  check('login-provisions-generation-1', first.status === 200 && fresh().length === 1, `HTTP ${first.status}, containers ${fresh().length}`);
  const generation1 = fresh()[0];
  await stopHost(host, 'SIGKILL');
  check('sigkill-leaves-worker-owned', ours().includes(generation1), 'ungraceful exit cannot clean up; the lease stays with the dead supervisor');
  host = await startHost();
  const status = await api(`/${id}/status`);
  const retry = await api(`/${id}/actions`, { operation: 'login' });
  check('restart-refuses-new-generation', status.status >= 400 && retry.status >= 400 && fresh().length === 1, `status ${status.status}, login ${retry.status} ${retry.body.code}, containers ${fresh().length}`);
  check('reconcile-refuses-live-lease', cli('reconcile-worker', id).status !== 0, 'lease not yet expired');
  await delay(65_000);
  const expired = await api(`/${id}/actions`, { operation: 'login' });
  check('expiry-alone-does-not-reallocate', expired.status >= 400 && fresh().length === 1, `login ${expired.status} ${expired.body.code}, containers ${fresh().length}`);
  await stopHost(host, 'SIGTERM');
  const reconciled = cli('reconcile-worker', id);
  check('reconcile-fences-and-retires', reconciled.status === 0 && reconciled.out === 'retired' && !ours().includes(generation1), `${reconciled.out}`);
  host = await startHost();
  const next = await api(`/${id}/actions`, { operation: 'login' });
  const generation2 = fresh();
  check('new-generation-after-retirement', next.status === 200 && generation2.length === 1 && generation2[0] !== generation1
    && docker('container', 'inspect', '--format', '{{index .Config.Labels "cloudops.auto.generation"}}', generation2[0]) === '2', `HTTP ${next.status}`);
  await stopHost(host, 'SIGTERM');
  check('graceful-stop-removes-generation-2', fresh().length === 0);
} finally {
  if (host) await stopHost(host, 'SIGTERM').catch(() => undefined);
  for (const id of fresh()) docker('container', 'rm', '--force', id);
  await rm(directory, { recursive: true, force: true });
}
const failed = results.filter(item => !item.pass);
console.log(`\nWorker recovery: ${results.length - failed.length}/${results.length} checks passed.`);
if (failed.length) process.exitCode = 1;
