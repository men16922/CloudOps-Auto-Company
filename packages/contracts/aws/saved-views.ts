import { z } from 'zod';

const account = z.string().regex(/^\d{12}$/), region = z.string().regex(/^[a-z]{2}(?:-[a-z]+)+-\d$/);
/** Pages of the organization AWS dashboard a saved view can open. */
const dashboardPages = ['overview', 'report', 'ec2', 'eks', 'rds', 'elasticache', 'msk', 'serverless', 'ssm', 'lifecycle', 'alarms', 'metrics', 'security', 'tags', 'health', 'accounts'] as const;
const tokenSchema = z.object({ propertyKey: z.string().regex(/^[a-z][a-z0-9]{0,31}$/).optional(), operator: z.enum(['=', '!=', ':', '!:']), value: z.string().max(128) }).strict();
/** Search conditions of one table (PropertyFilter query without free-form extras). */
const savedQuerySchema = z.object({ operation: z.enum(['and', 'or']), tokens: z.array(tokenSchema).max(10) }).strict();
/** Table ids are `<page>.<table>` so a view only stores the conditions of the page it opens. */
const tableIdSchema = z.string().regex(/^[a-z][a-z0-9]{1,15}\.[a-z][a-z0-9]{1,15}$/);
/** What a user saves: the page (and tab), the account/region scope and the tables' search conditions. Values are user settings, not observations. */
const savedViewInputSchema = z.object({
  name: z.string().trim().min(1).max(60), page: z.enum(dashboardPages), tab: z.string().regex(/^[a-z][a-z0-9]{0,31}$/).optional(),
  accounts: z.array(account).max(200), regions: z.array(region).max(40),
  queries: z.record(tableIdSchema, savedQuerySchema).refine(value => Object.keys(value).length <= 6),
}).strict().refine(value => JSON.stringify(value).length <= 6_000 && Object.keys(value.queries).every(id => id.startsWith(`${value.page}.`)));
export const savedViewSchema = z.object({ id: z.uuid(), updatedAt: z.iso.datetime(), view: savedViewInputSchema }).strict();
export const savedViewListSchema = z.object({ items: z.array(savedViewSchema).max(30) }).strict();
/** Browser request: upsert by name, or delete by id. */
export const savedViewCommandSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('save'), view: savedViewInputSchema }).strict(),
  z.object({ operation: z.literal('delete'), id: z.uuid() }).strict(),
]);
export type SavedViewInput = z.infer<typeof savedViewInputSchema>;
export type SavedView = z.infer<typeof savedViewSchema>;
export type SavedQuery = z.infer<typeof savedQuerySchema>;
