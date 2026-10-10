import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { boundedCliProcess } from './organization-cli-runtime';
import { attachWorkerProcess } from './organization-worker-docker-process';
import { checkedAllocation, dockerAllocationLabels, dockerContainerIdSchema, dockerCreateArguments, dockerTmpfs,
  dockerWorkerConfigSchema, dockerWorkerFailure, type DockerWorkerConfig, type DockerWorkerEngine, type DockerWorkerPipe } from './organization-worker-docker-contract';

export interface DockerCommandTransport {
  assertAvailable(): void;
  exec(args: readonly string[], signal: AbortSignal): Promise<string>;
  attach(args: readonly string[], signal: AbortSignal): Promise<DockerWorkerPipe>;
}
async function privateDirectory(path: string) {
  try { await mkdir(path, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw dockerWorkerFailure(); }
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.() || await realpath(path) !== path) throw dockerWorkerFailure();
}
async function fixedMetadata(path: string, content: string, mode: number) {
  try {
    const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
    try { await file.writeFile(content); await file.chmod(mode); await file.sync(); } finally { await file.close(); }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw dockerWorkerFailure(); }
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== mode || await readFile(path, 'utf8') !== content) throw dockerWorkerFailure();
}
const projection = '{"id":{{json .Id}},"name":{{json .Name}},"image":{{json .Image}},"labels":{{json .Config.Labels}},"running":{{json .State.Running}},"status":{{json .State.Status}},"user":{{json .Config.User}},"entrypoint":{{json .Config.Entrypoint}},"cmd":{{json .Config.Cmd}},"stdin":{{json .Config.OpenStdin}},"tty":{{json .Config.Tty}},"readonly":{{json .HostConfig.ReadonlyRootfs}},"privileged":{{json .HostConfig.Privileged}},"capAdd":{{json .HostConfig.CapAdd}},"capDrop":{{json .HostConfig.CapDrop}},"security":{{json .HostConfig.SecurityOpt}},"network":{{json .HostConfig.NetworkMode}},"pidMode":{{json .HostConfig.PidMode}},"ipcMode":{{json .HostConfig.IpcMode}},"restart":{{json .HostConfig.RestartPolicy.Name}},"memory":{{json .HostConfig.Memory}},"swap":{{json .HostConfig.MemorySwap}},"cpus":{{json .HostConfig.NanoCpus}},"pids":{{json .HostConfig.PidsLimit}},"logs":{{json .HostConfig.LogConfig.Type}},"ports":{{json .HostConfig.PortBindings}},"devices":{{json .HostConfig.Devices}},"tmpfs":{{json .HostConfig.Tmpfs}},"mounts":{{json .Mounts}}}';
const observationSchema = z.object({
  id: dockerContainerIdSchema, name: z.string(), image: z.string(), labels: z.record(z.string(), z.string()), running: z.boolean(), status: z.string(),
  user: z.literal('10001:10001'), entrypoint: z.tuple([z.literal('node')]), cmd: z.tuple([z.literal('/app/worker.mjs')]), stdin: z.literal(true), tty: z.literal(false),
  readonly: z.literal(true), privileged: z.literal(false), capAdd: z.array(z.string()).nullable(), capDrop: z.array(z.string()), security: z.array(z.string()),
  network: z.string(), pidMode: z.literal(''), ipcMode: z.literal('private'), restart: z.literal('no'), memory: z.literal(268435456), swap: z.literal(268435456),
  cpus: z.literal(250000000), pids: z.literal(64), logs: z.literal('none'), ports: z.record(z.string(), z.unknown()).nullable(), devices: z.array(z.unknown()).nullable(),
  tmpfs: z.record(z.string(), z.string()), mounts: z.array(z.object({ Type: z.string(), Source: z.string(), Destination: z.string(), RW: z.boolean() }).passthrough()).max(4),
}).strict();

/** Fixed CLI adapter. Injected command transports enable synthetic verification without contacting Docker. */
export function dockerWorkerEngine(input: unknown, transport: DockerCommandTransport): DockerWorkerEngine {
  const config = dockerWorkerConfigSchema.parse(input);
  const prefix = ['--host', `unix://${config.socketPath}`, '--config', join(config.metadataRoot, 'client')];
  const raw = async (args: readonly string[], signal: AbortSignal) => {
    transport.assertAvailable(); if (signal.aborted) throw dockerWorkerFailure();
    try { return await transport.exec([...prefix, ...args], signal); } catch { throw dockerWorkerFailure(); }
  };
  const daemon = async (signal: AbortSignal) => {
    let id: unknown; try { id = JSON.parse(await raw(['info', '--format', '{{json .ID}}'], signal)); } catch { throw dockerWorkerFailure(); }
    if (id !== config.daemonId) throw dockerWorkerFailure();
  };
  const run = async (args: readonly string[], signal: AbortSignal) => { await daemon(signal); const value = await raw(args, signal); await daemon(signal); return value; };
  const idResult = async (args: readonly string[], signal: AbortSignal, expected?: string) => {
    const id = dockerContainerIdSchema.parse((await run(args, signal)).trim());
    if (expected && id !== expected) throw dockerWorkerFailure(); return id;
  };
  return {
    async prepare(inputAllocation, signal) {
      transport.assertAvailable(); if (signal.aborted) throw dockerWorkerFailure(); const allocation = checkedAllocation(inputAllocation);
      await privateDirectory(config.metadataRoot); await privateDirectory(join(config.metadataRoot, 'client'));
      await fixedMetadata(join(config.metadataRoot, 'client/config.json'), '{"auths":{}}\n', 0o600);
      const directory = join(config.metadataRoot, allocation.handle.leaseId); await privateDirectory(directory);
      // No credentials: parent is 0700; read-only bind files must be readable by container UID 10001.
      await fixedMetadata(join(directory, 'binding.json'), `${JSON.stringify(allocation.binding)}\n`, 0o444);
      await fixedMetadata(join(directory, 'lease.json'), `${JSON.stringify(allocation.handle)}\n`, 0o444);
      await daemon(signal);
    },
    async create(inputAllocation, signal) { return idResult(dockerCreateArguments(config, checkedAllocation(inputAllocation)), signal); },
    async start(id, signal) { dockerContainerIdSchema.parse(id); await idResult(['container', 'start', id], signal, id); },
    async remove(id, signal) { dockerContainerIdSchema.parse(id); await idResult(['container', 'rm', '--force', id], signal, id); },
    async inspect(id, inputAllocation, signal) {
      dockerContainerIdSchema.parse(id); const allocation = checkedAllocation(inputAllocation);
      const present = (await run(['container', 'ls', '--all', '--no-trunc', '--filter', `id=${id}`, '--format', '{{.ID}}'], signal)).trim();
      if (!present) return 'absent'; if (present !== id) throw dockerWorkerFailure();
      let value: z.infer<typeof observationSchema>;
      try { value = observationSchema.parse(JSON.parse(await run(['container', 'inspect', '--format', projection, id], signal))); } catch { throw dockerWorkerFailure(); }
      if (value.id !== id || value.name !== `/${allocation.handle.resourceKey}` || value.image !== config.imageId
        || Object.entries(dockerAllocationLabels(config, allocation)).some(([key, expected]) => value.labels[key] !== expected)
        || value.capAdd?.length || value.capDrop.length !== 1 || value.capDrop[0].toUpperCase() !== 'ALL'
        || !value.security.some(item => ['no-new-privileges', 'no-new-privileges:true'].includes(item))
        || value.network !== config.network || Object.keys(value.ports ?? {}).length || value.devices?.length
        || JSON.stringify(Object.entries(value.tmpfs).sort()) !== JSON.stringify(Object.entries(dockerTmpfs).sort())) throw dockerWorkerFailure();
      const expectedMounts = ['binding.json', 'lease.json'].map(file => ({ Source: join(config.metadataRoot, allocation.handle.leaseId, file), Destination: `/run/cloudops/${file}` }));
      const binds = value.mounts.filter(mount => mount.Type === 'bind');
      if (binds.length !== 2 || expectedMounts.some(expected => !binds.some(mount => !mount.RW && mount.Source === expected.Source && mount.Destination === expected.Destination))
        || value.mounts.some(mount => mount.Type !== 'bind' && (mount.Type !== 'tmpfs' || !(mount.Destination in dockerTmpfs)))) throw dockerWorkerFailure();
      if (value.running && value.status === 'running') return 'running';
      if (!value.running && value.status === 'created') return 'created';
      if (!value.running && ['exited', 'dead'].includes(value.status)) return 'stopped';
      throw dockerWorkerFailure();
    },
    async attach(id, signal) {
      dockerContainerIdSchema.parse(id); await daemon(signal); transport.assertAvailable(); if (signal.aborted) throw dockerWorkerFailure();
      const pipe = await transport.attach([...prefix, 'container', 'attach', '--sig-proxy=false', id], signal);
      try { await daemon(signal); return pipe; } catch { await pipe.close(); throw dockerWorkerFailure(); }
    },
  };
}

/** Merely constructing the disabled factory performs no filesystem, CLI or socket access. */
export function createLocalDockerWorkerEngine(input: unknown): DockerWorkerEngine | undefined {
  if (process.env.CLOUDOPS_ORGANIZATION_DOCKER_ENABLED !== '1' || process.env.CLOUDOPS_OFFLINE_TEST === '1') return undefined;
  const config: DockerWorkerConfig = dockerWorkerConfigSchema.parse(input);
  const guard = () => { if (process.env.CLOUDOPS_ORGANIZATION_DOCKER_ENABLED !== '1' || process.env.CLOUDOPS_OFFLINE_TEST === '1') throw dockerWorkerFailure(); };
  const env = { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', DOCKER_CLI_HINTS: 'false' };
  return dockerWorkerEngine(config, {
    assertAvailable: guard,
    async exec(args, signal) {
      guard(); try { return (await boundedCliProcess({ executable: config.executable, args: [...args], env, timeoutMs: 20_000, maxBytes: 262_144 }, signal)).stdout; }
      catch { throw dockerWorkerFailure(); }
    },
    async attach(args, signal) {
      guard(); if (signal.aborted) throw dockerWorkerFailure();
      return attachWorkerProcess({ executable: config.executable, args, env }, signal);
    },
  });
}
