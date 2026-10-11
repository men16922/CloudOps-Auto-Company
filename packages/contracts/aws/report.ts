import { z } from 'zod';

const account = z.string().regex(/^\d{12}$/);
/** One finding as recorded at the end of a sync (no console link; the browser re-derives labels). */
const snapshotFindingSchema = z.object({
  id: z.string().min(1).max(400), severity: z.enum(['critical', 'warning', 'info']), kind: z.string().regex(/^[a-z-]{1,32}$/), subject: z.string().max(300), detail: z.string().max(300),
  source: z.string().regex(/^[a-z]{1,32}$/), accountId: account.optional(), region: z.string().regex(/^[a-z0-9-]{1,32}$/).optional(), value: z.number().finite().optional(),
  metric: z.string().regex(/^[a-z0-9_]{1,32}$/).optional(),
  eos: z.object({ component: z.string().max(32), status: z.string().max(16), current: z.string().max(128), date: z.string().max(32).optional(), daysLeft: z.number().int().optional() }).strict().optional(),
}).strict();
/** Assessment of one finished sync, kept in the host's disk cache to show trends. `verified` lists accounts whose access was confirmed. */
export const reportSnapshotSchema = z.object({
  jobId: z.uuid(), at: z.iso.datetime(), state: z.enum(['completed', 'partial']), mode: z.enum(['direct', 'config']),
  verified: z.array(account).max(200), accounts: z.number().int().min(0).max(200),
  counts: z.object({ critical: z.number().int().min(0), warning: z.number().int().min(0), info: z.number().int().min(0) }).strict(),
  findings: z.array(snapshotFindingSchema).max(1500), truncated: z.boolean(),
}).strict();
export const reportResponseSchema = z.object({ snapshots: z.array(reportSnapshotSchema).max(60) }).strict();
export type SnapshotFinding = z.infer<typeof snapshotFindingSchema>;
export type ReportSnapshot = z.infer<typeof reportSnapshotSchema>;
