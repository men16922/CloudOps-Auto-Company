import { z } from 'zod';

const account = z.string().regex(/^\d{12}$/), region = z.string().regex(/^[a-z]{2}(?:-[a-z]+)+-\d$/);
/** Fixed catalog of runbooks this product can start. Documents and parameters are never taken from a request. */
export const runbookCatalog = {
  'connectivity-check': { document: 'CloudOps-ConnectivityCheck', target: 'none' },
  'ec2-start': { document: 'AWS-StartEC2Instance', target: 'ec2-instance' },
  'ec2-restart': { document: 'AWS-RestartEC2Instance', target: 'ec2-instance' },
  'ec2-stop': { document: 'AWS-StopEC2Instance', target: 'ec2-instance' },
} as const;
export type RunbookId = keyof typeof runbookCatalog;
export const runbookIdSchema = z.enum(Object.keys(runbookCatalog) as [RunbookId, ...RunbookId[]]);
/** `instanceId` is required exactly for EC2 runbooks; the host checks it against the requester's synced inventory. */
export const runbookTargetSchema = z.object({ accountId: account, region, instanceId: z.string().regex(/^i-[a-f0-9]{8,17}$/).optional(), name: z.string().max(256).optional() }).strict();
export const executionIdSchema = z.string().regex(/^[a-f0-9-]{36}$/);
/** Automation execution as read back from SSM (status is AWS's AutomationExecutionStatus). */
export const runbookExecutionSchema = z.object({
  executionId: executionIdSchema, status: z.string().regex(/^[A-Za-z]{1,40}$/), startedAt: z.iso.datetime().optional(), endedAt: z.iso.datetime().optional(),
  failure: z.string().max(300).optional(),
}).strict();
export const runbookStates = ['pending', 'approved', 'rejected', 'cancelled', 'starting', 'running', 'succeeded', 'failed', 'unknown'] as const;
const person = z.object({ self: z.boolean(), label: z.string().max(64) }).strict();
export const runbookRequestViewSchema = z.object({
  id: z.uuid(), runbook: runbookIdSchema, target: runbookTargetSchema, reason: z.string().max(500), changeRef: z.string().max(64).optional(),
  requester: person, createdAt: z.iso.datetime(), state: z.enum(runbookStates),
  decision: z.object({ by: person, at: z.iso.datetime(), approved: z.boolean(), note: z.string().max(300).optional() }).strict().optional(),
  execution: runbookExecutionSchema.partial({ status: true }).extend({ executionId: executionIdSchema.optional() }).optional(),
  events: z.array(z.object({ at: z.iso.datetime(), action: z.string().regex(/^[a-z-]{1,32}$/), by: person, note: z.string().max(300).optional() }).strict()).max(50),
}).strict();
/** What the browser sees for one connection: whether runbooks are configured, what this member may do, and the team queue. */
export const runbookStateSchema = z.object({
  enabled: z.boolean(), allowed: z.array(runbookIdSchema).max(10), canRequest: z.boolean(), canApprove: z.boolean(), selfApproval: z.boolean(),
  requests: z.array(runbookRequestViewSchema).max(100),
}).strict();
const text = (max: number) => z.string().trim().min(1).max(max).regex(/^[^\u0000-\u001f]*$/);
export const runbookCommandSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('request'), runbook: runbookIdSchema, target: runbookTargetSchema, reason: text(500).refine(value => value.length >= 5), changeRef: text(64).optional() }).strict(),
  z.object({ operation: z.enum(['approve', 'reject']), requestId: z.uuid(), note: text(300).optional() }).strict(),
  z.object({ operation: z.enum(['execute', 'cancel', 'refresh']), requestId: z.uuid() }).strict(),
]);
export type RunbookTarget = z.infer<typeof runbookTargetSchema>;
export type RunbookExecution = z.infer<typeof runbookExecutionSchema>;
export type RunbookRequestView = z.infer<typeof runbookRequestViewSchema>;
export type RunbookState = z.infer<typeof runbookStateSchema>;
export type RunbookCommand = z.infer<typeof runbookCommandSchema>;
