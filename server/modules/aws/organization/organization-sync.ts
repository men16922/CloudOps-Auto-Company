import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { CloudOperationError } from '../../../../src/domain/cloud-workflow';
import { connectionItemSchema, connectionServices } from '../../../../src/modules/aws/domain/connections';
import { accountLifecycleSchema } from '../../../../src/modules/aws/domain/directory';
import { inventoryUnitSchema, serviceStateCodes, type InventoryUnit, type SyncAccount, type SyncJob } from '../../../../src/modules/aws/domain/inventory';
import { eksVersions, kafkaVersions, rdsLifecycles, withEksSupport, withKafkaStatus, withRdsSupport, type EksVersion, type RdsLifecycle } from './organization-lifecycle';
import { checkedCliIdentity, cliFailure, configResourceTypes, type CliBinding, type CliIdentity, type CliOperation, type CliTarget, type DirectoryQuery, type ReadQuery } from './organization-cli-contract';

type Service = typeof connectionServices[number];
type Item = z.infer<typeof connectionItemSchema>;
export type SyncRun = (operation: CliOperation, input?: DirectoryQuery | ReadQuery, target?: CliTarget) => Promise<string>;
/** Reads one service in one account/region (shared with the single-account inspect path). */
export type SyncRead = (service: Service, target: CliTarget) => Promise<{ items: Item[]; hasMore: boolean }>;
export type SyncContext = { binding: Readonly<CliBinding>; pinned: CliIdentity; now: () => number; run: SyncRun; read: SyncRead; readFailure: (code: string) => CloudOperationError };

const directoryPage = z.object({ Items: z.array(z.object({ Id: z.string(), Name: z.string().nullable().optional(), Arn: z.string().optional(), State: z.string().nullable().optional() }).passthrough()).max(20),
  NextToken: z.string().min(1).max(100000).nullable().optional(), HasMore: z.boolean() }).strict();
const regionsPage = z.object({ Items: z.array(z.object({ name: z.string(), state: z.string().nullable().optional() }).strict()).max(60), HasMore: z.boolean() }).strict();
const vpcCount = z.object({ Total: z.number().int().min(0), Tagged: z.number().int().min(0), HasMore: z.boolean() }).strict();
const configPage = z.object({ Results: z.array(z.string().max(400_000)).max(100).nullable(), NextToken: z.string().min(1).max(100000).nullable().optional() }).strict();
const regionPattern = /^[a-z]{2}(?:-[a-z]+)+-\d$/, accountPattern = /^\d{12}$/;
/** Session-level failures stop the whole job; anything else fails one account, region or unit. */
export const sessionCodes = new Set(['connection_unavailable', 'identity_changed', 'sso_expired', 'connection_expired', 'worker_closed', 'cli_unavailable', 'offline_cli_forbidden', 'isolated_worker_required']);
const directServices: Service[] = ['alarms', 'metrics', 'ec2', 'eks', 'rds', 'elasticache', 'msk', 'lambda', 'dynamodb', 'apigateway', 'ssm', 'automation', 'patch', 'securityhub', 'guardduty'];
/** Inventory services AWS Config provides in aggregator mode; operational checks (alarms, metrics, SSM) still read directly per account/region. */
const configServices: Service[] = ['ec2', 'eks', 'rds', 'msk', 'lambda', 'dynamodb', 'apigateway'];
/** Read directly per used account/region even in aggregator mode (not in AWS Config: ElastiCache; operational and security state: the rest). */
const deepServices: Service[] = ['alarms', 'metrics', 'elasticache', 'ssm', 'automation', 'patch', 'securityhub', 'guardduty'];
/** AWS Health is account-wide and served from us-east-1; it is read once per verified account. */
const healthRegion = 'us-east-1';
const parsed = <T>(schema: z.ZodType<T>, raw: string) => { try { return schema.parse(JSON.parse(raw)); } catch { throw cliFailure('invalid_read_result'); } };
const sessionName = (identity: CliIdentity) => identity.arn.slice(identity.arn.lastIndexOf('/') + 1);

/** Background sync for one connection. Accounts come only from the configured Organizations scope (bounded), regions only
 * from the account's enabled (or configured) regions, and a region is scanned only when it has a tagged VPC. */
export class OrganizationSync {
  readonly job: SyncJob;
  readonly units = new Map<string, InventoryUnit>();
  private readonly ctx: SyncContext;
  /** Lifecycle catalogs read from AWS once per sync (lazily, only when such resources exist). */
  private rds?: Promise<ReadonlyMap<string, RdsLifecycle>>;
  private kafka?: Promise<ReadonlyMap<string, 'ACTIVE' | 'DEPRECATED'>>;
  private eks?: Promise<ReadonlyMap<string, EksVersion>>;
  private catalog<T>(operation: 'rds-lifecycle' | 'kafka-versions' | 'eks-versions', parse: (raw: string) => T, empty: T): Promise<T> {
    // A denied or failed catalog read only leaves support unknown; session-level failures still stop the job.
    return this.ctx.run(operation).then(parse, error => { this.failureCode(error); return empty; });
  }
  private async enrich(service: Service, items: Item[]) {
    if (!items.length) return items;
    if (service === 'rds') { const map = await (this.rds ??= this.catalog('rds-lifecycle', rdsLifecycles, new Map())); const now = this.ctx.now(); return items.map(item => withRdsSupport(item, map, now)); }
    if (service === 'msk') { const map = await (this.kafka ??= this.catalog('kafka-versions', kafkaVersions, new Map())); return items.map(item => withKafkaStatus(item, map)); }
    if (service === 'eks' && items.some(item => item.version && !item.support)) { const map = await (this.eks ??= this.catalog('eks-versions', eksVersions, new Map())); return items.map(item => item.support ? item : withEksSupport(item, map)); }
    return items;
  }
  constructor(ctx: SyncContext) {
    this.ctx = ctx;
    this.job = { connectionId: ctx.binding.connectionId, jobId: randomUUID(), mode: ctx.binding.inventory?.config ? 'config' : 'direct', state: 'running',
      startedAt: new Date(ctx.now()).toISOString(), progress: { done: 0, total: 1 }, accounts: [], units: [] };
  }
  private iso() { return new Date(this.ctx.now()).toISOString(); }
  private step(count = 1) { this.job.progress.done += count; }
  private plan(count: number) { this.job.progress.total += count; }
  private record(unit: InventoryUnit) {
    const checked = inventoryUnitSchema.parse(unit), id = randomUUID();
    this.units.set(id, checked);
    this.job.units.push({ id, accountId: checked.accountId, region: checked.region, service: checked.service, count: checked.items.length, ...(checked.code ? { code: checked.code } : {}) });
  }
  private failureCode(error: unknown) {
    if (!(error instanceof CloudOperationError) || sessionCodes.has(error.code)) throw error;
    return error.code;
  }
  async run() {
    const accounts = await this.accounts();
    this.job.accounts = accounts; this.plan(accounts.length); this.step();
    if (this.job.mode === 'config') await this.configInventory(accounts);
    for (const account of accounts) {
      if (account.lifecycle && account.lifecycle !== 'ACTIVE') { account.code = 'account_not_active'; this.step(); continue; }
      const target = { accountId: account.accountId, region: this.ctx.binding.region };
      try { await this.verify(target); account.access = 'verified'; } catch (error) {
        const code = this.failureCode(error); account.access = ['access_denied', 'sso_denied'].includes(code) ? 'denied' : 'failed'; account.code = code; this.step(); continue;
      }
      if (this.job.mode === 'direct') await this.probeRegions(account);
      const scan = new Set(account.regions.filter(region => region.taggedVpcs > 0).map(region => region.region));
      // The connection's own home region is always read for the payer account (server-fixed), even without a tagged VPC.
      if (account.accountId === this.ctx.binding.accountId) scan.add(this.ctx.binding.region);
      const services = this.job.mode === 'config' ? deepServices : directServices;
      this.plan(scan.size * services.length + 1);
      for (const region of scan) for (const service of services) await this.unit(service, { accountId: account.accountId, region });
      await this.unit('health', { accountId: account.accountId, region: healthRegion });
      await this.verify(target);
      this.step();
    }
    const after = checkedCliIdentity(await this.ctx.run('identity'), this.ctx.binding);
    if (after.arn !== this.ctx.pinned.arn || after.userId !== this.ctx.pinned.userId) throw cliFailure('identity_changed', 403);
    this.job.state = this.job.accounts.some(account => account.access !== 'verified' && !account.code?.startsWith('account_not_active')) || this.job.units.some(unit => unit.code && !serviceStateCodes.has(unit.code)) ? 'partial' : 'completed';
  }
  /** Same Identity Center user in every account: the role session name must match the pinned payer identity. */
  private async verify(target: CliTarget) {
    const raw = await this.ctx.run('identity', undefined, target);
    const identity = checkedCliIdentity(raw, { ...this.ctx.binding, accountId: target.accountId });
    if (target.accountId === this.ctx.binding.accountId ? identity.arn !== this.ctx.pinned.arn || identity.userId !== this.ctx.pinned.userId : sessionName(identity) !== sessionName(this.ctx.pinned)) throw cliFailure('identity_changed', 403);
  }
  private async accounts(): Promise<SyncAccount[]> {
    const { binding } = this.ctx, max = binding.inventory?.maxAccounts ?? 50, found = new Map<string, SyncAccount>();
    const add = (id: string, name?: string | null, state?: string | null) => {
      if (!accountPattern.test(id) || found.size >= max && !found.has(id)) return;
      found.set(id, { accountId: id, ...(name && name.length <= 128 ? { name } : {}), lifecycle: accountLifecycleSchema.safeParse(state).data ?? 'UNKNOWN', access: 'pending', regions: [], candidateRegions: 0 });
    };
    found.set(binding.accountId, { accountId: binding.accountId, access: 'pending', regions: [], candidateRegions: 0 });
    const scope = binding.directory;
    if (!scope) return [...found.values()];
    if (scope.parentId.startsWith('r-')) {
      let token: string | undefined, pages = 0;
      do {
        const page = parsed(directoryPage, await this.ctx.run('directory-all-accounts', { parentId: scope.parentId, ...(token ? { nextToken: token } : {}) }));
        page.Items.forEach(item => add(item.Id, item.Name, item.State)); token = page.NextToken ?? undefined; pages++;
      } while (token && found.size < max && pages < 50);
    } else {
      // An OU scope is walked breadth-first through its own child OUs only (bounded).
      const queue = [scope.parentId]; let visited = 0;
      while (queue.length && found.size < max && visited < 100) {
        const parentId = queue.shift()!; visited++;
        for (const operation of ['directory-accounts', 'directory-ous'] as const) {
          let token: string | undefined, pages = 0;
          do {
            const page = parsed(directoryPage, await this.ctx.run(operation, { parentId, ...(token ? { nextToken: token } : {}) }));
            for (const item of page.Items) operation === 'directory-accounts' ? add(item.Id, item.Name, item.State) : /^ou-[a-z0-9]{4,32}-[a-z0-9]{8,32}$/.test(item.Id) && queue.push(item.Id);
            token = page.NextToken ?? undefined; pages++;
          } while (token && pages < 20 && found.size < max);
        }
      }
    }
    const payer = found.get(binding.accountId)!;
    return [payer, ...[...found.values()].filter(account => account !== payer)];
  }
  private async probeRegions(account: SyncAccount) {
    const target = { accountId: account.accountId, region: this.ctx.binding.region };
    let candidates = this.ctx.binding.inventory?.regions;
    if (!candidates) {
      try { candidates = parsed(regionsPage, await this.ctx.run('regions', undefined, target)).Items.filter(item => regionPattern.test(item.name) && item.state !== 'not-opted-in').map(item => item.name); }
      catch (error) { account.code = this.failureCode(error); return; }
    }
    account.candidateRegions = candidates.length; this.plan(candidates.length);
    for (const region of candidates) {
      try {
        const count = parsed(vpcCount, await this.ctx.run('vpcs', undefined, { accountId: account.accountId, region }));
        account.regions.push({ region, vpcs: Math.min(count.Total, 5000), taggedVpcs: Math.min(count.Tagged, 5000) });
      } catch (error) { account.code = `region_${this.failureCode(error)}`.slice(0, 64); }
      this.step();
    }
  }
  private async unit(service: Service, target: CliTarget) {
    const base = { accountId: target.accountId, region: target.region, service, source: 'direct' as const };
    try { const page = await this.ctx.read(service, target); this.record({ ...base, collectedAt: this.iso(), hasMore: page.hasMore, items: await this.enrich(service, page.items) }); }
    catch (error) { const code = this.failureCode(error); this.record({ ...base, collectedAt: this.iso(), hasMore: false, items: [], code: this.ctx.readFailure(code).code }); }
    this.step();
  }
  /** Aggregator mode: inventory and VPC tags for every account/region in one fixed query per resource type, limited to the scope's accounts. */
  private async configInventory(accounts: SyncAccount[]) {
    const { binding } = this.ctx, config = binding.inventory!.config!, inScope = new Map(accounts.map(account => [account.accountId, account]));
    await this.verify({ accountId: config.accountId, region: config.region });
    const grouped = new Map<string, { accountId: string; region: string; service: Service; items: Item[]; hasMore: boolean }>();
    this.plan(configResourceTypes.length);
    for (const resourceType of configResourceTypes) {
      let token: string | undefined, pages = 0;
      try {
        do {
          const page = parsed(configPage, await this.ctx.run('config-query', { kind: 'config', resourceType, ...(token ? { nextToken: token } : {}) }));
          for (const raw of page.Results ?? []) {
            let row: Record<string, unknown>; try { row = JSON.parse(raw) as Record<string, unknown>; } catch { continue; }
            const accountId = String(row.accountId ?? ''), region = String(row.awsRegion ?? ''), account = inScope.get(accountId);
            if (!account || !regionPattern.test(region)) continue;
            const tags = Array.isArray(row.tags) ? row.tags as unknown[] : undefined;
            if (resourceType === 'AWS::EC2::VPC') {
              const entry = account.regions.find(item => item.region === region) ?? (account.regions.length < 40 ? (account.regions.push({ region, vpcs: 0, taggedVpcs: 0 }), account.regions.at(-1)!) : undefined);
              if (entry) { entry.vpcs++; if (tags?.length) entry.taggedVpcs++; }
              continue;
            }
            const mapped = configItem(resourceType, row, tags);
            if (!mapped) continue;
            const key = `${accountId}|${region}|${mapped.service}`, group = grouped.get(key) ?? { accountId, region, service: mapped.service, items: [], hasMore: false };
            if (group.items.length < 100) group.items.push(mapped.item); else group.hasMore = true;
            grouped.set(key, group);
          }
          token = page.NextToken ?? undefined; pages++;
        } while (token && pages < 50);
        if (token) for (const group of grouped.values()) group.hasMore = true;
      } catch (error) {
        const code = this.failureCode(error);
        for (const account of accounts) account.code ??= `config_${code}`.slice(0, 64);
      }
      this.step();
    }
    for (const account of accounts) account.candidateRegions = account.regions.length;
    for (const group of grouped.values()) {
      this.record({ accountId: group.accountId, region: group.region, service: group.service, collectedAt: this.iso(), hasMore: group.hasMore, items: await this.enrich(group.service, group.items), source: 'config' });
    }
    // Every scope account/region with tagged VPCs but no recorded resources still shows as collected-and-empty.
    for (const account of accounts) for (const region of account.regions.filter(item => item.taggedVpcs > 0)) for (const service of configServices) {
      if (!grouped.has(`${account.accountId}|${region.region}|${service}`)) this.record({ accountId: account.accountId, region: region.region, service, collectedAt: this.iso(), hasMore: false, items: [], source: 'config' });
    }
  }
}

const text = (value: unknown, max = 200) => typeof value === 'string' && value.length > 0 ? value.slice(0, max) : undefined;
const path = (row: Record<string, unknown>, keys: string[]) => keys.reduce<unknown>((value, key) => value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined, row);
const nameTagOf = (tags: unknown[]) => text((tags.find(tag => tag && typeof tag === 'object' && (tag as { key?: unknown }).key === 'Name') as { value?: unknown } | undefined)?.value, 1024);
/** Maps one AWS Config advanced-query row to the shared item shape; invalid values are dropped, never guessed. */
export function configItem(resourceType: typeof configResourceTypes[number], row: Record<string, unknown>, tags: unknown[] | undefined): { service: Service; item: Item } | undefined {
  const config = (keys: string[]) => path(row, ['configuration', ...keys]), id = text(row.resourceId, 256), name = text(row.resourceName, 1024) ?? id;
  const keys = tags?.flatMap(tag => { const key = tag && typeof tag === 'object' ? (tag as { key?: unknown }).key : undefined; return typeof key === 'string' && key.length > 0 && key.length <= 128 ? [key] : []; }).slice(0, 80);
  const nameTag = tags ? nameTagOf(tags) : undefined;
  const versioned = (engine: unknown, version: unknown) => text(engine, 50) && text(version, 49) ? `${engine} ${version}` : text(engine, 100);
  const candidates: Record<typeof configResourceTypes[number], [Service, Record<string, unknown>] | undefined> = {
    'AWS::EC2::VPC': undefined,
    'AWS::EC2::Instance': ['ec2', { id, name: nameTag ?? id, state: text(config(['state', 'name']), 100), type: text(config(['instanceType']), 100), modified: text(config(['launchTime']), 100) }],
    'AWS::EKS::Cluster': ['eks', { name, version: text(config(['Version']), 100), state: text(config(['ClusterStatus']), 100) }],
    'AWS::RDS::DBInstance': ['rds', { name, state: text(config(['dBInstanceStatus']), 100), type: text(config(['dBInstanceClass']), 100), version: versioned(config(['engine']), config(['engineVersion'])) }],
    'AWS::MSK::Cluster': ['msk', { name, version: text(config(['KafkaVersion']), 100), type: text(config(['BrokerNodeGroupInfo', 'InstanceType']), 100) }],
    'AWS::Lambda::Function': ['lambda', { name, runtime: text(config(['runtime']), 100), modified: text(config(['lastModified']), 100) }],
    'AWS::DynamoDB::Table': ['dynamodb', { name, state: text(config(['tableStatus']), 100) }],
    'AWS::ApiGateway::RestApi': ['apigateway', { id, name, type: 'REST', version: text((config(['endpointConfiguration', 'types']) as unknown[] | undefined)?.[0], 100), modified: text(config(['createdDate']), 100) }],
    'AWS::ApiGatewayV2::Api': ['apigateway', { id, name, type: text(config(['protocolType']), 100), modified: text(config(['createdDate']), 100) }],
  };
  const candidate = candidates[resourceType];
  if (!candidate || !name) return undefined;
  const item = connectionItemSchema.safeParse({ ...Object.fromEntries(Object.entries(candidate[1]).filter(([, value]) => value !== undefined)), ...(keys ? { tags: [...new Set(keys)] } : {}) });
  return item.success ? { service: candidate[0], item: item.data } : undefined;
}
