import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import { attachWorkerProcess, type WorkerProcessLauncher } from '../../../apps/host/src/workers/docker/process';
import { CloudOperationError } from '../../../packages/contracts/errors';

const signal = () => new AbortController().signal;
const spec = (code: string, args: string[] = []) => ({ executable: process.execPath, args: ['-e', code, ...args], env: { LANG: 'C.UTF-8' } });
const echo = `process.stdin.on('data', value => process.stdout.write(value));`;
const failed = (error: unknown) => error instanceof CloudOperationError && error.code === 'worker_infrastructure_unconfirmed';

test('native private attachment preserves bytes and literal argv without inheriting a host credential environment', async t => {
  const marker = 'literal;$(do-not-execute)', pipe = await attachWorkerProcess(spec(`process.stdout.write(JSON.stringify({args:process.argv.slice(1),keys:Object.keys(process.env)})+'\\n'); ${echo}`, [marker]), signal());
  t.after(() => pipe.close());
  const [initial] = await once(pipe.output, 'data'), value = JSON.parse(initial.toString());
  assert.deepEqual(value.args, [marker]);
  // macOS can insert its text-encoding variable even when spawn receives an explicit environment.
  assert.deepEqual(value.keys.filter((key: string) => key !== '__CF_USER_TEXT_ENCODING'), ['LANG']);
  const received = once(pipe.output, 'data'); pipe.input.write('synthetic-private-message\n');
  assert.equal((await received)[0].toString(), 'synthetic-private-message\n');
  await Promise.all([pipe.close(), pipe.close()]); assert.equal(pipe.output.destroyed, true);
});

test('an expired provisioning signal does not kill an already attached private worker pipe', async t => {
  const abort = new AbortController(), pipe = await attachWorkerProcess(spec(echo), abort.signal); t.after(() => pipe.close());
  abort.abort(); const received = once(pipe.output, 'data'); pipe.input.write('still-owned\n');
  assert.equal((await received)[0].toString(), 'still-owned\n'); await pipe.close();
});

test('cancelled launch does not create a process; a cancellation during spawn waits for child close', async () => {
  const before = new AbortController(); before.abort(); let launches = 0;
  await assert.rejects(attachWorkerProcess(spec(echo), before.signal, () => { launches++; throw new Error('must not launch'); }), failed); assert.equal(launches, 0);
  const during = new AbortController(); let child: ChildProcessWithoutNullStreams | undefined, closed = false;
  const launch: WorkerProcessLauncher = value => {
    child = spawn(value.executable, [...value.args], { env: value.env, stdio: ['pipe', 'pipe', 'pipe'] });
    child.once('close', () => { closed = true; }); during.abort(); return child;
  };
  await assert.rejects(attachWorkerProcess(spec(echo), during.signal, launch), failed);
  assert.equal(closed, true); assert.ok(child?.signalCode);
});

test('spawn failures are sanitized and do not leak executable paths or raw launcher errors', async () => {
  await assert.rejects(attachWorkerProcess({ executable: '/synthetic-private-missing-executable', args: [], env: {} }, signal()), error => failed(error) && !String(error).includes('synthetic-private'));
  await assert.rejects(attachWorkerProcess(spec(echo), signal(), () => { throw new Error('synthetic-private-launcher-detail'); }), error => failed(error) && !String(error).includes('synthetic-private'));
});

test('stderr overflow terminates the attachment without publishing stderr on the private output', async t => {
  const pipe = await attachWorkerProcess(spec(`process.stderr.write('private'.repeat(10000)); setInterval(()=>{},1000);`), signal()); t.after(() => pipe.close());
  const output: Buffer[] = []; pipe.output.on('data', value => output.push(value));
  await once(pipe.output, 'close'); await pipe.close(); assert.equal(Buffer.concat(output).length, 0);
});

test('early child exit closes private streams and repeated cleanup is harmless', async t => {
  const pipe = await attachWorkerProcess(spec('process.exit(7)'), signal()); t.after(() => pipe.close());
  await once(pipe.output, 'close'); await pipe.close(); await pipe.close(); assert.equal(pipe.input.destroyed, true);
});

test('a private stdin error terminates the owned attachment without an unhandled stream exception', async t => {
  const pipe = await attachWorkerProcess(spec(echo), signal()); t.after(() => pipe.close());
  const closed = once(pipe.output, 'close');
  pipe.input.destroy(new Error('synthetic-private-write-failure'));
  await closed; await pipe.close(); assert.equal(pipe.output.destroyed, true);
});

test('an unconfirmed child termination has a bounded failure and cannot become a successful close receipt', async t => {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => false });
  const pipe = await attachWorkerProcess(spec(echo), signal(), () => {
    queueMicrotask(() => child.emit('spawn')); return child as unknown as ChildProcessWithoutNullStreams;
  });
  t.after(() => { child.emit('close', 0); child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); });
  await assert.rejects(pipe.close(), failed);
  child.emit('close', 0); await pipe.close();
});
