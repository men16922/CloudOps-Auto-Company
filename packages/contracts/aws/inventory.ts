import { z } from 'zod';
import { connectionItemSchema, connectionServices } from './connections';
import { accountLifecycleSchema } from './directory';

const account = z.string().regex(/^\d{12}$/), region = z.string().regex(/^[a-z]{2}(?:-[a-z]+)+-\d$/), code = z.string().regex(/^[a-z_]{1,64}$/);
/** One fixed read of one service in one account and region. `code` marks a read that failed for that unit only. */
export const inventoryUnitSchema = z.object({ accountId: account, region, service: z.enum(connectionServices), collectedAt: z.iso.datetime(), hasMore: z.boolean(),
  items: z.array(connectionItemSchema).max(100), source: z.enum(['direct', 'config']), code: code.optional() }).strict();
/** A region counts as in use only when it has at least one VPC carrying a tag (enabled but unused regions are excluded). */
export const accountRegionSchema = z.object({ region, vpcs: z.number().int().min(0).max(5000), taggedVpcs: z.number().int().min(0).max(5000) }).strict();
export const syncAccountSchema = z.object({ accountId: account, name: z.string().min(1).max(128).optional(), lifecycle: accountLifecycleSchema.optional(),
  access: z.enum(['pending', 'verified', 'denied', 'failed']), code: code.optional(), regions: z.array(accountRegionSchema).max(40), candidateRegions: z.number().int().min(0).max(40) }).strict();
export const syncUnitRefSchema = z.object({ id: z.uuid(), accountId: account, region, service: z.enum(connectionServices), count: z.number().int().min(0).max(100), code: code.optional() }).strict();
export const syncJobSchema = z.object({ connectionId: z.uuid(), jobId: z.uuid(), mode: z.enum(['direct', 'config']), state: z.enum(['running', 'completed', 'partial', 'failed', 'cancelled', 'expired']),
  startedAt: z.iso.datetime(), finishedAt: z.iso.datetime().optional(), progress: z.object({ done: z.number().int().min(0), total: z.number().int().min(0) }).strict(),
  accounts: z.array(syncAccountSchema).max(200), units: z.array(syncUnitRefSchema).max(6000), code: code.optional() }).strict();
/** Browser view of the last sync (no unit contents): from the host's disk cache or a live worker job. */
export const syncSummarySchema = syncJobSchema.omit({ units: true }).extend({ cachedUnits: z.number().int().min(0), remaining: z.number().int().min(0).optional(), live: z.boolean() }).strict();
export const inventoryResponseSchema = z.object({ service: z.union([z.enum(connectionServices), z.literal('all')]), units: z.array(inventoryUnitSchema).max(6000), truncated: z.boolean() }).strict();
export type InventoryUnit = z.infer<typeof inventoryUnitSchema>;
export type SyncAccount = z.infer<typeof syncAccountSchema>;
export type SyncJob = z.infer<typeof syncJobSchema>;
export type SyncSummary = z.infer<typeof syncSummarySchema>;
/** Unit codes that describe the service's state in that account/region rather than a failed read. */
export const serviceStateCodes: ReadonlySet<string> = new Set(['read_not_enabled', 'read_not_subscribed']);
export const inUse = (value: z.infer<typeof accountRegionSchema>) => value.taggedVpcs > 0;
