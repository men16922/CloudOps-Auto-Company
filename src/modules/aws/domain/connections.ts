import { z } from 'zod';
import { directoryScopeSchema, directorySnapshotSchema } from './directory';
// Shape check only; the full sync summary is validated with syncSummarySchema (inventory.ts) by the client.
const syncSummaryShape = z.object({ jobId: z.uuid() }).passthrough();
const account = z.string().regex(/^\d{12}$/), role = z.string().min(1).max(128), region = z.string().regex(/^[a-z]{2}(?:-[a-z]+)+-\d$/);
/** AWS tag key (case-sensitive). Required keys are server-configured and never use the reserved `aws:` prefix. */
export const tagKeySchema = z.string().regex(/^[\p{L}\p{Z}\p{N}_.:/=+\-@]{1,128}$/u);
export const requiredTagsSchema = z.array(tagKeySchema.refine(value => !value.toLowerCase().startsWith('aws:'))).min(1).max(10);
export const connectionViewSchema = z.object({ id: z.uuid(), configurationId: z.string().min(1).max(64), accountId: account, roleName: role, region, createdAt: z.iso.datetime(), directory: directoryScopeSchema.optional(), startUrl: z.url().optional(),
  requiredTags: requiredTagsSchema.optional() }).strict();
export const connectionListSchema = z.object({ items: z.array(connectionViewSchema).max(20), configurations: z.array(z.object({ id: z.string().min(1).max(64), label: z.string().max(128), accountId: account, roleName: role, region, directory: directoryScopeSchema.optional() }).strict()).max(1000) }).strict();
export const connectionStateSchema = z.object({ connectionId: z.uuid(), jobId: z.uuid().optional(), status: z.enum(['disconnected', 'starting', 'awaiting-user', 'verifying', 'connected', 'denied', 'expired', 'failed', 'cancelled']), deadline: z.iso.datetime().optional(), accountId: account, roleName: role, region, code: z.string().regex(/^[a-z_]{1,64}$/).optional(), userCode: z.string().regex(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/).optional(), verificationUri: z.url().optional(), verificationUriComplete: z.url().optional() }).strict();
/** Fixed read services (server-defined CLI commands only). Order is the dashboard refresh order. */
export const connectionServices = ['alarms', 'metrics', 'ec2', 'eks', 'rds', 'elasticache', 'msk', 'lambda', 'dynamodb', 'apigateway', 'ssm', 'automation', 'patch', 'securityhub', 'guardduty', 'health'] as const;
/** Fixed CloudWatch standard-metric searches; values are the last hour at 5-minute periods. */
export const connectionMetricIds = ['ec2_cpu', 'ec2_status', 'rds_cpu', 'rds_storage', 'cache_cpu', 'cache_memory', 'msk_cpu', 'msk_disk', 'lambda_errors'] as const;
export const connectionItemSchema = z.object({ id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/).optional(), detail: z.string().max(200).optional(), name: z.string().max(1024), runtime: z.string().max(100).nullable().optional(), modified: z.string().max(100).optional(),
  state: z.string().max(100).optional(), type: z.string().max(100).optional(), version: z.string().max(100).optional(), support: z.enum(['STANDARD_SUPPORT', 'EXTENDED_SUPPORT', 'UNSUPPORTED', 'DEPRECATED']).optional(),
  /** End of the current support phase from an AWS API (EKS, RDS), ISO date-time. */
  eos: z.string().max(40).optional(),
  /** Tag keys present on the resource (absent = tags not collected, never "untagged"). EC2 allows any characters, so only the length is checked. */
  tags: z.array(z.string().min(1).max(128)).max(80).optional(),
  metric: z.enum(connectionMetricIds).optional(), value: z.number().finite().optional(), peak: z.number().finite().optional() }).strict();
export const connectionPageSchema = z.object({ connectionId: z.uuid(), accountId: account, region, operation: z.enum(connectionServices), collectedAt: z.iso.datetime(), items: z.array(connectionItemSchema).max(100), hasMore: z.boolean() }).strict();
/** Last cached read results for one owned connection (served by the host from its local cache). */
export const connectionObservationsSchema = z.object({ savedAt: z.iso.datetime().optional(), directory: directorySnapshotSchema.optional(), sync: syncSummaryShape.optional(),
  inventories: z.object(Object.fromEntries(connectionServices.map(service => [service, connectionPageSchema.optional()])) as Record<typeof connectionServices[number], z.ZodOptional<typeof connectionPageSchema>>).strict() }).strict();
export type ConnectionObservations = z.infer<typeof connectionObservationsSchema>;
export type ConnectionView = z.infer<typeof connectionViewSchema>;
export type ConnectionList = z.infer<typeof connectionListSchema>;
export type ConnectionState = z.infer<typeof connectionStateSchema>;
export type ConnectionPage = z.infer<typeof connectionPageSchema>;
export type ConnectionCommand = { operation: 'login' | 'verify' | 'inspect' | 'directory' | 'disconnect' | 'logout' | 'sync'; service?: ConnectionPage['operation']; cursor?: string };

/** A device link is either the code-free page or the same page carrying exactly this user code. */
export function checkedDeviceLink(value: string, userCode: string | undefined, portalHost: (host: string) => boolean, complete: boolean) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.port || url.username || url.password) return false;
  const device = /^device\.sso\.[a-z0-9-]+\.amazonaws\.com$/.test(url.hostname) && url.pathname === '/';
  const portal = portalHost(url.hostname) && /^\/start\/?$/.test(url.pathname);
  if (!complete) return (device && !url.search && !url.hash) || (portal && !url.search && (!url.hash || url.hash === '#/device'));
  if (!userCode) return false;
  if (device) return !url.hash && url.search === `?user_code=${userCode}`;
  return portal && !url.search && url.hash === `#/device?user_code=${userCode}`;
}
