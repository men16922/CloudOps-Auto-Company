import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { CloudOperationError } from '../../../../src/domain/cloud-workflow';
import { bindingDigest, cliArguments, cliBindingSchema, cliConfig, cliFailure, cliTargetSchema, type CliBinding, type CliRuntime } from './organization-cli-contract';

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

type ProcessSpec = { executable: string; args: string[]; env: NodeJS.ProcessEnv; timeoutMs: number; maxBytes: number };
/** Internal process primitive. Only the fixed-operation runtime is exposed to worker actions. */
export function boundedCliProcess(spec: ProcessSpec, signal: AbortSignal, output?: (chunk: string) => void): Promise<{ stdout: string }> {
  if (signal.aborted) return Promise.reject(cliFailure('cli_cancelled', 409));
  return new Promise((resolve, reject) => {
    const child = spawn(spec.executable, spec.args, { env: spec.env, shell: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '', stderr = '', bytes = 0, failure: CloudOperationError | undefined;
    let force: ReturnType<typeof setTimeout> | undefined;
    const stop = (error: CloudOperationError) => {
      if (failure) return; failure = error; child.kill('SIGTERM');
      force = setTimeout(() => child.kill('SIGKILL'), 2000); force.unref();
    };
    const abort = () => stop(cliFailure('cli_cancelled', 409));
    const timer = setTimeout(() => stop(cliFailure('cli_timeout', 504)), spec.timeoutMs); timer.unref();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    for (const [stream, kind] of [[child.stdout, 'stdout'], [child.stderr, 'stderr']] as const) {
      stream.setEncoding('utf8');
      stream.on('data', (chunk: string) => {
        if (failure) return;
        bytes += Buffer.byteLength(chunk);
        if (bytes > spec.maxBytes) { stop(cliFailure('cli_output_limit')); return; }
        if (kind === 'stdout') stdout += chunk; else stderr += chunk;
        try { output?.(chunk); } catch (error) { stop(error instanceof CloudOperationError ? error : cliFailure('invalid_device_output')); }
      });
    }
    child.once('error', () => { failure ??= cliFailure('cli_unavailable', 503); });
    child.once('close', code => {
      clearTimeout(timer); if (force) clearTimeout(force); signal.removeEventListener('abort', abort);
      if (failure) reject(failure);
      else if (code === 0) resolve({ stdout });
      else {
        const name = /\b(AccessDeniedException|ExpiredTokenException|AWSOrganizationsNotInUseException|TooManyRequestsException|AccessDenied|UnauthorizedOperation|ForbiddenException|AuthorizationError|Throttling|ThrottlingException|InvalidAccessException|SubscriptionRequiredException)\b/.exec(stderr)?.[1];
        // Service-level denials (missing IAM permission for one API) are distinct from SSO denial. Security Hub reports "not enabled"
        // as InvalidAccessException; AWS Health without a Business-level support plan as SubscriptionRequiredException.
        reject(cliFailure(name === 'AccessDeniedException' ? 'sso_denied' : name === 'ExpiredTokenException' ? 'sso_expired' : name === 'AWSOrganizationsNotInUseException' ? 'organization_not_in_use'
          : name === 'InvalidAccessException' ? 'service_not_enabled' : name === 'SubscriptionRequiredException' ? 'service_not_subscribed'
          : name && ['TooManyRequestsException', 'Throttling', 'ThrottlingException'].includes(name) ? 'cli_throttled' : name ? 'access_denied' : 'cli_failed'));
      }
      stdout = ''; stderr = '';
    });
  });
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
