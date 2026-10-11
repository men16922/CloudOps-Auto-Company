import { spawn } from 'node:child_process';
import { CloudOperationError } from '../contracts/errors';
import { cliFailure } from './cli-contract';

export type ProcessSpec = { executable: string; args: string[]; env: NodeJS.ProcessEnv; timeoutMs: number; maxBytes: number };
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
        const name = /\b(AccessDeniedException|ExpiredTokenException|AWSOrganizationsNotInUseException|TooManyRequestsException|AccessDenied|UnauthorizedOperation|ForbiddenException|AuthorizationError|Throttling|ThrottlingException|InvalidAccessException|SubscriptionRequiredException|ValidationException|InvalidAutomationExecutionParametersException|InvalidDocument|AutomationDefinitionNotFoundException|AutomationDefinitionVersionNotFoundException|ResourceNotFoundException)\b/.exec(stderr)?.[1];
        // Service-level denials (missing IAM permission for one API) are distinct from SSO denial. Security Hub reports "not enabled"
        // as InvalidAccessException; AWS Health without a Business-level support plan as SubscriptionRequiredException.
        reject(cliFailure(name === 'AccessDeniedException' ? 'sso_denied' : name === 'ExpiredTokenException' ? 'sso_expired' : name === 'AWSOrganizationsNotInUseException' ? 'organization_not_in_use'
          : name === 'InvalidAccessException' ? 'service_not_enabled' : name === 'SubscriptionRequiredException' ? 'service_not_subscribed'
          : name && ['TooManyRequestsException', 'Throttling', 'ThrottlingException'].includes(name) ? 'cli_throttled'
          : name && ['ValidationException', 'InvalidAutomationExecutionParametersException'].includes(name) ? 'cli_invalid_request'
          : name && ['InvalidDocument', 'AutomationDefinitionNotFoundException', 'AutomationDefinitionVersionNotFoundException', 'ResourceNotFoundException'].includes(name) ? 'cli_not_found'
          : name ? 'access_denied' : 'cli_failed'));
      }
      stdout = ''; stderr = '';
    });
  });
}
