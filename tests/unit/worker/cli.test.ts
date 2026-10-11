import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { PassThrough } from 'node:stream';
import type { VerifiedCloudContext } from '../../../packages/contracts/access-context';
import { CloudOperationError } from '../../../packages/contracts/errors';
import { cliArguments, cliBindingSchema, cliConfig, cliProfile, DeviceInstructionParser, type CliBinding, type CliOperation, type CliRuntime } from '../../../packages/worker-protocol/cli-contract';
import { cliEnvironment, createDedicatedCliRuntime, prepareCliDirectory } from '../../../apps/worker/src/cli-runtime';
import { boundedCliProcess } from '../../../packages/worker-protocol/bounded-process';
import { OrganizationCliWorker } from '../../../apps/worker/src/cli-worker';
import { serveCliWorker } from '../../../apps/worker/src/serve';

const a: CliBinding = { connectionId: '11111111-1111-4111-8111-111111111111', organizationId: 'synthetic-org', workspaceId: 'workspace-a', actorId: 'actor-a', startUrl: 'https://synthetic-example.awsapps.com/start', ssoRegion: 'us-east-1', region: 'ap-northeast-2', accountId: '123456789012', roleName: 'ReadOnlyAccess' };
const b: CliBinding = { ...a, connectionId: '22222222-2222-4222-8222-222222222222', actorId: 'actor-b' };
const context = (binding = a): VerifiedCloudContext => ({ actorId: binding.actorId, owner: { kind: 'organization', organizationId: binding.organizationId }, workspaceId: binding.workspaceId, channel: 'web', roles: ['viewer'] });
const code = (expected: string) => (error: unknown) => error instanceof CloudOperationError && error.code === expected;
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
// Shape checked against installed AWS CLI 2.30.1 PrintOnlyHandler; all values synthetic.
const deviceOutput = 'Browser will not be automatically opened.\nPlease visit the following URL:\n\nhttps://device.sso.us-east-1.amazonaws.com/\n\nThen enter the code:\n\nDEMO-CODE\n\nAlternatively, you may visit the following URL which will autofill the code upon loading:\nhttps://device.sso.us-east-1.amazonaws.com/?user_code=DEMO-CODE\n';
const rawIdentity = (binding = a, session = binding.actorId) => JSON.stringify({ Account: binding.accountId, Arn: `arn:aws:sts::${binding.accountId}:assumed-role/AWSReservedSSO_${binding.roleName}_0123456789abcdef/${session}`, UserId: `AROA_SYNTHETIC:${session}` });
function fixture(binding = a) {
  let now = 1_800_000_000_000, identity = rawIdentity(binding), output = deviceOutput;
  const login = deferred<void>(), read = deferred<void>(), logout = deferred<void>();
  let holdRead = false, holdLogout = false, readError = false;
  const calls: CliOperation[] = [], signals: AbortSignal[] = [];
  const runtime: CliRuntime = { async run(operation, signal, sink) {
    calls.push(operation); signals.push(signal);
    if (operation === 'login') { for (let index = 0; index < output.length; index += 7) sink?.(output.slice(index, index + 7)); await login.promise; return { stdout: 'Successfully logged in' }; }
    if (operation === 'identity') return { stdout: identity };
    if (operation === 'logout') { if (holdLogout) await logout.promise; return { stdout: '' }; }
    if (holdRead) await read.promise;
    if (readError) throw new Error('private underlying service details');
    return { stdout: JSON.stringify({ Items: [{ name: 'synthetic-resource' }], HasMore: true }) };
  } };
  const worker = new OrganizationCliWorker(binding, runtime, () => now);
  return { worker, calls, signals, login, read, logout, setIdentity: (value: string) => { identity = value; }, setOutput: (value: string) => { output = value; },
    advance: (ms: number) => { now += ms; }, holdRead: () => { holdRead = true; }, holdLogout: () => { holdLogout = true; }, failRead: () => { readError = true; } };
}
async function until(predicate: () => boolean) { for (let n = 0; n < 100; n++) { if (predicate()) return; await nextTurn(); } assert.fail('Expected state was not reached'); }

test('two users have independent login/verification; cross-user or missing membership access fails before CLI', async t => {
  const first = fixture(), second = fixture(b); t.after(() => first.worker.close()); t.after(() => second.worker.close());
  first.worker.start(context()); second.worker.start(context(b));
  await until(() => first.worker.status(context()).status === 'awaiting-user' && second.worker.status(context(b)).status === 'awaiting-user');
  for (const denied of [context(b), { ...context(), roles: [] }, { ...context(), channel: 'mobile' as const }, { ...context(), workspaceId: 'other' }, { ...context(), owner: { kind: 'personal' as const, userId: 'actor-a' } }]) {
    assert.throws(() => first.worker.status(denied), code('connection_unavailable'));
    assert.throws(() => first.worker.start(denied), code('connection_unavailable'));
    await assert.rejects(first.worker.verify(denied), code('connection_unavailable'));
    await assert.rejects(first.worker.inspect(denied, 'lambda'), code('connection_unavailable'));
    await assert.rejects(first.worker.logout(denied), code('connection_unavailable'));
  }
  assert.throws(() => first.worker.start(context()), code('connection_busy'));
  assert.deepEqual(first.calls, ['login']);
  first.login.resolve(); await until(() => first.worker.status(context()).status === 'connected');
  assert.equal(second.worker.status(context(b)).status, 'awaiting-user');
  second.login.resolve(); await until(() => second.worker.status(context(b)).status === 'connected');
  assert.equal(first.worker.status(context()).userCode, undefined);
  const page = await first.worker.inspect(context(), 'lambda'); assert.equal(page.items[0].name, 'synthetic-resource'); assert.equal(page.hasMore, true);
  // Lambda's list API has no tags, so a non-empty page also reads its tag keys (Resource Groups Tagging API).
  assert.deepEqual(first.calls, ['login', 'identity', 'identity', 'lambda', 'tagged-resources', 'identity']);
  assert.ok(!JSON.stringify(first.worker.status(context())).includes('AROA'));
});

test('device parser handles split chunks and rejects untrusted links, oversized output and unknown format', async t => {
  const parser = new DeviceInstructionParser(a); let result;
  for (const character of deviceOutput) result = parser.feed(character) ?? result;
  assert.deepEqual(result, { userCode: 'DEMO-CODE', verificationUri: 'https://device.sso.us-east-1.amazonaws.com/', verificationUriComplete: 'https://device.sso.us-east-1.amazonaws.com/?user_code=DEMO-CODE' });
  assert.deepEqual(new DeviceInstructionParser(a).feed(deviceOutput.replace('https://device.sso.us-east-1.amazonaws.com/?user_code=DEMO-CODE', `${a.startUrl}/#/device?user_code=DEMO-CODE`)),
    { ...result, verificationUriComplete: `${a.startUrl}/#/device?user_code=DEMO-CODE` });
  // Real AWS CLI 2.30 output for an Identity Center portal (observed 2026-10-10; synthetic host/code here).
  const portalOutput = `Browser will not be automatically opened.\nPlease visit the following URL:\n\n${a.startUrl}/#/device\n\nThen enter the code:\n\nABCD-EFGH\n\nAlternatively, you may visit the following URL which will autofill the code upon loading:\n${a.startUrl}/#/device?user_code=ABCD-EFGH\n`;
  assert.deepEqual(new DeviceInstructionParser(a).feed(portalOutput), { userCode: 'ABCD-EFGH', verificationUri: `${a.startUrl}/#/device`, verificationUriComplete: `${a.startUrl}/#/device?user_code=ABCD-EFGH` });
  assert.throws(() => new DeviceInstructionParser(a).feed(portalOutput.replace(`${a.startUrl}/#/device\n`, `${a.startUrl}/#/other\n`)), code('invalid_device_link'));
  assert.throws(() => new DeviceInstructionParser(a).feed(deviceOutput.replace('?user_code=DEMO-CODE', '?user_code=EVIL-CODE')), code('invalid_device_link'));
  for (const link of ['https://evil.example/', 'https://device.sso.us-east-1.amazonaws.com.evil.example/', 'https://user@device.sso.us-east-1.amazonaws.com/', 'https://device.sso.us-east-1.amazonaws.com/?secret=oops']) {
    assert.throws(() => new DeviceInstructionParser(a).feed(deviceOutput.replace('https://device.sso.us-east-1.amazonaws.com/', link)), code('invalid_device_link'));
  }
  assert.throws(() => new DeviceInstructionParser(a).feed('x'.repeat(32769)), code('login_output_limit'));
  const s = fixture(); t.after(() => s.worker.close()); s.setOutput('unknown CLI output\n'); s.worker.start(context()); s.login.resolve();
  await until(() => s.worker.status(context()).status === 'failed'); assert.equal(s.worker.status(context()).code, 'invalid_device_output'); assert.deepEqual(s.calls, ['login']);
});

test('verification refuses IAM users, wrong account/role and malformed STS responses without a credential fallback', async t => {
  for (const identity of ['{}', 'not json', rawIdentity({ ...a, accountId: '999999999999' }), rawIdentity({ ...a, roleName: 'AdministratorAccess' }), JSON.stringify({ Account: a.accountId, Arn: `arn:aws:iam::${a.accountId}:user/synthetic`, UserId: 'synthetic' })]) {
    const s = fixture(); t.after(() => s.worker.close()); s.setIdentity(identity);
    await assert.rejects(s.worker.verify(context())); assert.equal(s.worker.status(context()).status, 'failed'); assert.deepEqual(s.calls, ['identity']);
  }
});

test('changing CLI identity before or during a read discards results and disconnects the connection', async t => {
  for (const during of [false, true]) {
    const s = fixture(); t.after(() => s.worker.close()); await s.worker.verify(context());
    if (during) s.holdRead(); else s.setIdentity(rawIdentity(a, 'other-user'));
    const inspected = s.worker.inspect(context(), 'dynamodb');
    if (during) { await until(() => s.calls.includes('dynamodb')); s.setIdentity(rawIdentity(a, 'other-user')); s.read.resolve(); }
    await assert.rejects(inspected, code('identity_changed'));
    assert.equal(s.worker.status(context()).status, 'failed');
    if (!during) assert.ok(!s.calls.includes('dynamodb'));
  }
});

test('disconnect cancels a login and late completion cannot restore it; other users remain connected', async t => {
  const first = fixture(), second = fixture(b); t.after(() => first.worker.close()); t.after(() => second.worker.close());
  await second.worker.verify(context(b)); first.worker.start(context()); await until(() => first.calls.includes('login'));
  first.worker.disconnect(context()); assert.equal(first.signals[0].aborted, true);
  assert.throws(() => first.worker.start(context()), code('connection_busy'));
  first.login.resolve(); await until(() => first.worker.status(context()).status === 'cancelled'); await nextTurn();
  assert.deepEqual(first.calls, ['login']); assert.equal(second.worker.status(context(b)).status, 'connected');
});

test('logout waits for the owned login child and blocks new login until cache logout finishes', async t => {
  const s = fixture(); t.after(() => s.worker.close()); s.holdLogout(); s.worker.start(context()); await until(() => s.calls.includes('login'));
  const result = s.worker.logout(context()); assert.throws(() => s.worker.start(context()), code('connection_busy'));
  assert.deepEqual(s.calls, ['login']); s.login.resolve(); await until(() => s.calls.includes('logout'));
  assert.throws(() => s.worker.start(context()), code('connection_busy')); s.logout.resolve();
  assert.deepEqual(await result, { disconnected: true, remoteLogout: 'confirmed' }); assert.equal(s.worker.status(context()).status, 'disconnected');
});

test('expiry, late read results, unknown failures and shutdown cannot return successful data or relaunch work', async t => {
  const s = fixture(); t.after(() => s.worker.close()); await s.worker.verify(context()); s.holdRead();
  const read = s.worker.inspect(context(), 'alarms'); await until(() => s.calls.includes('alarms')); s.advance(1_800_000); s.read.resolve();
  await assert.rejects(read, code('connection_unavailable')); assert.equal(s.worker.status(context()).status, 'expired');
  await assert.rejects(s.worker.inspect(context(), 'lambda'), code('connection_unavailable'));
  const failed = fixture(); t.after(() => failed.worker.close()); await failed.worker.verify(context()); failed.failRead();
  await assert.rejects(failed.worker.inspect(context(), 'lambda'), error => error instanceof CloudOperationError && !error.message.includes('private'));
  await failed.worker.close(); assert.throws(() => failed.worker.start(context()), code('worker_closed'));
});

test('bindings, profiles and fixed command arguments cannot be replaced by raw commands or credential sources', () => {
  assert.equal(cliBindingSchema.safeParse({ ...a, profile: 'default' }).success, false);
  assert.equal(cliBindingSchema.safeParse({ ...a, roleName: 'read\ncredential_process=evil' }).success, false);
  assert.equal(cliBindingSchema.safeParse({ ...a, startUrl: 'https://evil.example/start' }).success, false);
  assert.notEqual(cliProfile(a), cliProfile(b)); assert.match(cliConfig(a), /sso_registration_scopes = sso:account:access/);
  for (const operation of ['login', 'identity', 'logout', 'lambda', 'dynamodb', 'alarms'] as const) {
    const args = cliArguments(a, operation); assert.equal(args[args.indexOf('--profile') + 1], cliProfile(a)); assert.ok(!args.includes('--debug')); assert.ok(!args.includes('--no-verify-ssl'));
  }
  assert.deepEqual(cliArguments(a, 'login').slice(0, 4), ['sso', 'login', '--use-device-code', '--no-browser']);
  assert.throws(() => cliArguments(a, 'delete-resource' as CliOperation), code('unsupported_cli_operation'));
  const inherited = { AWS_ACCESS_KEY_ID: 'synthetic-secret', AWS_SECRET_ACCESS_KEY: 'synthetic-secret', AWS_SESSION_TOKEN: 'synthetic-secret', AWS_PROFILE: 'default', AWS_ENDPOINT_URL: 'https://evil.example', AWS_WEB_IDENTITY_TOKEN_FILE: '/private', AWS_CONTAINER_CREDENTIALS_FULL_URI: 'http://metadata/', HTTPS_PROXY: 'http://company-proxy.invalid', AWS_CA_BUNDLE: '/company/ca.pem' };
  const env = cliEnvironment('/dedicated/.aws', inherited);
  for (const key of Object.keys(inherited).filter(key => !['HTTPS_PROXY', 'AWS_CA_BUNDLE'].includes(key))) assert.equal(env[key], undefined);
  assert.equal(env.HTTPS_PROXY, inherited.HTTPS_PROXY); assert.equal(env.AWS_EC2_METADATA_DISABLED, 'true'); assert.equal(inherited.AWS_PROFILE, 'default');
});

test('dedicated cache provisioning preserves each binding, refuses reuse, tampering and symlinks', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cloudops-cli-fixture-'))); t.after(() => rm(root, { recursive: true, force: true }));
  const first = join(root, 'a'), second = join(root, 'b');
  await prepareCliDirectory(first, a); await prepareCliDirectory(second, b);
  assert.notEqual(await readFile(join(first, 'config'), 'utf8'), await readFile(join(second, 'config'), 'utf8'));
  assert.equal((await stat(first)).mode & 0o777, 0o700); assert.equal((await stat(join(first, 'config'))).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(join(first, 'sso/cache')), []); assert.equal(await readFile(join(first, 'credentials'), 'utf8'), '');
  await prepareCliDirectory(first, a); await assert.rejects(prepareCliDirectory(first, b), code('worker_binding_changed'));
  const link = join(root, 'linked'); await symlink(first, link); await assert.rejects(prepareCliDirectory(link, a), code('worker_storage_invalid'));
  await writeFile(join(first, 'config'), '[default]\ncredential_process = evil\n'); await assert.rejects(prepareCliDirectory(first, a), code('worker_binding_changed'));
});

test('offline mode refuses the production runtime before it provisions storage or starts AWS CLI', async () => {
  assert.equal(process.env.CLOUDOPS_OFFLINE_TEST, '1');
  await assert.rejects(createDedicatedCliRuntime(a), code('offline_cli_forbidden'));
});

test('bounded subprocess captures safe output, suppresses errors and reaps cancelled/oversized children', async () => {
  const spec = (program: string, timeoutMs = 2000, maxBytes = 1000) => ({ executable: process.execPath, args: ['-e', program], env: {}, timeoutMs, maxBytes });
  assert.deepEqual(await boundedCliProcess(spec('process.stdout.write("ok")'), new AbortController().signal), { stdout: 'ok' });
  await assert.rejects(boundedCliProcess(spec('process.stderr.write("private-secret AccessDeniedException"); process.exit(1)'), new AbortController().signal), error => code('sso_denied')(error) && !(error as Error).message.includes('secret'));
  await assert.rejects(boundedCliProcess(spec('process.stdout.write("x".repeat(2000)); setInterval(()=>{},1000)'), new AbortController().signal), code('cli_output_limit'));
  await assert.rejects(boundedCliProcess(spec('setInterval(()=>{},1000)', 30), new AbortController().signal), code('cli_timeout'));
  const controller = new AbortController(); let started = false;
  const cancelled = boundedCliProcess(spec('process.stdout.write("started"); setInterval(()=>{},1000)'), controller.signal, () => { started = true; controller.abort(); });
  await assert.rejects(cancelled, code('cli_cancelled')); assert.equal(started, true);
  await assert.rejects(boundedCliProcess(spec('process.stdout.write("bad")'), new AbortController().signal, () => { throw new Error('private parser detail'); }), code('invalid_device_output'));
});

test('private worker protocol rejects actor/profile overrides, replays request IDs and returns only projected data', async () => {
  const s = fixture(), input = new PassThrough(), output = new PassThrough(), replies: { id: string | null; ok: boolean; code?: string; result?: unknown }[] = [];
  output.setEncoding('utf8'); output.on('data', chunk => { for (const line of String(chunk).trim().split('\n')) replies.push(JSON.parse(line)); });
  const running = serveCliWorker(s.worker, input, output);
  let n = 0;
  const request = async (value: unknown) => { const length = replies.length; input.write(`${JSON.stringify(value)}\n`); await until(() => replies.length > length); return replies.at(-1)!; };
  const nextId = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
  try {
    for (const override of [{ actorId: 'actor-b' }, { profile: 'default' }, { command: 'aws iam create-user' }]) assert.equal((await request({ id: nextId(), operation: 'verify', ...override })).code, 'invalid_worker_request');
    assert.equal(s.calls.length, 0);
    const id = nextId(); assert.equal((await request({ id, operation: 'verify' })).ok, true);
    assert.equal((await request({ id, operation: 'verify' })).ok, true); assert.deepEqual(s.calls, ['identity']);
    assert.equal((await request({ id, operation: 'logout' })).code, 'request_key_conflict');
    const result = await request({ id: nextId(), operation: 'inspect', service: 'lambda' });
    assert.equal(result.ok, true); assert.ok(JSON.stringify(result).includes('synthetic-resource')); assert.ok(!JSON.stringify(result).includes('AROA'));
  } finally { input.end(); await running; output.destroy(); }
  assert.throws(() => s.worker.start(context()), code('worker_closed'));
});

test('closing the controller pipe shuts down only its owned worker and ignores late login completion', async () => {
  const s = fixture(), input = new PassThrough(), output = new PassThrough(); output.resume();
  const running = serveCliWorker(s.worker, input, output);
  input.write(JSON.stringify({ id: '33333333-3333-4333-8333-333333333333', operation: 'login' }) + '\n');
  await until(() => s.calls.includes('login')); input.destroy(); await nextTurn();
  assert.equal(s.signals[0].aborted, true); s.login.resolve(); await running; output.destroy();
  assert.deepEqual(s.calls, ['login']); assert.equal(s.worker.status(context()).status, 'disconnected');
});
