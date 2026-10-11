import { lstat, readFile } from 'node:fs/promises';
import { createDedicatedCliRuntime } from './cli-runtime';
import { OrganizationCliWorker } from './cli-worker';
import { serveCliWorker } from './serve';
import { workerLeaseHandleSchema } from '../../../packages/worker-protocol/lease-handle';

// Standalone worker entry. Never imported by the shared API or personal AWS startup.
process.umask(0o077);
let worker: OrganizationCliWorker | undefined;
try {
  const bindingFile = '/run/cloudops/binding.json', metadata = await lstat(bindingFile);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 16_384) throw new Error('Invalid binding mount');
  const binding: unknown = JSON.parse(await readFile(bindingFile, 'utf8'));
  const leaseFile = '/run/cloudops/lease.json', leaseMetadata = await lstat(leaseFile);
  if (!leaseMetadata.isFile() || leaseMetadata.isSymbolicLink() || leaseMetadata.size > 16_384) throw new Error('Invalid allocation mount');
  const allocation = workerLeaseHandleSchema.parse(JSON.parse(await readFile(leaseFile, 'utf8')));
  const runtime = await createDedicatedCliRuntime(binding);
  worker = new OrganizationCliWorker(binding, runtime);
  const shutdown = () => { process.stdin.destroy(); void worker?.close(); };
  process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);
  await serveCliWorker(worker, process.stdin, process.stdout, allocation);
} catch {
  // No raw OS, configuration, CLI, token or provider error may enter container logs.
  process.stderr.write('Organization CLI worker could not start or complete its request.\n');
  process.exitCode = 1;
} finally { await worker?.close(); }
