// Opt-in Docker isolation run for two synthetic users. NOT part of `make check`.
// Requires an authorized Docker daemon, the built worker image and an *internal* network so the AWS CLI
// inside the workers cannot reach AWS. Uses synthetic OIDC keys/memberships and a temporary SQLite store.
//   CLOUDOPS_ORGANIZATION_DOCKER_ENABLED=1 node --import tsx scripts/verify-worker-isolation.mjs
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { identityActor } from '../server/cloud-auth.ts';
import { SqliteCloudStore } from '../server/cloud-sqlite-store.ts';
import { OidcJwtVerifier } from '../server/oidc-web-identity.ts';
import { dockerProvisionerFromConfig, provisionLocalMembership } from '../server/organization-local-host.ts';
import { composeOrganizationApi } from '../server/modules/aws/organization/organization-deployment.ts';

if (process.env.CLOUDOPS_ORGANIZATION_DOCKER_ENABLED !== '1' || process.env.CLOUDOPS_OFFLINE_TEST === '1') throw new Error('Set CLOUDOPS_ORGANIZATION_DOCKER_ENABLED=1 (and not CLOUDOPS_OFFLINE_TEST) for an authorized isolation run.');
const image = process.env.CLOUDOPS_WORKER_IMAGE ?? 'cloudops-organization-cli:local', network = process.env.CLOUDOPS_WORKER_NETWORK ?? 'cloudops-workers-isolation';
const executable = process.env.CLOUDOPS_DOCKER_EXECUTABLE ?? '/usr/local/bin/docker';
const docker = (...args) => execFileSync(executable, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const tryDocker = (...args) => { try { return { ok: true, out: docker(...args) }; } catch (error) { return { ok: false, out: `${error.stdout ?? ''}${error.stderr ?? ''}`.trim() }; } };
if (docker('network', 'inspect', network, '--format', '{{.Internal}}') !== 'true') throw new Error(`Network ${network} must be internal so workers cannot reach AWS.`);
const socketPath = process.env.CLOUDOPS_DOCKER_SOCKET ?? JSON.parse(docker('context', 'inspect', '--format', '{{json .Endpoints.docker.Host}}')).replace(/^unix:\/\//, '');
const results = [], check = (id, pass, detail) => { results.push({ id, pass: Boolean(pass), detail }); console.log(`${pass ? 'PASS' : 'FAIL'} ${id}${detail ? ` — ${detail}` : ''}`); };
const wait = async (predicate, ms = 30_000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await predicate()) return true; await new Promise(resolve => setTimeout(resolve, 250)); } return false; };
const ours = () => docker('container', 'ls', '--all', '--no-trunc', '--filter', 'label=cloudops.auto.kind=organization-worker', '--format', '{{.ID}}').split('\n').filter(Boolean);
const before = new Set(ours());

const directory = await realpath(await mkdtemp(join(tmpdir(), 'cloudops-isolation-')));
const config = { executable, socketPath, metadataRoot: join(directory, 'metadata'), daemonId: JSON.parse(docker('info', '--format', '{{json .ID}}')),
  imageId: docker('image', 'inspect', '--format', '{{.Id}}', image), network };
const issuer = 'https://idp.example.invalid/isolation', audience = 'cloudops-isolation-api', keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const part = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const token = subject => { const now = Math.floor(Date.now() / 1000), data = `${part({ alg: 'RS256', typ: 'JWT', kid: 'iso-1' })}.${part({ iss: issuer, aud: audience, sub: subject, iat: now, exp: now + 900 })}`; return `${data}.${sign('sha256', Buffer.from(data), keys.privateKey).toString('base64url')}`; };
const scope = { organizationId: 'synthetic-org', workspaceId: 'synthetic-workspace' };
const membership = (subject, version = 1, active = true) => ({ ...scope, actorId: identityActor(issuer, subject), active, roles: ['viewer'], version, updatedAt: new Date().toISOString() });
const storePath = join(directory, 'store.sqlite');
let store = new SqliteCloudStore(storePath), composition, server;
const listen = async () => {
  let handler = (_request, response) => { response.writeHead(503); response.end(); };
  const value = createServer((request, response) => handler(request, response)); value.listen(0, '127.0.0.1'); await once(value, 'listening');
  return { server: value, origin: `http://127.0.0.1:${value.address().port}`, use: next => { handler = next; } };
};
const compose = async () => {
  const host = await listen();
  const deployment = { publicOrigin: host.origin, web: { configured: true, scope: { ...scope, label: 'Synthetic isolation' }, identity: { method: 'company' } },
    connections: [{ configurationId: 'aws-read', label: 'Synthetic read', ...scope, startUrl: 'https://synthetic-example.awsapps.com/start', ssoRegion: 'us-east-1', region: 'us-east-1', accountId: '123456789012', roleName: 'ReadOnlyAccess' }] };
  const verifier = new OidcJwtVerifier({ kind: 'oidc', issuer, audience, jwks: { keys: [{ ...keys.publicKey.export({ format: 'jwk' }), kid: 'iso-1', use: 'sig' }] } });
  const value = composeOrganizationApi({ deployment, store, verifier, provisioner: dockerProvisionerFromConfig(store, config) });
  host.use(value.listener); return { composition: value, server: host.server, origin: host.origin };
};
const api = (origin, subject, path = '', body) => fetch(`${origin}/api/organizations/v1/${scope.organizationId}/workspaces/${scope.workspaceId}/aws/connections${path}`, {
  method: body ? 'POST' : 'GET', headers: { Origin: origin, Authorization: `Bearer ${token(subject)}`, ...(body ? { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() } : {}) },
  ...(body ? { body: JSON.stringify(body) } : {}) }).then(async response => ({ status: response.status, body: await response.json() }));

try {
  await writeFile(join(directory, 'README.txt'), 'Synthetic isolation run. Safe to delete.\n');
  await provisionLocalMembership(store, membership('employee-a')); await provisionLocalMembership(store, membership('employee-b'));
  ({ composition, server } = await compose()); const origin = `http://127.0.0.1:${server.address().port}`;
  const connections = {};
  for (const user of ['employee-a', 'employee-b']) {
    const created = await api(origin, user, '', { configurationId: 'aws-read' });
    check(`create-${user}`, created.status === 200, `HTTP ${created.status}`); connections[user] = created.body.id;
    const login = await api(origin, user, `/${connections[user]}/actions`, { operation: 'login' });
    check(`login-provisions-${user}`, login.status === 200, `HTTP ${login.status} ${login.body.status ?? login.body.code}`);
  }
  const containers = ours().filter(id => !before.has(id));
  check('two-workers', containers.length === 2, `${containers.length} new containers`);
  const inspected = containers.map(id => JSON.parse(docker('container', 'inspect', id))[0]);
  const byConnection = Object.fromEntries(Object.entries(connections).map(([user, id]) => [user, inspected.find(item => JSON.parse(docker('exec', item.Id, 'cat', '/run/cloudops/binding.json')).connectionId === id)]));
  for (const [user, item] of Object.entries(byConnection)) {
    if (!item) { check(`worker-${user}`, false, 'no container bound to this connection'); continue; }
    const host = item.HostConfig, mounts = item.Mounts;
    check(`runtime-${user}`, item.Config.User === '10001:10001' && host.ReadonlyRootfs && !host.Privileged && host.CapDrop?.join() === 'ALL' && !(host.CapAdd?.length)
      && host.SecurityOpt?.includes('no-new-privileges:true') && host.IpcMode === 'private' && host.LogConfig.Type === 'none' && host.NetworkMode === network
      && host.Memory === 268435456 && host.PidsLimit === 64 && !Object.keys(host.PortBindings ?? {}).length, 'uid/readonly/caps/no-new-privileges/ipc/log=none/network/limits');
    check(`mounts-${user}`, mounts.length === 2 && mounts.every(mount => mount.Type === 'bind' && !mount.RW && mount.Source.startsWith(config.metadataRoot))
      && Object.keys(host.Tmpfs ?? {}).sort().join() === '/home/cloudops-worker/.aws,/tmp', 'two read-only metadata binds, private tmpfs cache and /tmp, no volumes');
    check(`uid-${user}`, docker('exec', item.Id, 'id', '-u') === '10001');
    check(`cache-private-${user}`, docker('exec', item.Id, 'stat', '-c', '%a %u %g', '/home/cloudops-worker/.aws') === '700 10001 10001'
      && docker('exec', item.Id, 'sh', '-c', 'grep " /home/cloudops-worker/.aws " /proc/mounts').startsWith('tmpfs '), 'tmpfs 0700 owned by 10001');
    check(`rootfs-readonly-${user}`, !tryDocker('exec', item.Id, 'touch', '/app/probe').ok);
    check(`no-host-aws-${user}`, !tryDocker('exec', item.Id, 'sh', '-c', 'test -e /root/.aws || ls /Users 2>/dev/null').ok);
    check(`no-egress-${user}`, !tryDocker('exec', item.Id, 'getent', 'hosts', 'oidc.us-east-1.amazonaws.com').ok, 'AWS endpoints unresolvable on the internal network');
    check(`no-container-log-${user}`, !tryDocker('logs', item.Id).ok, 'log-driver none keeps stdout private');
  }
  const [a, b] = [byConnection['employee-a'], byConnection['employee-b']];
  if (a && b) {
    check('distinct-allocations', ['cloudops.auto.binding', 'cloudops.auto.lease', 'cloudops.auto.cache'].every(key => a.Config.Labels[key] !== b.Config.Labels[key]));
    check('no-shared-sources', !a.Mounts.some(mount => b.Mounts.some(other => other.Source === mount.Source)));
    const profiles = item => tryDocker('exec', item.Id, 'sh', '-c', 'cat /home/cloudops-worker/.aws/config').out;
    const [aConfig, bConfig] = [profiles(a), profiles(b)];
    check('cache-contains-only-own-profile', aConfig.includes(`cloudops-${connections['employee-a']}`) && !aConfig.includes(connections['employee-b'])
      && bConfig.includes(`cloudops-${connections['employee-b']}`) && !bConfig.includes(connections['employee-a']), 'each tmpfs cache holds only its own generated profile');
  }
  const settled = await wait(async () => { const status = await api(origin, 'employee-a', `/${connections['employee-a']}/status`); return status.status === 200 && ['failed', 'expired', 'denied'].includes(status.body.status); }, 60_000);
  const statusA = await api(origin, 'employee-a', `/${connections['employee-a']}/status`);
  check('login-fails-closed-without-network', settled, `A status ${statusA.body.status ?? statusA.body.code}`);
  check('foreign-connection-hidden', (await api(origin, 'employee-b', `/${connections['employee-a']}/status`)).status === 404, 'B cannot read A connection');
  await provisionLocalMembership(store, membership('employee-a', 2, false));
  const fenced = await wait(async () => !ours().includes(a?.Id), 30_000);
  check('revocation-stops-only-a', fenced && ours().includes(b?.Id), 'heartbeat fenced A; B still running');
  check('revoked-a-denied', (await api(origin, 'employee-a', '')).status === 403);
  await composition.close(); await new Promise(resolve => server.close(resolve));
  check('shutdown-removes-workers', await wait(async () => ours().filter(id => !before.has(id)).length === 0, 30_000));
  store.close(); store = new SqliteCloudStore(storePath);
  ({ composition, server } = await compose()); const restarted = `http://127.0.0.1:${server.address().port}`;
  const statusB = await api(restarted, 'employee-b', `/${connections['employee-b']}/status`);
  check('restart-does-not-provision-on-status', statusB.status === 503 && ours().filter(id => !before.has(id)).length === 0, `HTTP ${statusB.status} ${statusB.body.code}`);
  await composition.close(); await new Promise(resolve => server.close(resolve)); composition = undefined;
} finally {
  if (composition) await composition.close().catch(() => undefined);
  for (const id of ours().filter(id => !before.has(id))) tryDocker('container', 'rm', '--force', id);
  store.close(); await rm(directory, { recursive: true, force: true });
}
const failed = results.filter(item => !item.pass);
console.log(`\nWorker isolation: ${results.length - failed.length}/${results.length} checks passed.`);
if (failed.length) process.exitCode = 1;
