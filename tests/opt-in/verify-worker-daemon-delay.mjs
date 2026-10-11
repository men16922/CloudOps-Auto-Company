// Opt-in fault injection: Docker daemon completes `container create` only after the client gave up. NOT part of `make check`.
// A wrapper around the real Docker CLI hangs on create and lets a detached copy reach the daemon 40 s later,
// as when a slow daemon finishes work for a client that already timed out. Synthetic OIDC/membership, internal network.
// Expected: login fails as uncertain, the late container is never started or attached, no automatic retry, and
// reconcile-worker refuses to manufacture a retirement receipt for an unconfirmed create; only an investigated
// container ID that passes the full allocation inspection can be adopted, removed and retired.
//   CLOUDOPS_ORGANIZATION_DOCKER_ENABLED=1 node scripts/verify-worker-daemon-delay.mjs
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { once } from 'node:events';
import { chmod, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.env.CLOUDOPS_ORGANIZATION_DOCKER_ENABLED !== '1' || process.env.CLOUDOPS_OFFLINE_TEST === '1') throw new Error('Set CLOUDOPS_ORGANIZATION_DOCKER_ENABLED=1 for an authorized fault-injection run.');
const realDocker = process.env.CLOUDOPS_DOCKER_EXECUTABLE ?? '/usr/local/bin/docker', network = process.env.CLOUDOPS_WORKER_NETWORK ?? 'cloudops-workers-isolation';
const docker = (...args) => execFileSync(realDocker, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
if (docker('network', 'inspect', network, '--format', '{{.Internal}}') !== 'true') throw new Error(`Network ${network} must be internal.`);
const ours = () => docker('container', 'ls', '--all', '--no-trunc', '--filter', 'label=cloudops.auto.kind=organization-worker', '--format', '{{.ID}} {{.State}}').split('\n').filter(Boolean);
const before = new Set(ours().map(line => line.split(' ')[0])), fresh = () => ours().filter(line => !before.has(line.split(' ')[0]));
const results = [], check = (id, pass, detail) => { results.push({ id, pass: Boolean(pass) }); console.log(`${pass ? 'PASS' : 'FAIL'} ${id}${detail ? ` — ${detail}` : ''}`); };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

const directory = await realpath(await mkdtemp(join(tmpdir(), 'cloudops-daemon-delay-')));
const slowDocker = join(directory, 'slow-docker');
await writeFile(slowDocker, `#!/bin/sh
for a in "$@"; do
  if [ "$a" = "create" ]; then
    ( trap '' HUP INT TERM; sleep 40; exec ${realDocker} "$@" ) </dev/null >/dev/null 2>&1 &
    exec sleep 3600
  fi
done
exec ${realDocker} "$@"
`); await chmod(slowDocker, 0o700);
const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
const origin = `http://127.0.0.1:${port}`, issuer = 'https://idp.example.invalid/daemon-delay', audience = 'cloudops-daemon-delay-api';
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 }), part = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const token = () => { const now = Math.floor(Date.now() / 1000), data = `${part({ alg: 'RS256', typ: 'JWT', kid: 'd1' })}.${part({ iss: issuer, aud: audience, sub: 'employee-a', iat: now, exp: now + 900 })}`; return `${data}.${sign('sha256', Buffer.from(data), keys.privateKey).toString('base64url')}`; };
const scope = { organizationId: 'synthetic-org', workspaceId: 'synthetic-workspace' };
const env = { ...process.env, CLOUDOPS_ORGANIZATION_DOCKER_ENABLED: '1', CLOUDOPS_LOCAL_PORT: String(port), CLOUDOPS_LOCAL_STORE: join(directory, 'store.sqlite'),
  CLOUDOPS_DEPLOYMENT: join(directory, 'deployment.json'), CLOUDOPS_WEB_IDENTITY: join(directory, 'identity.json'), CLOUDOPS_DOCKER_WORKER_CONFIG: join(directory, 'docker.json') };
await writeFile(env.CLOUDOPS_DEPLOYMENT, JSON.stringify({ publicOrigin: origin, web: { configured: true, scope: { ...scope, label: 'Synthetic delay' }, identity: { method: 'company' } },
  connections: [{ configurationId: 'aws-read', label: 'Synthetic read', ...scope, startUrl: 'https://synthetic-example.awsapps.com/start', ssoRegion: 'us-east-1', region: 'us-east-1', accountId: '123456789012', roleName: 'ReadOnlyAccess' }] }));
await writeFile(env.CLOUDOPS_WEB_IDENTITY, JSON.stringify({ kind: 'oidc', issuer, audience, jwks: { keys: [{ ...keys.publicKey.export({ format: 'jwk' }), kid: 'd1', use: 'sig' }] } }));
const socketPath = JSON.parse(docker('context', 'inspect', '--format', '{{json .Endpoints.docker.Host}}')).replace(/^unix:\/\//, '');
await writeFile(env.CLOUDOPS_DOCKER_WORKER_CONFIG, JSON.stringify({ executable: slowDocker, socketPath, metadataRoot: join(directory, 'metadata'), daemonId: JSON.parse(docker('info', '--format', '{{json .ID}}')),
  imageId: docker('image', 'inspect', '--format', '{{.Id}}', process.env.CLOUDOPS_WORKER_IMAGE ?? 'cloudops-organization-cli:local'), network }));
const cli = (...args) => { const result = spawnSync(process.execPath, ['dist-company-api/local.mjs', ...args], { env, encoding: 'utf8' }); return { status: result.status, out: `${result.stdout}${result.stderr}`.trim() }; };
await writeFile(join(directory, 'membership.json'), JSON.stringify({ ...scope, actorId: cli('actor', '--issuer', issuer, '--subject', 'employee-a').out, active: true, roles: ['viewer'], version: 1, updatedAt: new Date().toISOString() }));
if (cli('provision-membership', join(directory, 'membership.json')).status !== 0) throw new Error('membership bootstrap failed');
const api = (path = '', body) => fetch(`${origin}/api/organizations/v1/${scope.organizationId}/workspaces/${scope.workspaceId}/aws/connections${path}`, {
  method: body ? 'POST' : 'GET', headers: { Origin: origin, Authorization: `Bearer ${token()}`, ...(body ? { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() } : {}) },
  ...(body ? { body: JSON.stringify(body) } : {}) }).then(async response => ({ status: response.status, body: await response.json() }));

const host = spawn(process.execPath, ['dist-company-api/local.mjs', 'serve'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let output = ''; host.stdout.on('data', chunk => { output += chunk; }); host.stderr.on('data', chunk => { output += chunk; });
try {
  for (let i = 0; i < 100 && !output.includes('Local organization host'); i++) { if (host.exitCode !== null) throw new Error(output); await delay(50); }
  const { body: { id } } = await api('', { configurationId: 'aws-read' });
  const started = Date.now(), login = await api(`/${id}/actions`, { operation: 'login' });
  check('slow-create-fails-as-uncertain', login.status >= 400 && fresh().length === 0, `HTTP ${login.status} ${login.body.code} after ${Math.round((Date.now() - started) / 1000)}s, containers ${fresh().length}`);
  let late = [];
  for (let i = 0; i < 40 && !late.length; i++) { await delay(1000); late = fresh(); }
  check('daemon-completes-late-create', late.length === 1, late.join(', ') || 'no late container');
  await delay(5000);
  check('late-container-never-started-or-attached', fresh().every(line => line.endsWith(' created')), fresh().join(', '));
  const retry = await api(`/${id}/actions`, { operation: 'login' });
  check('no-automatic-retry-or-second-generation', retry.status >= 400 && fresh().length === 1, `HTTP ${retry.status} ${retry.body.code}, containers ${fresh().length}`);
  const reconcile = cli('reconcile-worker', id);
  check('reconcile-refuses-unconfirmed-create', reconcile.status !== 0 && fresh().length === 1, reconcile.out.split('\n')[0]);
  const lateId = late[0].split(' ')[0], other = docker('run', '-d', '--rm', '--network', network, '--label', 'cloudops.auto.kind=organization-worker', '--entrypoint', 'sleep', process.env.CLOUDOPS_WORKER_IMAGE ?? 'cloudops-organization-cli:local', '60');
  const wrong = cli('reconcile-worker', id, '--investigated-container', other);
  check('investigated-id-must-match-the-allocation', wrong.status !== 0 && ours().some(line => line.startsWith(other)), 'a container without this lease\'s labels is refused');
  docker('container', 'rm', '--force', other);
  const adopted = cli('reconcile-worker', id, '--investigated-container', lateId);
  check('investigated-late-container-is-removed-and-retired', adopted.status === 0 && adopted.out === 'retired' && fresh().length === 0, adopted.out.split('\n')[0]);
} finally {
  if (host.exitCode === null) { host.kill('SIGTERM'); await once(host, 'exit'); }
  for (const line of fresh()) docker('container', 'rm', '--force', line.split(' ')[0]); // operator investigation outcome for this synthetic run
  await rm(directory, { recursive: true, force: true });
}
const failed = results.filter(item => !item.pass);
console.log(`\nDaemon delay: ${results.length - failed.length}/${results.length} checks passed.`);
if (failed.length) process.exitCode = 1;
