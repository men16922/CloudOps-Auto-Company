import { createHash } from 'node:crypto';
import { z } from 'zod';
import { CloudOperationError } from '../../../../src/domain/cloud-workflow';
import type { VerifiedCloudContext } from '../../../../src/domain/cloud-operations';
import { directoryScopeSchema, directoryParentId } from '../../../../src/modules/aws/domain/directory';

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
const region = z.string().regex(/^(us|eu|ap|ca|sa|af|me|il|mx)-(east|west|central|north|south|northeast|northwest|southeast|southwest)-[1-9]$/);
/** Loaded from a trusted connection registry, never from a browser request. */
export const cliBindingSchema = z.object({
  connectionId: z.uuid(), organizationId: id, actorId: id, workspaceId: id,
  startUrl: z.url().refine(value => {
    const url = new URL(value);
    return url.protocol === 'https:' && /^[a-z0-9-]+\.awsapps\.com$/.test(url.hostname)
      && /^\/start\/?$/.test(url.pathname) && !url.port && !url.username && !url.password && !url.search && !url.hash;
  }),
  ssoRegion: region, region, accountId: z.string().regex(/^\d{12}$/),
  roleName: z.string().regex(/^[\w+=,.@-]{1,64}$/),
  directory: directoryScopeSchema.optional(),
}).strict();
export type CliBinding = z.infer<typeof cliBindingSchema>;
export const cliReadSchema = z.enum(['lambda', 'dynamodb', 'alarms']);
export type CliRead = z.infer<typeof cliReadSchema>;
export type CliOperation = 'login' | 'identity' | 'logout' | CliRead | 'directory-organization' | 'directory-parent' | 'directory-accounts' | 'directory-ous' | 'directory-ancestors';
/** Internal only: values come from this worker's expiring directory grants. */
export const directoryQuerySchema = z.object({ parentId: directoryParentId, nextToken: z.string().min(1).max(100000).optional() }).strict();
export type DirectoryQuery = z.infer<typeof directoryQuerySchema>;
export type CliIdentity = { accountId: string; arn: string; userId: string };
export type CliLoginState = {
  connectionId: string; jobId?: string;
  status: 'disconnected' | 'starting' | 'awaiting-user' | 'verifying' | 'connected' | 'denied' | 'expired' | 'failed' | 'cancelled';
  /** Product deadline; not an assertion of AWS device-code expiry. */
  deadline?: string; userCode?: string; verificationUri?: string;
  accountId: string; roleName: string; region: string;
  code?: string;
};
export type CliResult = { stdout: string };
export interface CliRuntime {
  run(operation: CliOperation, signal: AbortSignal, output?: (chunk: string) => void, directoryQuery?: DirectoryQuery): Promise<CliResult>;
}
export function cliFailure(code = 'cli_failed', status = 502) {
  return new CloudOperationError(status, code, 'The organization CLI operation could not be confirmed.');
}
export function assertCliOwner(context: VerifiedCloudContext, binding: CliBinding) {
  if (context.owner.kind !== 'organization' || context.owner.organizationId !== binding.organizationId
    || context.actorId !== binding.actorId || context.workspaceId !== binding.workspaceId || context.channel !== 'web'
    || !context.roles.some(role => ['viewer', 'operator', 'reviewer'].includes(role))) throw cliFailure('connection_unavailable', 403);
}
export function cliProfile(binding: CliBinding) { return `cloudops-${binding.connectionId}`; }
export function bindingDigest(binding: CliBinding) {
  // Schema order is fixed, independent of the original JSON field order.
  return createHash('sha256').update(JSON.stringify(cliBindingSchema.parse(binding))).digest('hex');
}
export function cliConfig(binding: CliBinding) {
  const b = cliBindingSchema.parse(binding), profile = cliProfile(b);
  return `[sso-session ${profile}]\nsso_start_url = ${b.startUrl}\nsso_region = ${b.ssoRegion}\nsso_registration_scopes = sso:account:access\n\n[profile ${profile}]\nsso_session = ${profile}\nsso_account_id = ${b.accountId}\nsso_role_name = ${b.roleName}\nregion = ${b.region}\noutput = json\n`;
}
/** Each caller gets fixed arguments; there is no generic command/endpoint/profile input. */
export function cliArguments(binding: CliBinding, operation: CliOperation, input?: DirectoryQuery): string[] {
  const common = ['--profile', cliProfile(binding), '--region', binding.region, '--no-cli-pager', '--no-cli-auto-prompt', '--color', 'off'];
  if (operation.startsWith('directory-')) {
    const scope = directoryScopeSchema.parse(binding.directory);
    const query = directoryQuerySchema.parse(input ?? { parentId: scope.parentId });
    const parentId = query.parentId;
    const rootPart = (value: string) => value.startsWith('r-') ? value.slice(2) : value.split('-')[1];
    if (rootPart(parentId) !== rootPart(scope.parentId) || parentId.startsWith('r-') && parentId !== scope.parentId) throw cliFailure('directory_scope_mismatch', 403);
    if (query.nextToken && !['directory-accounts', 'directory-ous'].includes(operation)) throw cliFailure('invalid_directory_query');
    const pageInput = ['--cli-input-json', JSON.stringify({ ParentId: parentId, MaxResults: 20, ...(query.nextToken ? { NextToken: query.nextToken } : {}) })];
    const end = ['--no-paginate', '--output', 'json', ...common];
    switch (operation) {
      case 'directory-organization': return ['organizations', 'describe-organization', '--query', 'Organization.{Id:Id,MasterAccountId:MasterAccountId}', ...end];
      case 'directory-parent': return parentId.startsWith('r-')
        ? ['organizations', 'list-roots', '--max-results', '20', '--query', '{Items:Roots[].{Id:Id,Name:Name,Arn:Arn},HasMore:NextToken != `null`}', ...end]
        : ['organizations', 'describe-organizational-unit', '--organizational-unit-id', parentId, '--query', '{Items:[OrganizationalUnit.{Id:Id,Name:Name,Arn:Arn}],HasMore:`false`}', ...end];
      case 'directory-accounts': return ['organizations', 'list-accounts-for-parent', ...pageInput, '--query', '{Items:Accounts[].{Id:Id,Name:Name,Arn:Arn,State:State},NextToken:NextToken,HasMore:NextToken != `null`}', ...end];
      case 'directory-ous': return ['organizations', 'list-organizational-units-for-parent', ...pageInput, '--query', '{Items:OrganizationalUnits[].{Id:Id,Name:Name,Arn:Arn},NextToken:NextToken,HasMore:NextToken != `null`}', ...end];
      case 'directory-ancestors':
        if (!parentId.startsWith('ou-')) throw cliFailure('invalid_directory_query');
        return ['organizations', 'list-parents', '--child-id', parentId, '--max-results', '20', '--query', '{Items:Parents[].{Id:Id,Type:Type},HasMore:NextToken != `null`}', ...end];
    }
  }
  if (input) throw cliFailure('invalid_directory_query');
  switch (operation) {
    case 'login': return ['sso', 'login', '--use-device-code', '--no-browser', ...common];
    case 'logout': return ['sso', 'logout', ...common];
    case 'identity': return ['sts', 'get-caller-identity', '--output', 'json', ...common];
    case 'lambda': return ['lambda', 'list-functions', '--no-paginate', '--cli-input-json', '{"MaxItems":50}', '--query', '{Items:Functions[].{name:FunctionName,runtime:Runtime,modified:LastModified},HasMore:NextMarker != `null`}', '--output', 'json', ...common];
    case 'dynamodb': return ['dynamodb', 'list-tables', '--no-paginate', '--limit', '100', '--query', '{Items:TableNames[].{name:@},HasMore:LastEvaluatedTableName != `null`}', '--output', 'json', ...common];
    case 'alarms': return ['cloudwatch', 'describe-alarms', '--no-paginate', '--max-records', '100', '--alarm-types', 'MetricAlarm', 'CompositeAlarm', '--query', '{Items:[MetricAlarms[].{name:AlarmName,state:StateValue},CompositeAlarms[].{name:AlarmName,state:StateValue}][],HasMore:NextToken != `null`}', '--output', 'json', ...common];
    default: throw cliFailure('unsupported_cli_operation', 422);
  }
}
const identitySchema = z.object({ Account: z.string().regex(/^\d{12}$/), Arn: z.string().max(2048), UserId: z.string().min(1).max(256) });
export function checkedCliIdentity(raw: string, binding: CliBinding): CliIdentity {
  let value: z.infer<typeof identitySchema>;
  try { value = identitySchema.parse(JSON.parse(raw)); } catch { throw cliFailure('invalid_identity'); }
  const prefix = `arn:aws:sts::${binding.accountId}:assumed-role/AWSReservedSSO_${binding.roleName}_`;
  if (value.Account !== binding.accountId || !value.Arn.startsWith(prefix)
    || !/^[a-fA-F0-9]{16}\/[A-Za-z0-9+=,.@_-]{1,64}$/.test(value.Arn.slice(prefix.length))) throw cliFailure('identity_mismatch', 403);
  return { accountId: value.Account, arn: value.Arn, userId: value.UserId };
}

/** Parser for AWS CLI 2 device instructions. Unknown output fails closed at process completion. */
export class DeviceInstructionParser {
  private buffer = '';
  private readonly binding: CliBinding;
  constructor(binding: CliBinding) { this.binding = binding; }
  feed(chunk: string): { userCode: string; verificationUri: string } | undefined {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > 32_768) throw cliFailure('login_output_limit');
    // stdout/stderr chunks may split inside a URL or code; parse completed lines only.
    const complete = this.buffer.slice(0, this.buffer.lastIndexOf('\n') + 1);
    const urls = complete.match(/https:\/\/[^\s<>"']+/g) ?? [];
    const userCode = complete.match(/Then enter the code:\s*\r?\n\s*([A-Z0-9]{4}-[A-Z0-9]{4})(?:\s|$)/)?.[1];
    let verificationUri: string | undefined;
    for (const raw of urls) {
      let url: URL; try { url = new URL(raw); } catch { throw cliFailure('invalid_device_link'); }
      const isDevice = url.hostname === `device.sso.${this.binding.ssoRegion}.amazonaws.com` && url.pathname === '/';
      const isPortal = url.hostname === new URL(this.binding.startUrl).hostname && /^\/start\/?$/.test(url.pathname);
      if ((!isDevice && !isPortal) || url.port || url.username || url.password) throw cliFailure('invalid_device_link');
      // AWS CLI 2.30 prints the portal device page as <start>/#/device (code-free) for Identity Center.
      if (isPortal && !url.search && url.hash === '#/device') { verificationUri ??= url.href; continue; }
      // PrintOnlyHandler also prints verificationUriComplete. Validate its code but
      // expose the original code-free verification URI only.
      if (url.search || url.hash) {
        const query = url.hash && isPortal && !url.search && url.hash.startsWith('#/device?')
          ? new URLSearchParams(url.hash.slice('#/device?'.length)) : !url.hash ? url.searchParams : undefined;
        if (!userCode || !query || [...query.keys()].length !== 1 || query.get('user_code') !== userCode) throw cliFailure('invalid_device_link');
      } else verificationUri ??= url.href;
    }
    return verificationUri && userCode ? { verificationUri, userCode } : undefined;
  }
}
