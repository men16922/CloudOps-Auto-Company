import { z } from 'zod';

export const awsOrganizationId = z.string().regex(/^o-[a-z0-9]{10,32}$/);
export const directoryParentId = z.string().regex(/^(?:r-[a-z0-9]{4,32}|ou-[a-z0-9]{4,32}-[a-z0-9]{8,32})$/);
/** Trusted server configuration. A root/OU is a read scope, never an access grant. */
export const directoryScopeSchema = z.object({ awsOrganizationId, parentId: directoryParentId }).strict();
export const accountLifecycleSchema = z.enum(['PENDING_ACTIVATION', 'ACTIVE', 'SUSPENDED', 'PENDING_CLOSURE', 'CLOSED', 'UNKNOWN']);
export const directoryAccountSchema = z.object({ id: z.string().regex(/^\d{12}$/), name: z.string().min(1).max(128), lifecycle: accountLifecycleSchema,
  access: z.literal('not-checked'), inspection: z.literal('not-collected') }).strict();
const ouSchema = z.object({ id: z.string().regex(/^ou-[a-z0-9]{4,32}-[a-z0-9]{8,32}$/), name: z.string().min(1).max(128), browseCursor: z.uuid().optional() }).strict();
const issue = z.enum(['access_denied', 'not_in_organization', 'throttled', 'unavailable', 'invalid_response']);
const page = <T extends z.ZodType>(item: T, source: string) => z.discriminatedUnion('status', [
  z.object({ status: z.literal('collected'), source: z.literal(source), observedAt: z.iso.datetime(), items: z.array(item).max(20), hasMore: z.boolean(), pageNumber: z.number().int().min(1).max(1000), nextCursor: z.uuid().optional() }).strict(),
  z.object({ status: z.enum(['denied', 'unavailable']), source: z.enum([source, 'organizations:DescribeOrganization', 'organizations:ListRoots', 'organizations:DescribeOrganizationalUnit', 'organizations:ListParents']), observedAt: z.iso.datetime(), code: issue }).strict(),
]);
export const directorySnapshotSchema = z.object({
  connectionId: z.uuid(), accountId: z.string().regex(/^\d{12}$/), region: z.string().min(1).max(32),
  scope: directoryScopeSchema, parentName: z.string().min(1).max(128).optional(), collectedAt: z.iso.datetime(),
  coverage: z.literal('direct-children-page'), parentId: directoryParentId,
  navigation: z.object({ expiresAt: z.iso.datetime(), path: z.array(z.object({ id: directoryParentId, name: z.string().min(1).max(128), cursor: z.uuid() }).strict()).min(1).max(6) }).strict(),
  accounts: page(directoryAccountSchema, 'organizations:ListAccountsForParent'),
  organizationalUnits: page(ouSchema, 'organizations:ListOrganizationalUnitsForParent'),
}).strict().refine(value => value.navigation.path[0].id === value.scope.parentId && value.navigation.path.at(-1)!.id === value.parentId && new Set(value.navigation.path.map(item => item.id)).size === value.navigation.path.length, 'Directory path must remain rooted in its configured scope.');
export type DirectoryScope = z.infer<typeof directoryScopeSchema>;
export type DirectorySnapshot = z.infer<typeof directorySnapshotSchema>;
