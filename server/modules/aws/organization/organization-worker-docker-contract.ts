import { createHash } from 'node:crypto';
import { isAbsolute, join, normalize } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { z } from 'zod';
import { bindingDigest, cliBindingSchema } from './organization-cli-contract';
import { workerLeaseHandleSchema } from './organization-worker-leases';
import type { WorkerAllocation } from './organization-worker-supervisor';
import { CloudOperationError } from '../../../../src/domain/cloud-workflow';

const path = z.string().min(2).max(1024).refine(value => isAbsolute(value) && normalize(value) === value && !/[\x00-\x1f,]/.test(value) && value !== '/');
export const dockerWorkerConfigSchema = z.object({
  executable: path, socketPath: path, metadataRoot: path,
  daemonId: z.string().regex(/^[A-Za-z0-9:._-]{8,128}$/), imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  network: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/).refine(value => !['host', 'bridge', 'default'].includes(value)),
}).strict();
export type DockerWorkerConfig = z.infer<typeof dockerWorkerConfigSchema>;
export const dockerContainerIdSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const dockerWorkerFailure = () => new CloudOperationError(503, 'worker_infrastructure_unconfirmed', 'The isolated worker infrastructure could not be confirmed.');
export function checkedAllocation(input: unknown): WorkerAllocation {
  const value = z.object({ binding: cliBindingSchema, handle: workerLeaseHandleSchema }).strict().parse(input);
  if (value.handle.connectionId !== value.binding.connectionId || value.handle.bindingDigest !== bindingDigest(value.binding)) throw dockerWorkerFailure();
  return value;
}
export const dockerConfigDigest = (config: DockerWorkerConfig) => createHash('sha256').update(JSON.stringify(dockerWorkerConfigSchema.parse(config))).digest('hex');
export function dockerAllocationLabels(config: DockerWorkerConfig, allocation: WorkerAllocation) {
  return { 'cloudops.auto.kind': 'organization-worker', 'cloudops.auto.binding': allocation.handle.bindingDigest,
    'cloudops.auto.lease': allocation.handle.leaseId, 'cloudops.auto.generation': String(allocation.handle.generation),
    'cloudops.auto.supervisor': allocation.handle.supervisorId, 'cloudops.auto.cache': allocation.handle.cacheKey,
    'cloudops.auto.config': dockerConfigDigest(config) };
}
export const dockerTmpfs = {
  '/home/cloudops-worker/.aws': 'rw,noexec,nosuid,nodev,size=16777216,uid=10001,gid=10001,mode=0700',
  '/tmp': 'rw,noexec,nosuid,nodev,size=16777216,uid=10001,gid=10001,mode=0700',
};
export function dockerCreateArguments(config: DockerWorkerConfig, allocation: WorkerAllocation): string[] {
  const directory = join(config.metadataRoot, allocation.handle.leaseId);
  return ['container', 'create', '--name', allocation.handle.resourceKey, '--pull=never', '--interactive', '--user=10001:10001',
    '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges:true', '--memory=268435456', '--memory-swap=268435456',
    '--cpus=0.25', '--pids-limit=64', '--restart=no', '--log-driver=none', '--no-healthcheck', '--ipc=private',
    '--network', config.network, '--entrypoint=node', '--env=CLOUDOPS_CLI_WORKER=1',
    ...Object.entries(dockerTmpfs).flatMap(([target, value]) => ['--tmpfs', `${target}:${value}`]),
    ...['binding.json', 'lease.json'].flatMap(file => ['--mount', `type=bind,src=${join(directory, file)},dst=/run/cloudops/${file},readonly`]),
    ...Object.entries(dockerAllocationLabels(config, allocation)).flatMap(([key, value]) => ['--label', `${key}=${value}`]),
    config.imageId, '/app/worker.mjs'];
}
export type DockerWorkerPipe = { input: Writable; output: Readable; close(): Promise<void> };
/** Fixed local infrastructure port only; no browser-owned paths, command strings or credentials. */
export interface DockerWorkerEngine {
  prepare(allocation: WorkerAllocation, signal: AbortSignal): Promise<void>;
  create(allocation: WorkerAllocation, signal: AbortSignal): Promise<string>;
  start(id: string, signal: AbortSignal): Promise<void>;
  inspect(id: string, allocation: WorkerAllocation, signal: AbortSignal): Promise<'absent' | 'created' | 'running' | 'stopped'>;
  attach(id: string, signal: AbortSignal): Promise<DockerWorkerPipe>;
  remove(id: string, signal: AbortSignal): Promise<void>;
}
