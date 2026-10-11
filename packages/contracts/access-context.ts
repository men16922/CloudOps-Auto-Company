import { z } from 'zod';

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
const boundedText = (max = 2000) => z.string().min(1).max(max);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const date = z.iso.datetime();
const region = z.string().regex(/^[a-z][a-z0-9-]{1,62}$/);
export const cloudProviders = ['aws', 'gcp', 'azure', 'onprem'] as const;
export const providerSchema = z.enum(cloudProviders);
export const ownerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('personal'), userId: id }).strict(),
  z.object({ kind: z.literal('organization'), organizationId: id }).strict(),
]);
export type CloudOwner = z.infer<typeof ownerSchema>;

export const awsTargetSchema = z.object({
  provider: z.literal('aws'), accountId: z.string().regex(/^\d{12}$/),
  partition: z.enum(['aws', 'aws-us-gov', 'aws-cn']),
  scope: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('regional'), region }).strict(),
    z.object({ kind: z.literal('global') }).strict(),
  ]),
  service: z.enum(['lambda', 'dynamodb', 's3', 'alarms', 'ec2', 'rds', 'ssm']),
  resourceId: id, nativeId: boundedText(512), resourceUid: boundedText(512).optional(),
}).strict();
const gcpTargetSchema = z.object({
  provider: z.literal('gcp'), projectId: z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/),
  location: region, resourceId: id, resourceName: boundedText(512), resourceUid: id, revision: id,
}).strict();
const azureTargetSchema = z.object({
  provider: z.literal('azure'), tenantId: z.uuid(), subscriptionId: z.uuid(), resourceGroup: id,
  location: region.optional(), resourceId: id, armResourceId: boundedText(1024),
}).strict();
const onpremTargetSchema = z.object({
  provider: z.literal('onprem'), siteId: id, connectorId: id, platform: z.literal('docker'),
  engineId: id, resourceId: id, containerId: z.string().regex(/^[a-f0-9]{64}$/), name: id,
}).strict();
export const targetSchema = z.discriminatedUnion('provider', [awsTargetSchema, gcpTargetSchema, azureTargetSchema, onpremTargetSchema]).superRefine((target, ctx) => {
  if (target.provider === 'gcp' && !target.resourceName.startsWith(`projects/${target.projectId}/locations/${target.location}/services/`)) {
    ctx.addIssue({ code: 'custom', message: 'Resource name does not match the GCP project/location.', path: ['resourceName'] });
  }
  if (target.provider === 'azure' && !target.armResourceId.toLowerCase().startsWith(`/subscriptions/${target.subscriptionId}/resourcegroups/${target.resourceGroup}/providers/`.toLowerCase())) {
    ctx.addIssue({ code: 'custom', message: 'Resource ID does not match the Azure subscription/group.', path: ['armResourceId'] });
  }
});
export type CloudTarget = z.infer<typeof targetSchema>;
export type AwsTarget = z.infer<typeof awsTargetSchema>;
const bindingShape = { owner: ownerSchema, workspaceId: id, environmentId: id, target: targetSchema };
export const bindingSchema = z.object(bindingShape).strict();
export type CloudBinding = z.infer<typeof bindingSchema>;

export const observationSchema = z.object({
  id, source: boundedText(200), quality: z.enum(['complete', 'partial', 'missing', 'unknown', 'denied']),
  value: z.json(), label: boundedText(200).optional(), observedAt: date.optional(), limitation: boundedText().optional(),
}).strict();
export const evidenceSchema = z.object({
  schemaVersion: z.literal(1), id, dataMode: z.enum(['synthetic', 'live']), ...bindingShape,
  observedAt: date,
  window: z.object({ start: date, end: date }).strict().refine(value => Date.parse(value.start) < Date.parse(value.end), 'Invalid observation window.').optional(),
  observations: z.array(observationSchema).min(1).max(100), notice: boundedText().optional(),
}).strict().refine(value => new Set(value.observations.map(item => item.id)).size === value.observations.length, 'Evidence IDs must be unique.');
export type CloudEvidence = z.infer<typeof evidenceSchema>;

const completion = { version: z.literal(1), effect: z.literal('read'), completionCriteria: z.array(boundedText(500)).min(1).max(10) };
export const actionSchema = z.discriminatedUnion('id', [
  z.object({ id: z.literal('gcp.cloudrun.metadata.inspect.v1'), ...completion, inputs: z.object({}).strict() }).strict(),
  z.object({ id: z.literal('gcp.cloudrun.inspect.v1'), ...completion, inputs: z.object({ windowMinutes: z.union([z.literal(15), z.literal(60)]), maxLogEntries: z.number().int().min(1).max(100) }).strict() }).strict(),
  z.object({ id: z.literal('aws.dynamodb.recovery.inspect.v1'), ...completion, inputs: z.object({}).strict() }).strict(),
  z.object({ id: z.literal('aws.s3.versioning.inspect.v1'), ...completion, inputs: z.object({}).strict() }).strict(),
  z.object({ id: z.literal('aws.lambda.inspect.v1'), ...completion, inputs: z.object({ windowHours: z.union([z.literal(1), z.literal(24)]) }).strict() }).strict(),
  z.object({ id: z.literal('azure.vm.inspect.v1'), ...completion, inputs: z.object({ windowMinutes: z.union([z.literal(15), z.literal(60)]) }).strict() }).strict(),
  z.object({ id: z.literal('onprem.docker.inspect.v1'), ...completion, inputs: z.object({}).strict() }).strict(),
]);
export const planPayloadSchema = z.object({
  schemaVersion: z.literal(1), planId: id, version: z.number().int().positive(), dataMode: z.enum(['synthetic', 'live']), ...bindingShape,
  evidence: z.object({ snapshotId: id, digest, sourceIds: z.array(id).min(1).max(100), observedAt: date }).strict(),
  analysis: z.object({
    engine: z.enum(['synthetic-fixture', 'gemini', 'fixed-rules']), summary: boundedText(4000),
    findings: z.array(z.object({ statement: boundedText(), evidenceIds: z.array(id).min(1).max(100), kind: z.enum(['observation', 'hypothesis']) }).strict()).max(30),
    missingInformation: z.array(boundedText()).max(30), serviceAssessment: z.enum(['healthy', 'degraded', 'unknown']),
    modelId: boundedText(200).optional(), promptVersion: id.optional(), ruleVersion: id.optional(),
  }).strict(),
  action: actionSchema, createdAt: date, expiresAt: date,
}).strict().superRefine((plan, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (plan.analysis.engine === 'fixed-rules' ? !plan.analysis.ruleVersion || plan.analysis.modelId !== undefined || plan.analysis.promptVersion !== undefined : plan.analysis.ruleVersion !== undefined) fail('Fixed-rule provenance must be separate from model provenance.');
  if (plan.action.id.split('.')[0] !== plan.target.provider) fail('Action provider does not match the target.');
  if (plan.target.provider === 'aws' && plan.action.id.split('.')[1] !== plan.target.service) fail('Action service does not match the AWS target.');
  const sources = new Set(plan.evidence.sourceIds);
  if (sources.size !== plan.evidence.sourceIds.length) fail('Pinned evidence IDs must be unique.');
  if (plan.analysis.findings.some(item => item.evidenceIds.some(source => !sources.has(source)))) fail('Analysis cites evidence outside the pinned snapshot.');
  const created = Date.parse(plan.createdAt), expires = Date.parse(plan.expiresAt), observed = Date.parse(plan.evidence.observedAt);
  if (expires <= created || expires - created > 600_000) fail('Plan lifetime must be between zero and ten minutes.');
  if (observed > created || created - observed > 900_000) fail('Evidence is future-dated or older than fifteen minutes.');
});
export type CloudPlanPayload = z.infer<typeof planPayloadSchema>;

// Registration in a schema is not an implemented/live provider capability.
export const providerDefinitions = [
  { id: 'aws', label: 'AWS', mobile: false, implementation: 'local-read-and-backup' },
  { id: 'gcp', label: 'Google Cloud', mobile: true, implementation: 'planned' },
  { id: 'azure', label: 'Azure', mobile: false, implementation: 'planned' },
  { id: 'onprem', label: 'On-premises', mobile: false, implementation: 'planned' },
] as const;

export const prepareCloudPlanSchema = z.object({ evidenceId: id, objective: boundedText() }).strict();
export const cloudPlanVersionSchema = z.object({ expectedVersion: z.number().int().positive(), expectedDigest: digest }).strict();
export const cloudDecisionSchema = cloudPlanVersionSchema.extend({ decision: z.enum(['approve', 'reject', 'request_changes']), note: z.string().max(2000) }).strict();
export const cloudExecutionSchema = cloudPlanVersionSchema.extend({ planId: id }).strict();

/** Only an identity adapter may construct this context; never deserialize it from a client body. */
export type VerifiedCloudContext = {
  actorId: string; owner: CloudOwner; workspaceId: string; channel: 'web' | 'mobile';
  roles: readonly ('viewer' | 'operator' | 'reviewer')[];
};
export class CloudAccessError extends Error {
  readonly status = 403;
  constructor() { super('This operation is not available in the current scope.'); }
}
export function sameOwner(a: CloudOwner, b: CloudOwner): boolean {
  return a.kind === 'personal' ? b.kind === 'personal' && a.userId === b.userId : b.kind === 'organization' && a.organizationId === b.organizationId;
}
export function assertCloudAccess(context: VerifiedCloudContext, binding: CloudBinding, action: 'read' | 'prepare' | 'decide' | 'execute' | 'handoff' = 'read'): void {
  const personalIdentityMatches = context.owner.kind !== 'personal' || context.owner.userId === context.actorId;
  const requiredRole = action === 'decide' ? 'reviewer' : action === 'read' ? undefined : 'operator';
  if (!personalIdentityMatches || !sameOwner(context.owner, binding.owner) || context.workspaceId !== binding.workspaceId
    || (context.channel === 'mobile' && binding.target.provider !== 'gcp')
    || !context.roles.some(role => ['viewer', 'operator', 'reviewer'].includes(role))
    || (requiredRole && !context.roles.includes(requiredRole))) throw new CloudAccessError();
}
