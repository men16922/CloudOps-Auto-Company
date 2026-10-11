import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { bindingDigest, cliArguments, cliBindingSchema, cliConfig, cliFailure, cliTargetSchema, type CliBinding, type CliRuntime } from '../../../packages/worker-protocol/cli-contract';
import { boundedCliProcess } from '../../../packages/worker-protocol/bounded-process';

export const workerHome = '/home/cloudops-worker';
const awsDirectory = `${workerHome}/.aws`;

async function privatePath(path: string, directory: boolean) {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())
    || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw cliFailure('worker_storage_invalid', 503);
}
async function ensureDirectory(path: string) {
  try { await mkdir(path, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  await privatePath(path, true);
}
async function fixedFile(path: string, content: string) {
  try {
    const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  await privatePath(path, false);
  if (await readFile(path, 'utf8') !== content) throw cliFailure('worker_binding_changed', 503);
}
/** Provision only a new dedicated directory; never imports host CLI files or copies tokens. */
export const accountConfigPath = (directory: string, accountId: string) => join(directory, `config-a${cliTargetSchema.shape.accountId.parse(accountId)}`);
export async function prepareCliDirectory(directory: string, input: unknown, accountId?: string) {
  const binding = cliBindingSchema.parse(input);
  if (!isAbsolute(directory)) throw cliFailure('worker_storage_invalid', 503);
  await ensureDirectory(directory);
  if (await realpath(directory) !== directory) throw cliFailure('worker_storage_invalid', 503);
  await fixedFile(join(directory, 'cloudops-binding.sha256'), `${bindingDigest(binding)}\n`);
  await fixedFile(join(directory, 'config'), cliConfig(binding));
  // Each target account gets its own immutable config file (same SSO session and token cache, one extra profile).
  if (accountId !== undefined && accountId !== binding.accountId) await fixedFile(accountConfigPath(directory, accountId), cliConfig(binding, accountId));
  await fixedFile(join(directory, 'credentials'), '');
  for (const parent of ['sso', 'cli']) { await ensureDirectory(join(directory, parent)); await ensureDirectory(join(directory, parent, 'cache')); }
}

/** Explicit allowlist: credentials, profile and endpoint variables are never inherited. */
export function cliEnvironment(directory: string, deployment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', PYTHONUNBUFFERED: '1',
    AWS_CONFIG_FILE: join(directory, 'config'), AWS_SHARED_CREDENTIALS_FILE: join(directory, 'credentials'),
    AWS_PAGER: '', AWS_CLI_AUTO_PROMPT: 'off', AWS_EC2_METADATA_DISABLED: 'true',
    AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: 'true', AWS_MAX_ATTEMPTS: '2',
  };
  for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'AWS_CA_BUNDLE']) {
    if (deployment[name]) env[name] = deployment[name];
  }
  return env;
}

/** Must run as a dedicated non-root Linux worker, not inside the shared/local API process. */
export async function createDedicatedCliRuntime(input: unknown): Promise<CliRuntime> {
  const binding: CliBinding = cliBindingSchema.parse(input);
  const guard = () => {
    if (process.env.CLOUDOPS_OFFLINE_TEST === '1') throw cliFailure('offline_cli_forbidden', 503);
    if (process.env.CLOUDOPS_CLI_WORKER !== '1' || process.platform !== 'linux'
      || !process.getuid || process.getuid() === 0 || homedir() !== workerHome) throw cliFailure('isolated_worker_required', 503);
  };
  guard(); await prepareCliDirectory(awsDirectory, binding);
  const env = cliEnvironment(awsDirectory, process.env);
  return {
    async run(operation, signal, output, input, target) {
      // Reads run one at a time, so the config can carry exactly the profile this run needs.
      const account = operation === 'config-query' ? binding.inventory?.config?.accountId : target?.accountId;
      guard(); await prepareCliDirectory(awsDirectory, binding, account);
      const runEnv = account !== undefined && account !== binding.accountId ? { ...env, AWS_CONFIG_FILE: accountConfigPath(awsDirectory, account) } : env;
      // Metric searches return up to 500 series per expression before the worker keeps the top entries.
      return boundedCliProcess({ executable: '/usr/local/bin/aws', args: cliArguments(binding, operation, input, target), env: runEnv,
        timeoutMs: operation === 'login' ? 600_000 : 20_000, maxBytes: operation === 'login' ? 32_768 : operation === 'metrics' || operation === 'config-query' ? 2_000_000 : 512_000 }, signal, output);
    },
  };
}
