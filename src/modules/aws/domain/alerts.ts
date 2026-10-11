import { z } from 'zod';

/** One alert delivery attempt as shown to the connection owner (no addresses, no server replies). */
export const alertEventSchema = z.object({
  at: z.iso.datetime(), kind: z.enum(['baseline', 'digest', 'test']), outcome: z.enum(['sent', 'failed', 'deferred']),
  count: z.number().int().min(0), code: z.string().regex(/^[a-z_]{1,64}$/).optional(),
}).strict();
/** E-mail alert status for one connection. Recipients are masked; the server configuration decides who receives what. */
export const alertStatusSchema = z.object({
  configured: z.boolean(), recipients: z.array(z.string().max(80)).max(10),
  minSeverity: z.enum(['critical', 'warning']).optional(), detail: z.enum(['full', 'summary']).optional(),
  history: z.array(alertEventSchema).max(20),
}).strict();
export type AlertEvent = z.infer<typeof alertEventSchema>;
export type AlertStatus = z.infer<typeof alertStatusSchema>;
