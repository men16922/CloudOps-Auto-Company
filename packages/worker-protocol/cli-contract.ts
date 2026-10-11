import { createHash } from 'node:crypto';
import { z } from 'zod';
import { CloudOperationError } from '../contracts/errors';
import type { VerifiedCloudContext } from '../contracts/access-context';
import { directoryScopeSchema, directoryParentId } from '../contracts/aws/directory';
import { connectionMetricIds, connectionServices, requiredTagsSchema } from '../contracts/aws/connections';

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
  /** Server-fixed sync scope: candidate regions (absent = each account's enabled regions), account cap, an optional AWS Config aggregator
   * and the organization's required tag keys (compliance is evaluated in the UI from collected tag keys). */
  inventory: z.object({ regions: z.array(region).min(1).max(30).optional(), maxAccounts: z.number().int().min(1).max(200).optional(),
    config: z.object({ aggregator: z.string().regex(/^[\w-]{1,256}$/), accountId: z.string().regex(/^\d{12}$/), region }).strict().optional(),
    requiredTags: requiredTagsSchema.optional() }).strict().optional(),
}).strict();
export type CliBinding = z.infer<typeof cliBindingSchema>;
export const cliReadSchema = z.enum(connectionServices);
export type CliRead = z.infer<typeof cliReadSchema>;
export type CliOperation = 'login' | 'identity' | 'logout' | CliRead | 'eks-versions' | 'eks-cluster' | 'rds-lifecycle' | 'kafka-versions' | 'regions' | 'vpcs' | 'apigateway-rest' | 'apigateway-http' | 'config-query'
  | 'guardduty-detectors' | 'guardduty-findings' | 'guardduty-details' | 'tagged-resources'
  | 'directory-organization' | 'directory-parent' | 'directory-accounts' | 'directory-ous' | 'directory-ancestors' | 'directory-all-accounts';
/** Internal only: an account/region chosen by the worker from the fixed scope (Organizations under the configured parent, enabled or configured regions). */
export const cliTargetSchema = z.object({ accountId: z.string().regex(/^\d{12}$/), region }).strict();
export type CliTarget = z.infer<typeof cliTargetSchema>;
/** Fixed CloudWatch SEARCH expressions (standard AWS namespaces only). `label` validates the dynamic-label dimension value. */
export const metricQueries: ReadonlyArray<{ id: typeof connectionMetricIds[number]; search: string; stat: 'Average' | 'Maximum' | 'Minimum' | 'Sum'; dimension: string; worst: 'max' | 'min' | 'sum'; label: RegExp }> = [
  { id: 'ec2_cpu', search: '{AWS/EC2,InstanceId} MetricName="CPUUtilization"', stat: 'Average', dimension: 'InstanceId', worst: 'max', label: /^i-[a-f0-9]{8,17}$/ },
  { id: 'ec2_status', search: '{AWS/EC2,InstanceId} MetricName="StatusCheckFailed"', stat: 'Maximum', dimension: 'InstanceId', worst: 'max', label: /^i-[a-f0-9]{8,17}$/ },
  { id: 'rds_cpu', search: '{AWS/RDS,DBInstanceIdentifier} MetricName="CPUUtilization"', stat: 'Average', dimension: 'DBInstanceIdentifier', worst: 'max', label: /^[A-Za-z][A-Za-z0-9-]{0,62}$/ },
  { id: 'rds_storage', search: '{AWS/RDS,DBInstanceIdentifier} MetricName="FreeStorageSpace"', stat: 'Minimum', dimension: 'DBInstanceIdentifier', worst: 'min', label: /^[A-Za-z][A-Za-z0-9-]{0,62}$/ },
  { id: 'cache_cpu', search: '{AWS/ElastiCache,CacheClusterId,CacheNodeId} MetricName="CPUUtilization"', stat: 'Average', dimension: 'CacheClusterId', worst: 'max', label: /^[A-Za-z][A-Za-z0-9-]{0,49}$/ },
  { id: 'cache_memory', search: '{AWS/ElastiCache,CacheClusterId,CacheNodeId} MetricName="DatabaseMemoryUsagePercentage"', stat: 'Maximum', dimension: 'CacheClusterId', worst: 'max', label: /^[A-Za-z][A-Za-z0-9-]{0,49}$/ },
  { id: 'msk_cpu', search: '{AWS/Kafka,"Broker ID","Cluster Name"} MetricName="CpuUser"', stat: 'Average', dimension: 'Cluster Name', worst: 'max', label: /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/ },
  { id: 'msk_disk', search: '{AWS/Kafka,"Broker ID","Cluster Name"} MetricName="KafkaDataLogsDiskUsed"', stat: 'Maximum', dimension: 'Cluster Name', worst: 'max', label: /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/ },
  { id: 'lambda_errors', search: '{AWS/Lambda,FunctionName} MetricName="Errors"', stat: 'Sum', dimension: 'FunctionName', worst: 'sum', label: /^[A-Za-z0-9_-]{1,64}$/ },
];
/** AWS Config resource types read in aggregator mode (fixed SELECT per type). */
// ElastiCache is not an AWS Config resource type; it is always read directly.
export const configResourceTypes = ['AWS::EC2::VPC', 'AWS::EC2::Instance', 'AWS::EKS::Cluster', 'AWS::RDS::DBInstance', 'AWS::MSK::Cluster',
  'AWS::Lambda::Function', 'AWS::DynamoDB::Table', 'AWS::ApiGateway::RestApi', 'AWS::ApiGatewayV2::Api'] as const;
/** Fixed advanced-query SELECT per resource type. Property names follow the AWS Config resource schema for each type. */
const configSelect: Record<typeof configResourceTypes[number], string> = {
  'AWS::EC2::VPC': 'configuration.isDefault, tags',
  'AWS::EC2::Instance': 'configuration.instanceType, configuration.state.name, configuration.launchTime, tags',
  'AWS::EKS::Cluster': 'configuration.Version, configuration.ClusterStatus, tags',
  'AWS::RDS::DBInstance': 'configuration.engine, configuration.engineVersion, configuration.dBInstanceStatus, configuration.dBInstanceClass, tags',
  'AWS::MSK::Cluster': 'configuration.KafkaVersion, configuration.BrokerNodeGroupInfo.InstanceType, tags',
  'AWS::Lambda::Function': 'configuration.runtime, configuration.lastModified, tags',
  'AWS::DynamoDB::Table': 'configuration.tableStatus, tags',
  'AWS::ApiGateway::RestApi': 'configuration.createdDate, configuration.endpointConfiguration.types, tags',
  'AWS::ApiGatewayV2::Api': 'configuration.protocolType, configuration.createdDate, tags',
};
export const configExpression = (type: typeof configResourceTypes[number]) => `SELECT accountId, awsRegion, resourceId, resourceName, resourceType, ${configSelect[type]} WHERE resourceType = '${type}'`;
/** Resource types whose list APIs carry no tags; their tag keys come from the Resource Groups Tagging API. */
export const taggedResourceTypes = ['lambda:function', 'dynamodb:table', 'elasticache:cluster'] as const;
const guardDutyId = z.string().regex(/^[a-f0-9]{32}$/);
/** Internal only: an EKS name comes from this worker's own list-clusters result; the metric window end from its clock;
 * GuardDuty detector/finding IDs from its own list-detectors/list-findings results. */
export const readQuerySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('eks-cluster'), name: z.string().regex(/^[0-9A-Za-z][A-Za-z0-9_-]{0,99}$/) }).strict(),
  z.object({ kind: z.literal('metrics'), end: z.iso.datetime() }).strict(),
  z.object({ kind: z.literal('automation'), since: z.iso.datetime() }).strict(),
  z.object({ kind: z.literal('config'), resourceType: z.enum(configResourceTypes), nextToken: z.string().min(1).max(100000).optional() }).strict(),
  z.object({ kind: z.literal('guardduty-findings'), detectorId: guardDutyId }).strict(),
  z.object({ kind: z.literal('guardduty-details'), detectorId: guardDutyId, findingIds: z.array(guardDutyId).min(1).max(50) }).strict(),
  z.object({ kind: z.literal('tags'), resourceType: z.enum(taggedResourceTypes) }).strict(),
]);
export type ReadQuery = z.infer<typeof readQuerySchema>;
/** Internal only: values come from this worker's expiring directory grants. */
const directoryQuerySchema = z.object({ parentId: directoryParentId, nextToken: z.string().min(1).max(100000).optional() }).strict();
export type DirectoryQuery = z.infer<typeof directoryQuerySchema>;
export type CliIdentity = { accountId: string; arn: string; userId: string };
export type CliLoginState = {
  connectionId: string; jobId?: string;
  status: 'disconnected' | 'starting' | 'awaiting-user' | 'verifying' | 'connected' | 'denied' | 'expired' | 'failed' | 'cancelled';
  /** Product deadline; not an assertion of AWS device-code expiry. */
  deadline?: string; userCode?: string; verificationUri?: string; verificationUriComplete?: string;
  accountId: string; roleName: string; region: string;
  code?: string;
};
type CliResult = { stdout: string };
export interface CliRuntime {
  run(operation: CliOperation, signal: AbortSignal, output?: (chunk: string) => void, input?: DirectoryQuery | ReadQuery, target?: CliTarget): Promise<CliResult>;
}
export function cliFailure(code = 'cli_failed', status = 502) {
  return new CloudOperationError(status, code, 'The organization CLI operation could not be confirmed.');
}
export function assertCliOwner(context: VerifiedCloudContext, binding: CliBinding) {
  if (context.owner.kind !== 'organization' || context.owner.organizationId !== binding.organizationId
    || context.actorId !== binding.actorId || context.workspaceId !== binding.workspaceId || context.channel !== 'web'
    || !context.roles.some(role => ['viewer', 'operator', 'reviewer'].includes(role))) throw cliFailure('connection_unavailable', 403);
}
export function cliProfile(binding: CliBinding, accountId?: string) { return accountId && accountId !== binding.accountId ? `cloudops-${binding.connectionId}-a${accountId}` : `cloudops-${binding.connectionId}`; }
export function bindingDigest(binding: CliBinding) {
  // Schema order is fixed, independent of the original JSON field order.
  return createHash('sha256').update(JSON.stringify(cliBindingSchema.parse(binding))).digest('hex');
}
/** The same SSO session and role name; an extra profile per target account (Identity Center decides whether it is assigned). */
export function cliConfig(binding: CliBinding, accountId?: string) {
  const b = cliBindingSchema.parse(binding), profile = cliProfile(b), target = accountId === undefined ? undefined : cliTargetSchema.shape.accountId.parse(accountId);
  const section = (name: string, account: string) => `[profile ${name}]\nsso_session = ${profile}\nsso_account_id = ${account}\nsso_role_name = ${b.roleName}\nregion = ${b.region}\noutput = json\n`;
  return `[sso-session ${profile}]\nsso_start_url = ${b.startUrl}\nsso_region = ${b.ssoRegion}\nsso_registration_scopes = sso:account:access\n\n${section(profile, b.accountId)}${target && target !== b.accountId ? `\n${section(cliProfile(b, target), target)}` : ''}`;
}
/** Each caller gets fixed arguments; there is no generic command/endpoint/profile input. */
export function cliArguments(binding: CliBinding, operation: CliOperation, input?: DirectoryQuery | ReadQuery, inputTarget?: CliTarget): string[] {
  const target = inputTarget === undefined ? undefined : cliTargetSchema.parse(inputTarget);
  if (target && (operation.startsWith('directory-') || ['login', 'logout', 'config-query'].includes(operation))) throw cliFailure('invalid_read_query');
  const common = ['--profile', cliProfile(binding, target?.accountId), '--region', target?.region ?? binding.region, '--no-cli-pager', '--no-cli-auto-prompt', '--color', 'off'];
  if (operation.startsWith('directory-')) {
    const scope = directoryScopeSchema.parse(binding.directory);
    const query = directoryQuerySchema.parse(input ?? { parentId: scope.parentId });
    const parentId = query.parentId;
    const rootPart = (value: string) => value.startsWith('r-') ? value.slice(2) : value.split('-')[1];
    if (rootPart(parentId) !== rootPart(scope.parentId) || parentId.startsWith('r-') && parentId !== scope.parentId) throw cliFailure('directory_scope_mismatch', 403);
    if (query.nextToken && !['directory-accounts', 'directory-ous', 'directory-all-accounts'].includes(operation)) throw cliFailure('invalid_directory_query');
    const pageInput = ['--cli-input-json', JSON.stringify({ ParentId: parentId, MaxResults: 20, ...(query.nextToken ? { NextToken: query.nextToken } : {}) })];
    const end = ['--no-paginate', '--output', 'json', ...common];
    switch (operation) {
      case 'directory-organization': return ['organizations', 'describe-organization', '--query', 'Organization.{Id:Id,MasterAccountId:MasterAccountId}', ...end];
      case 'directory-parent': return parentId.startsWith('r-')
        ? ['organizations', 'list-roots', '--max-results', '20', '--query', '{Items:Roots[].{Id:Id,Name:Name,Arn:Arn},HasMore:NextToken != `null`}', ...end]
        : ['organizations', 'describe-organizational-unit', '--organizational-unit-id', parentId, '--query', '{Items:[OrganizationalUnit.{Id:Id,Name:Name,Arn:Arn}],HasMore:`false`}', ...end];
      case 'directory-accounts': return ['organizations', 'list-accounts-for-parent', ...pageInput, '--query', '{Items:Accounts[].{Id:Id,Name:Name,Arn:Arn,State:State},NextToken:NextToken,HasMore:NextToken != `null`}', ...end];
      case 'directory-ous': return ['organizations', 'list-organizational-units-for-parent', ...pageInput, '--query', '{Items:OrganizationalUnits[].{Id:Id,Name:Name,Arn:Arn},NextToken:NextToken,HasMore:NextToken != `null`}', ...end];
      case 'directory-all-accounts':
        // Whole-organization account list; only for a root scope (an OU scope is walked with directory-accounts/-ous).
        if (!parentId.startsWith('r-') || parentId !== scope.parentId) throw cliFailure('directory_scope_mismatch', 403);
        return ['organizations', 'list-accounts', '--cli-input-json', JSON.stringify({ MaxResults: 20, ...(query.nextToken ? { NextToken: query.nextToken } : {}) }), '--query', '{Items:Accounts[].{Id:Id,Name:Name,Arn:Arn,State:State},NextToken:NextToken,HasMore:NextToken != `null`}', ...end];
      case 'directory-ancestors':
        if (!parentId.startsWith('ou-')) throw cliFailure('invalid_directory_query');
        return ['organizations', 'list-parents', '--child-id', parentId, '--max-results', '20', '--query', '{Items:Parents[].{Id:Id,Type:Type},HasMore:NextToken != `null`}', ...end];
    }
  }
  const json = ['--output', 'json', ...common];
  // Findings are limited to the target account and region (a Security Hub/GuardDuty administrator or aggregation region also holds other accounts' and regions' findings).
  const scopeAccount = target?.accountId ?? binding.accountId, scopeRegion = target?.region ?? binding.region;
  const more = (token: string) => `length(${token} || \`""\`) > \`0\``;
  if (['eks-cluster', 'metrics', 'automation', 'config-query', 'guardduty-findings', 'guardduty-details', 'tagged-resources'].includes(operation)) {
    const parsed = readQuerySchema.safeParse(input); if (!parsed.success) throw cliFailure('invalid_read_query');
    const query = parsed.data;
    if (query.kind === 'eks-cluster' && operation === 'eks-cluster') return ['eks', 'describe-cluster', '--name', query.name, '--query', 'cluster.{name:name,state:status,version:version,type:platformVersion,modified:createdAt,tags:keys(tags || `{}`)}', ...json];
    if (query.kind === 'guardduty-findings' && operation === 'guardduty-findings') {
      return ['guardduty', 'list-findings', '--no-paginate', '--cli-input-json', JSON.stringify({ DetectorId: query.detectorId, MaxResults: 50,
        FindingCriteria: { Criterion: { severity: { GreaterThanOrEqual: 7 }, 'service.archived': { Equals: ['false'] }, accountId: { Equals: [scopeAccount] } } } }),
        '--query', `{Items:FindingIds,HasMore:${more('NextToken')}}`, ...json];
    }
    if (query.kind === 'guardduty-details' && operation === 'guardduty-details') {
      return ['guardduty', 'get-findings', '--cli-input-json', JSON.stringify({ DetectorId: query.detectorId, FindingIds: query.findingIds }),
        '--query', '{Items:Findings[].{id:Id,name:Title,value:Severity,type:Type,detail:Resource.ResourceType,modified:UpdatedAt},HasMore:`false`}', ...json];
    }
    if (query.kind === 'tags' && operation === 'tagged-resources') {
      return ['resourcegroupstaggingapi', 'get-resources', '--no-paginate', '--cli-input-json', JSON.stringify({ ResourceTypeFilters: [query.resourceType], ResourcesPerPage: 100 }),
        '--query', `{Items:ResourceTagMappingList[].{arn:ResourceARN,tags:Tags[].Key || \`[]\`},HasMore:${more('PaginationToken')}}`, ...json];
    }
    if (query.kind === 'metrics' && operation === 'metrics') {
      const end = Math.floor(Date.parse(query.end) / 60_000) * 60_000;
      const queries = metricQueries.map(metric => ({ Id: metric.id, Expression: `SEARCH('${metric.search}', '${metric.stat}', 300)`, Label: `\${PROP('Dim.${metric.dimension}')}`, ReturnData: true }));
      return ['cloudwatch', 'get-metric-data', '--no-paginate', '--cli-input-json', JSON.stringify({ MetricDataQueries: queries, StartTime: new Date(end - 3_600_000).toISOString(), EndTime: new Date(end).toISOString(), ScanBy: 'TimestampDescending' }),
        '--query', '{Items:MetricDataResults[].{id:Id,name:Label,latest:Values[0],max:max(Values),min:min(Values),sum:sum(Values)},HasMore:NextToken != `null`}', ...json];
    }
    if (query.kind === 'automation' && operation === 'automation') {
      return ['ssm', 'describe-automation-executions', '--no-paginate', '--cli-input-json', JSON.stringify({ MaxResults: 50, Filters: [{ Key: 'StartTimeAfter', Values: [query.since] }] }),
        '--query', '{Items:AutomationExecutionMetadataList[].{name:DocumentName,id:AutomationExecutionId,state:AutomationExecutionStatus,modified:ExecutionStartTime,detail:ExecutionEndTime},HasMore:NextToken != `null`}', ...json];
    }
    if (query.kind === 'config' && operation === 'config-query') {
      const config = binding.inventory?.config; if (!config) throw cliFailure('config_not_configured', 409);
      const aggregatorCommon = ['--profile', cliProfile(binding, config.accountId), '--region', config.region, '--no-cli-pager', '--no-cli-auto-prompt', '--color', 'off'];
      return ['configservice', 'select-aggregate-resource-config', '--configuration-aggregator-name', config.aggregator, '--expression', configExpression(query.resourceType), '--no-paginate',
        '--cli-input-json', JSON.stringify({ Limit: 100, ...(query.nextToken ? { NextToken: query.nextToken } : {}) }), '--query', '{Results:Results,NextToken:NextToken}', '--output', 'json', ...aggregatorCommon];
    }
    throw cliFailure('invalid_read_query');
  }
  if (input) throw cliFailure('invalid_directory_query');
  switch (operation) {
    case 'login': return ['sso', 'login', '--use-device-code', '--no-browser', ...common];
    case 'logout': return ['sso', 'logout', ...common];
    case 'identity': return ['sts', 'get-caller-identity', '--output', 'json', ...common];
    case 'lambda': return ['lambda', 'list-functions', '--no-paginate', '--cli-input-json', '{"MaxItems":50}', '--query', '{Items:Functions[].{name:FunctionName,runtime:Runtime,modified:LastModified},HasMore:NextMarker != `null`}', '--output', 'json', ...common];
    case 'dynamodb': return ['dynamodb', 'list-tables', '--no-paginate', '--limit', '100', '--query', '{Items:TableNames[].{name:@},HasMore:LastEvaluatedTableName != `null`}', '--output', 'json', ...common];
    case 'ec2': return ['ec2', 'describe-instances', '--no-paginate', '--cli-input-json', '{"MaxResults":100}', '--query', '{Items:Reservations[].Instances[].{id:InstanceId,name:(Tags[?Key==`Name`].Value | [0]) || InstanceId,state:State.Name,runtime:InstanceType,modified:LaunchTime,tags:Tags[].Key || `[]`}[],HasMore:NextToken != `null`}', '--output', 'json', ...common];
    case 'regions': return ['ec2', 'describe-regions', '--query', '{Items:Regions[].{name:RegionName,state:OptInStatus},HasMore:`false`}', ...json];
    case 'vpcs': return ['ec2', 'describe-vpcs', '--no-paginate', '--cli-input-json', '{"MaxResults":1000}', '--query', '{Total:length(Vpcs),Tagged:length(Vpcs[?length(Tags || `[]`) > `0`]),HasMore:NextToken != `null`}', ...json];
    case 'apigateway-rest': return ['apigateway', 'get-rest-apis', '--no-paginate', '--cli-input-json', '{"limit":100}', '--query', '{Items:items[].{name:name,id:id,type:`"REST"`,version:endpointConfiguration.types[0],modified:createdDate,tags:keys(tags || `{}`)},HasMore:position != `null`}', ...json];
    case 'apigateway-http': return ['apigatewayv2', 'get-apis', '--no-paginate', '--cli-input-json', '{"MaxResults":"100"}', '--query', '{Items:Items[].{name:Name,id:ApiId,type:ProtocolType,modified:CreatedDate,tags:keys(Tags || `{}`)},HasMore:NextToken != `null`}', ...json];
    case 'ssm': return ['ssm', 'describe-instance-information', '--no-paginate', '--cli-input-json', '{"MaxResults":50}', '--query', '{Items:InstanceInformationList[].{name:ComputerName || InstanceId,id:InstanceId,state:PingStatus,type:PlatformType,version:PlatformName,detail:PlatformVersion,runtime:AgentVersion,modified:LastPingDateTime},HasMore:NextToken != `null`}', ...json];
    case 'patch': return ['ssm', 'list-resource-compliance-summaries', '--no-paginate', '--cli-input-json', '{"MaxResults":50,"Filters":[{"Key":"ComplianceType","Values":["Patch"],"Type":"EQUAL"}]}', '--query', '{Items:ResourceComplianceSummaryItems[].{name:ResourceId,id:ResourceId,state:Status,detail:OverallSeverity,type:ResourceType},HasMore:NextToken != `null`}', ...json];
    case 'eks': return ['eks', 'list-clusters', '--no-paginate', '--cli-input-json', '{"maxResults":100}', '--query', '{Items:clusters[].{name:@},HasMore:nextToken != `null`}', ...json];
    case 'eks-versions': return ['eks', 'describe-cluster-versions', '--include-all', '--no-paginate', '--query', '{Items:clusterVersions[].{name:clusterVersion,state:versionStatus,modified:endOfStandardSupportDate,detail:endOfExtendedSupportDate},HasMore:nextToken != `null`}', ...json];
    // Engine lifecycle (standard/extended support dates) for MySQL, PostgreSQL, Aurora and MariaDB.
    case 'rds-lifecycle': return ['rds', 'describe-db-major-engine-versions', '--no-paginate', '--cli-input-json', '{"MaxRecords":100}', '--query', '{Items:DBMajorEngineVersions[].{engine:Engine,major:MajorEngineVersion,lifecycles:SupportedEngineLifecycles[].{name:LifecycleSupportName,start:LifecycleSupportStartDate,end:LifecycleSupportEndDate}},HasMore:Marker != `null`}', ...json];
    case 'kafka-versions': return ['kafka', 'list-kafka-versions', '--no-paginate', '--cli-input-json', '{"MaxResults":100}', '--query', '{Items:KafkaVersions[].{name:Version,state:Status},HasMore:NextToken != `null`}', ...json];
    case 'rds': return ['rds', 'describe-db-instances', '--no-paginate', '--cli-input-json', '{"MaxRecords":100}', '--query', "{Items:DBInstances[].{name:DBInstanceIdentifier,state:DBInstanceStatus,type:DBInstanceClass,version:join(' ', [Engine, EngineVersion]),modified:InstanceCreateTime,tags:TagList[].Key || `[]`},HasMore:Marker != `null`}", ...json];
    case 'elasticache': return ['elasticache', 'describe-cache-clusters', '--no-paginate', '--cli-input-json', '{"MaxRecords":100}', '--query', "{Items:CacheClusters[].{name:CacheClusterId,state:CacheClusterStatus,type:CacheNodeType,version:join(' ', [Engine, EngineVersion]),modified:CacheClusterCreateTime},HasMore:Marker != `null`}", ...json];
    case 'msk': return ['kafka', 'list-clusters-v2', '--no-paginate', '--cli-input-json', '{"MaxResults":100}', '--query', '{Items:ClusterInfoList[].{name:ClusterName,state:State,type:Provisioned.BrokerNodeGroupInfo.InstanceType || ClusterType,version:Provisioned.CurrentBrokerSoftwareInfo.KafkaVersion,modified:CreationTime,tags:keys(Tags || `{}`)},HasMore:NextToken != `null`}', ...json];
    // Active, unresolved CRITICAL/HIGH findings of this account and region (Security Hub's own and integrated products).
    case 'securityhub': return ['securityhub', 'get-findings', '--no-paginate', '--cli-input-json', JSON.stringify({ MaxResults: 100, SortCriteria: [{ Field: 'SeverityNormalized', SortOrder: 'desc' }], Filters: {
      AwsAccountId: [{ Value: scopeAccount, Comparison: 'EQUALS' }], Region: [{ Value: scopeRegion, Comparison: 'EQUALS' }], RecordState: [{ Value: 'ACTIVE', Comparison: 'EQUALS' }],
      WorkflowStatus: [{ Value: 'NEW', Comparison: 'EQUALS' }, { Value: 'NOTIFIED', Comparison: 'EQUALS' }], SeverityLabel: [{ Value: 'CRITICAL', Comparison: 'EQUALS' }, { Value: 'HIGH', Comparison: 'EQUALS' }] } }),
      '--query', `{Items:Findings[].{name:Title,state:Severity.Label,type:ProductName,detail:Resources[0].Type,version:Compliance.SecurityControlId,modified:UpdatedAt},HasMore:${more('NextToken')}}`, ...json];
    case 'guardduty-detectors': return ['guardduty', 'list-detectors', '--no-paginate', '--cli-input-json', '{"MaxResults":50}', '--query', `{Items:DetectorIds,HasMore:${more('NextToken')}}`, ...json];
    // AWS Health is a global API served from us-east-1; it needs a Business, Enterprise On-Ramp or Enterprise support plan.
    case 'health': return ['health', 'describe-events', '--no-paginate', '--cli-input-json', JSON.stringify({ maxResults: 100, filter: { eventStatusCodes: ['open', 'upcoming'], eventTypeCategories: ['issue', 'scheduledChange', 'accountNotification'] } }),
      '--query', `{Items:events[].{name:eventTypeCode,type:service,state:statusCode,version:eventTypeCategory,detail:region,modified:startTime},HasMore:${more('nextToken')}}`,
      '--output', 'json', '--profile', cliProfile(binding, target?.accountId), '--region', 'us-east-1', '--no-cli-pager', '--no-cli-auto-prompt', '--color', 'off'];
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
  feed(chunk: string): { userCode: string; verificationUri: string; verificationUriComplete?: string } | undefined {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > 32_768) throw cliFailure('login_output_limit');
    // stdout/stderr chunks may split inside a URL or code; parse completed lines only.
    const complete = this.buffer.slice(0, this.buffer.lastIndexOf('\n') + 1);
    const urls = complete.match(/https:\/\/[^\s<>"']+/g) ?? [];
    const userCode = complete.match(/Then enter the code:\s*\r?\n\s*([A-Z0-9]{4}-[A-Z0-9]{4})(?:\s|$)/)?.[1];
    let verificationUri: string | undefined, verificationUriComplete: string | undefined;
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
        // The code-carrying link lets the user skip typing; the code stays visible for comparison.
        verificationUriComplete ??= url.href;
      } else verificationUri ??= url.href;
    }
    return verificationUri && userCode ? { verificationUri, userCode, ...(verificationUriComplete ? { verificationUriComplete } : {}) } : undefined;
  }
}
