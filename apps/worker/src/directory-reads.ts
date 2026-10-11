import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { CloudOperationError } from '../../../packages/contracts/errors';
import { accountLifecycleSchema, directoryParentId, directorySnapshotSchema, type DirectorySnapshot } from '../../../packages/contracts/aws/directory';
import { cliFailure, type CliBinding, type CliOperation, type CliRuntime } from '../../../packages/worker-protocol/cli-contract';

const named = z.object({ Id: z.string().min(1).max(100), Name: z.string().min(1).max(128), Arn: z.string().max(2048) }).strict();
const token = z.string().min(1).max(100000).nullable().optional();
const accounts = z.object({ Items: z.array(named.extend({ State: z.string().max(100).nullable().optional() })).max(20), HasMore: z.boolean(), NextToken: token }).strict();
const units = z.object({ Items: z.array(named).max(20), HasMore: z.boolean(), NextToken: token }).strict();
const parents = z.object({ Items: z.array(z.object({ Id: directoryParentId, Type: z.enum(['ROOT', 'ORGANIZATIONAL_UNIT']) }).strict()).max(1), HasMore: z.boolean() }).strict();
const organization = z.object({ Id: z.string(), MasterAccountId: z.string().regex(/^\d{12}$/) }).strict();
function parsed<T>(schema: z.ZodType<T>, raw: string): T {
  try { return schema.parse(JSON.parse(raw)); } catch { throw cliFailure('directory_invalid_response'); }
}
function issue(error: unknown): { status: 'denied' | 'unavailable'; code: 'access_denied' | 'not_in_organization' | 'throttled' | 'unavailable' | 'invalid_response' } {
  if (!(error instanceof CloudOperationError)) return { status: 'unavailable', code: 'unavailable' };
  if (['sso_expired', 'cli_cancelled', 'cli_timeout', 'identity_changed', 'directory_scope_mismatch'].includes(error.code)) throw error;
  if (error.code === 'sso_denied') return { status: 'denied', code: 'access_denied' };
  return { status: 'unavailable', code: error.code === 'organization_not_in_use' ? 'not_in_organization' : error.code === 'cli_throttled' ? 'throttled' : error.code === 'directory_invalid_response' ? 'invalid_response' : 'unavailable' };
}
type PathNode = { id: string; name: string };
type DirectorySelection = { path: PathNode[]; expires: number; accountPage: number; ouPage: number; accountToken?: string; ouToken?: string; accountSeen: string[]; ouSeen: string[] };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

/** Per-worker capabilities. Raw AWS continuation tokens never leave this instance/runtime. */
export class OrganizationDirectory {
  private readonly grants = new Map<string, DirectorySelection>();
  private epoch = 0;
  private readonly binding: CliBinding;
  private readonly runtime: CliRuntime;
  private readonly now: () => number;
  constructor(binding: CliBinding, runtime: CliRuntime, now = Date.now) { this.binding = binding; this.runtime = runtime; this.now = now; }
  clear() { this.grants.clear(); this.epoch++; }
  prepare(cursor?: string): DirectorySelection {
    if (!this.binding.directory) throw cliFailure('directory_not_configured', 409);
    if (!cursor) {
      this.clear();
      return { path: [{ id: this.binding.directory.parentId, name: this.binding.directory.parentId }], expires: this.now() + 600_000, accountPage: 1, ouPage: 1, accountSeen: [], ouSeen: [] };
    }
    if (!z.uuid().safeParse(cursor).success) throw cliFailure('directory_cursor_invalid', 409);
    const selection = this.grants.get(cursor);
    if (!selection) throw cliFailure('directory_cursor_invalid', 409);
    if (selection.expires <= this.now()) { this.grants.delete(cursor); throw cliFailure('directory_cursor_expired', 409); }
    return structuredClone(selection);
  }
  private grant(selection: DirectorySelection) {
    if (selection.expires <= this.now()) throw cliFailure('directory_cursor_expired', 409);
    for (const [id, value] of this.grants) if (value.expires <= this.now()) this.grants.delete(id);
    // Evict old views; each returned view creates fresh grants for all its visible controls.
    while (this.grants.size >= 128) this.grants.delete(this.grants.keys().next().value!);
    const cursor = randomUUID(); this.grants.set(cursor, structuredClone(selection)); return cursor;
  }
  async collect(selection: DirectorySelection, signal: AbortSignal): Promise<DirectorySnapshot> {
    const scope = this.binding.directory!;
    const epoch = this.epoch, parentId = selection.path.at(-1)!.id;
    const stamp = () => new Date(this.now()).toISOString();
    const guard = () => { if (signal.aborted || this.epoch !== epoch) throw cliFailure('cli_cancelled'); };
    const run = async (operation: CliOperation, id = parentId, nextToken?: string) => {
      guard(); const result = await this.runtime.run(operation, signal, undefined, { parentId: id, ...(nextToken ? { nextToken } : {}) }); guard(); return result.stdout;
    };
    const checkPath = async () => {
      for (let i = selection.path.length - 1; i > 0; i--) {
        const page = parsed(parents, await run('directory-ancestors', selection.path[i].id));
        if (page.HasMore || page.Items.length !== 1) throw cliFailure('directory_scope_unverified', 409);
        const expected = selection.path[i - 1].id;
        if (page.Items[0].Id !== expected || page.Items[0].Type !== (expected.startsWith('r-') ? 'ROOT' : 'ORGANIZATIONAL_UNIT')) throw cliFailure('directory_scope_mismatch', 403);
      }
    };
    const finish = (accountPage: DirectorySnapshot['accounts'], ouPage: DirectorySnapshot['organizationalUnits'], parentName?: string, accountNext?: string, ouNext?: string) => {
      guard();
      const path = selection.path.map((item, index) => index === selection.path.length - 1 && parentName ? { ...item, name: parentName } : item);
      const base = { ...selection, path };
      const first = (nodes: PathNode[]): DirectorySelection => ({ ...base, path: nodes, accountPage: 1, ouPage: 1, accountToken: undefined, ouToken: undefined, accountSeen: [], ouSeen: [] });
      const navigation = { expiresAt: new Date(selection.expires).toISOString(), path: path.map((item, index) => ({ ...item, cursor: this.grant(first(path.slice(0, index + 1))) })) };
      if (accountPage.status === 'collected' && accountNext && selection.accountPage < 1000) accountPage.nextCursor = this.grant({ ...base, accountPage: selection.accountPage + 1, accountToken: accountNext, accountSeen: [...selection.accountSeen, hash(accountNext)] });
      if (ouPage.status === 'collected') {
        if (ouNext && selection.ouPage < 1000) ouPage.nextCursor = this.grant({ ...base, ouPage: selection.ouPage + 1, ouToken: ouNext, ouSeen: [...selection.ouSeen, hash(ouNext)] });
        if (path.length < 6) for (const item of ouPage.items) item.browseCursor = this.grant(first([...path, { id: item.id, name: item.name }]));
      }
      return directorySnapshotSchema.parse({ connectionId: this.binding.connectionId, accountId: this.binding.accountId, region: this.binding.region, scope, parentId, parentName, navigation,
        coverage: 'direct-children-page', collectedAt: stamp(), accounts: accountPage, organizationalUnits: ouPage });
    };
    let manager: string, parentName: string, preflightSource = 'organizations:DescribeOrganization';
    try {
      const org = parsed(organization, await run('directory-organization'));
      if (org.Id !== scope.awsOrganizationId) throw cliFailure('directory_scope_mismatch', 403);
      manager = org.MasterAccountId;
      preflightSource = 'organizations:ListParents'; await checkPath();
      preflightSource = parentId.startsWith('r-') ? 'organizations:ListRoots' : 'organizations:DescribeOrganizationalUnit';
      const parent = parsed(units, await run('directory-parent')), match = parent.Items.find(item => item.Id === parentId);
      if (!match) throw cliFailure('directory_invalid_response');
      if (match.Arn !== `arn:aws:organizations::${manager}:${parentId.startsWith('r-') ? 'root' : 'ou'}/${scope.awsOrganizationId}/${parentId}`) throw cliFailure('directory_scope_mismatch', 403);
      parentName = match.Name;
    } catch (error) {
      const failure = issue(error), observedAt = stamp();
      return finish({ ...failure, source: preflightSource, observedAt }, { ...failure, source: preflightSource, observedAt });
    }
    const next = (page: { HasMore: boolean; NextToken?: string | null }, seen: string[]) => {
      if (page.HasMore !== Boolean(page.NextToken) || page.NextToken && seen.includes(hash(page.NextToken))) throw cliFailure('directory_invalid_response');
      return page.NextToken ?? undefined;
    };
    let accountPage: DirectorySnapshot['accounts'], ouPage: DirectorySnapshot['organizationalUnits'], accountNext: string | undefined, ouNext: string | undefined;
    try {
      const page = parsed(accounts, await run('directory-accounts', parentId, selection.accountToken));
      accountNext = next(page, selection.accountSeen);
      const ids = new Set<string>();
      const items = page.Items.map(item => {
        if (ids.has(item.Id) || item.Arn !== `arn:aws:organizations::${manager}:account/${scope.awsOrganizationId}/${item.Id}`) throw cliFailure('directory_scope_mismatch', 403);
        ids.add(item.Id);
        return { id: item.Id, name: item.Name, lifecycle: accountLifecycleSchema.safeParse(item.State).data ?? 'UNKNOWN', access: 'not-checked' as const, inspection: 'not-collected' as const };
      });
      accountPage = { status: 'collected', source: 'organizations:ListAccountsForParent', observedAt: stamp(), items, hasMore: page.HasMore, pageNumber: selection.accountPage };
    } catch (error) { accountPage = { ...issue(error), source: 'organizations:ListAccountsForParent', observedAt: stamp() }; }
    try {
      const page = parsed(units, await run('directory-ous', parentId, selection.ouToken)); ouNext = next(page, selection.ouSeen);
      const ids = new Set<string>();
      const items = page.Items.map(item => {
        const rootId = scope.parentId.startsWith('r-') ? scope.parentId.slice(2) : scope.parentId.split('-')[1];
        if (ids.has(item.Id) || !item.Id.startsWith(`ou-${rootId}-`) || selection.path.some(node => node.id === item.Id) || item.Arn !== `arn:aws:organizations::${manager}:ou/${scope.awsOrganizationId}/${item.Id}`) throw cliFailure('directory_scope_mismatch', 403);
        ids.add(item.Id); return { id: item.Id, name: item.Name };
      });
      ouPage = { status: 'collected', source: 'organizations:ListOrganizationalUnitsForParent', observedAt: stamp(), items, hasMore: page.HasMore, pageNumber: selection.ouPage };
    } catch (error) { ouPage = { ...issue(error), source: 'organizations:ListOrganizationalUnitsForParent', observedAt: stamp() }; }
    // A previously observed OU may have moved while the queries were in flight.
    try { await checkPath(); } catch (error) {
      if (error instanceof CloudOperationError && ['directory_scope_mismatch', 'cli_cancelled', 'sso_expired'].includes(error.code)) throw error;
      throw cliFailure('directory_scope_unverified', 409);
    }
    return finish(accountPage, ouPage, parentName, accountNext, ouNext);
  }
}
