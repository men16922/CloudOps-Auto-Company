import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { dockerWorkerFailure, type DockerWorkerPipe } from './organization-worker-docker-contract';

type ProcessSpec = { executable: string; args: readonly string[]; env: NodeJS.ProcessEnv };
export type WorkerProcessLauncher = (spec: ProcessSpec) => ChildProcessWithoutNullStreams;
const nativeLaunch: WorkerProcessLauncher = spec => spawn(spec.executable, [...spec.args], {
  env: spec.env, shell: false, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
});

/** Internal private attachment primitive. Only the fixed, guarded Docker engine supplies production arguments.
 * The launcher port lets local Node/fake-process tests exercise lifecycle without Docker or its socket.
 */
export async function attachWorkerProcess(spec: ProcessSpec, signal: AbortSignal, launch: WorkerProcessLauncher = nativeLaunch): Promise<DockerWorkerPipe> {
  if (signal.aborted) throw dockerWorkerFailure();
  let child: ChildProcessWithoutNullStreams;
  try { child = launch({ ...spec, args: [...spec.args], env: { ...spec.env } }); } catch { throw dockerWorkerFailure(); }
  let closed = false, bytes = 0, stopRequested = false, closing: Promise<void> | undefined;
  child.once('close', () => { closed = true; });
  const stop = () => {
    if (closed || stopRequested) return; stopRequested = true;
    try { child.kill('SIGKILL'); } catch { /* Only a subsequent close event proves termination. */ }
  };
  // Install before returning the pipe: errors can happen before the router attaches its handlers.
  child.on('error', stop);
  for (const stream of [child.stdin, child.stdout, child.stderr]) stream.on('error', stop);
  child.stderr.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 65_536) stop(); });
  const close = (): Promise<void> => {
    if (closed) return Promise.resolve();
    if (closing) return closing;
    closing = new Promise<void>((resolve, reject) => {
      const confirm = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => { child.off('close', confirm); reject(dockerWorkerFailure()); }, 2000);
      child.once('close', confirm); stopRequested = false; stop();
    });
    const pending = closing;
    void pending.then(() => { if (closing === pending) closing = undefined; }, () => { if (closing === pending) closing = undefined; });
    return pending;
  };
  try {
    await new Promise<void>((resolve, reject) => {
      // Keep the spawn listener after cancellation so a late child is also terminated.
      const abort = () => { stop(); reject(dockerWorkerFailure()); };
      const finish = () => { signal.removeEventListener('abort', abort); child.off('spawn', started); child.off('error', failed); child.off('close', failed); };
      const failed = () => { finish(); reject(dockerWorkerFailure()); };
      const started = () => { finish(); if (signal.aborted) { stopRequested = false; abort(); } else resolve(); };
      child.once('error', failed); child.once('close', failed); child.once('spawn', started);
      signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
    });
    if (closed || signal.aborted) throw dockerWorkerFailure();
    return { input: child.stdin, output: child.stdout, close };
  } catch { await close(); throw dockerWorkerFailure(); }
}
