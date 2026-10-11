import type { ConnectionPage } from '../contracts/aws/connections';
import type { DirectorySnapshot } from '../contracts/aws/directory';
import { serviceStateCodes, type InventoryUnit } from '../contracts/aws/inventory';
import { lifecycleRows, type EosRow } from './eos-rules';
import { guardDutyLevel, healthSeverity, tagRows } from './governance';

export type Service = ConnectionPage['operation'];
export type Item = ConnectionPage['items'][number];
export type MetricId = NonNullable<Item['metric']>;
/** One resource with the account and region it was read from. */
export type Located = Item & { accountId: string; region: string };
/** `failed` = reads that failed; `disabled` = the service is not enabled (Security Hub/GuardDuty) or not available on the support plan (Health). */
export type ServiceData = { items: Located[]; units: InventoryUnit[]; partial: boolean; failed: InventoryUnit[]; disabled: InventoryUnit[] };
export type Severity = 'critical' | 'warning' | 'info';
export type Finding = { id: string; severity: Severity; kind: 'alarm' | 'alarm-data' | 'eos' | 'account' | 'instance' | 'coverage' | 'resource-state' | 'metric' | 'ssm-unmanaged' | 'ssm-lost' | 'patch' | 'automation' | 'read-failed'
  | 'security-hub' | 'guardduty' | 'security-off' | 'tags' | 'health';
  subject: string; detail: string; source: Service | 'directory'; accountId?: string; region?: string; link?: string; metric?: MetricId; value?: number; eos?: Pick<EosRow, 'component' | 'status' | 'date' | 'daysLeft' | 'current'> };
type Count = { total: number; partial: boolean };
export type Assessment = { overall: 'action' | 'attention' | 'clear' | 'unknown'; findings: Finding[]; counts: Record<Severity, number>;
  metrics: { accounts?: Count & { active: number }; ous?: number; alarms?: Count & { alarm: number; insufficient: number };
    lambda?: Count & { deprecated: number; runtimes: Array<[string, number]> }; dynamodb?: Count; apigateway?: Count;
    ec2?: Count & { running: number; stopped: number }; eks?: Count & { extended: number; unsupported: number; active: number };
    rds?: Count & { available: number }; elasticache?: Count & { available: number }; msk?: Count & { active: number }; metricSeries?: number;
    ssm?: Count & { online: number; unmanaged: number }; patch?: Count & { nonCompliant: number }; automation?: Count & { failed: number };
    securityhub?: Count & { critical: number; high: number; off: number }; guardduty?: Count & { threats: number; off: number };
    tags?: { compliant: number; missing: number; unknown: number }; health?: Count & { events: number; unavailable: number } } };
/** Opens a console URL in the resource's account (Identity Center shortcut link when a portal is known). */
type ConsoleOpener = (accountId: string, url: string) => string;


/** Product defaults for the standard-metric checks (last hour, 5-minute periods). Shown in the UI next to each metric. */
export const metricThresholds: Record<MetricId, { info?: number; warning?: number; critical?: number; direction: 'above' | 'below'; unit: 'percent' | 'bytes' | 'count' }> = {
  ec2_cpu: { warning: 90, direction: 'above', unit: 'percent' }, ec2_status: { critical: 1, direction: 'above', unit: 'count' },
  rds_cpu: { warning: 90, direction: 'above', unit: 'percent' }, rds_storage: { warning: 10 * 1024 ** 3, critical: 2 * 1024 ** 3, direction: 'below', unit: 'bytes' },
  cache_cpu: { warning: 90, direction: 'above', unit: 'percent' }, cache_memory: { warning: 90, direction: 'above', unit: 'percent' },
  msk_cpu: { warning: 80, direction: 'above', unit: 'percent' }, msk_disk: { warning: 85, critical: 95, direction: 'above', unit: 'percent' },
  lambda_errors: { info: 1, direction: 'above', unit: 'count' },
};
const metricSource: Record<MetricId, Service> = { ec2_cpu: 'ec2', ec2_status: 'ec2', rds_cpu: 'rds', rds_storage: 'rds', cache_cpu: 'elasticache', cache_memory: 'elasticache', msk_cpu: 'msk', msk_disk: 'msk', lambda_errors: 'lambda' };

/** Read-only console deep links. Host and path are fixed; names only appear URL-encoded. */
export const consoleLink = {
  alarm: (region: string, name: string) => `https://${region}.console.aws.amazon.com/cloudwatch/home?region=${region}#alarmsV2:alarm/${encodeURIComponent(name)}`,
  lambda: (region: string, name: string) => `https://${region}.console.aws.amazon.com/lambda/home?region=${region}#/functions/${encodeURIComponent(name)}`,
  dynamodb: (region: string, name: string) => `https://${region}.console.aws.amazon.com/dynamodbv2/home?region=${region}#table?name=${encodeURIComponent(name)}`,
  ec2: (region: string, id: string) => `https://${region}.console.aws.amazon.com/ec2/home?region=${region}#InstanceDetails:instanceId=${encodeURIComponent(id)}`,
  eks: (region: string, name: string) => `https://${region}.console.aws.amazon.com/eks/home?region=${region}#/clusters/${encodeURIComponent(name)}`,
  rds: (region: string, name: string) => `https://${region}.console.aws.amazon.com/rds/home?region=${region}#database:id=${encodeURIComponent(name)};is-cluster=false`,
  elasticache: (region: string) => `https://${region}.console.aws.amazon.com/elasticache/home?region=${region}#/`,
  msk: (region: string) => `https://${region}.console.aws.amazon.com/msk/home?region=${region}#/clusters`,
  apigateway: (region: string, id: string, type?: string) => type === 'REST' ? `https://${region}.console.aws.amazon.com/apigateway/main/apis/${encodeURIComponent(id)}/resources?api=${encodeURIComponent(id)}&region=${region}` : `https://${region}.console.aws.amazon.com/apigateway/main/api-detail?api=${encodeURIComponent(id)}&region=${region}`,
  ssmNode: (region: string, id: string) => `https://${region}.console.aws.amazon.com/systems-manager/fleet-manager/managed-nodes/${encodeURIComponent(id)}/general?region=${region}`,
  automation: (region: string, id: string) => `https://${region}.console.aws.amazon.com/systems-manager/automation/execution/${encodeURIComponent(id)}?region=${region}`,
  account: (id: string) => `https://us-east-1.console.aws.amazon.com/organizations/v2/home/accounts/${encodeURIComponent(id)}`,
  securityhub: (region: string) => `https://${region}.console.aws.amazon.com/securityhub/home?region=${region}#/findings`,
  guardduty: (region: string) => `https://${region}.console.aws.amazon.com/guardduty/home?region=${region}#/findings`,
  health: () => 'https://health.aws.amazon.com/health/home#/account/dashboard/open-issues',
};

// Lifecycle states that need someone's attention now. Transitional states (modifying, backing-up, rebooting…) are informational.
const rdsCritical = new Set(['failed', 'storage-full', 'incompatible-network', 'incompatible-option-group', 'incompatible-parameters', 'incompatible-restore', 'inaccessible-encryption-credentials', 'inaccessible-encryption-credentials-recoverable', 'restore-error', 'insufficient-capacity']);
const cacheCritical = new Set(['incompatible-network', 'restore-failed']);
const mskWarning = new Set(['HEALING']);
const failedAutomation = new Set(['Failed', 'TimedOut']);

/** Flattens cached units into located items per service. */
export function serviceData(units: Partial<Record<Service, InventoryUnit[]>>, keep: (unit: InventoryUnit) => boolean = () => true): Partial<Record<Service, ServiceData>> {
  const result: Partial<Record<Service, ServiceData>> = {};
  for (const [service, list] of Object.entries(units) as Array<[Service, InventoryUnit[]]>) {
    const selected = list.filter(keep);
    if (!selected.length) continue;
    result[service] = { units: selected, items: selected.flatMap(unit => unit.items.map(item => ({ ...item, accountId: unit.accountId, region: unit.region }))),
      partial: selected.some(unit => unit.hasMore), failed: selected.filter(unit => unit.code && !serviceStateCodes.has(unit.code)), disabled: selected.filter(unit => unit.code && serviceStateCodes.has(unit.code)) };
  }
  return result;
}

/** Derives an operational view only from what was actually read. Missing reads stay unknown; nothing is presumed healthy. */
export function assessOperations(directory: DirectorySnapshot | undefined, data: Partial<Record<Service, ServiceData>>, open: ConsoleOpener = (_account, url) => url, now = Date.now(), requiredTags: readonly string[] = []): Assessment {
  const findings: Finding[] = [], metrics: Assessment['metrics'] = {};
  const { alarms, lambda, ec2, dynamodb, eks, rds, elasticache, msk, apigateway, ssm, patch, automation, securityhub, guardduty, health } = data, series = data.metrics;
  const add = (finding: Finding) => findings.push(finding);
  // Lifecycle (EOS): ended = action, extended/deprecated = attention, upcoming within 30 days = attention, within 90 days = info.
  const eos = lifecycleRows(data, now);
  const eosLink: Partial<Record<Service, (row: EosRow) => string>> = { eks: row => consoleLink.eks(row.region, row.name), rds: row => consoleLink.rds(row.region, row.name), lambda: row => consoleLink.lambda(row.region, row.name),
    elasticache: row => consoleLink.elasticache(row.region), msk: row => consoleLink.msk(row.region), ssm: row => row.id ? consoleLink.ssmNode(row.region, row.id) : consoleLink.ec2(row.region, row.name) };
  const at = (item: Located) => ({ accountId: item.accountId, region: item.region });
  const key = (item: Located, name = item.name) => `${item.accountId}:${item.region}:${name}`;
  for (const [service, value] of Object.entries(data) as Array<[Service, ServiceData]>) for (const unit of value.failed) {
    add({ id: `read:${service}:${unit.accountId}:${unit.region}`, severity: 'info', kind: 'read-failed', subject: service, detail: unit.code ?? 'read_failed', source: service, accountId: unit.accountId, region: unit.region });
  }
  for (const row of eos) {
    const severity: Severity | undefined = row.status === 'ended' ? 'critical' : row.status === 'extended' || row.status === 'deprecated' ? 'warning' : row.status === 'upcoming' ? ((row.daysLeft ?? 999) <= 30 ? 'warning' : 'info') : undefined;
    if (!severity) continue;
    add({ id: `eos:${row.service}:${row.accountId}:${row.region}:${row.id ?? row.name}`, severity, kind: 'eos', subject: row.name, detail: `${row.component} ${row.current}`, source: row.service, accountId: row.accountId, region: row.region,
      link: open(row.accountId, eosLink[row.service]!(row)), eos: { component: row.component, status: row.status, current: row.current, ...(row.date ? { date: row.date } : {}), ...(row.daysLeft !== undefined ? { daysLeft: row.daysLeft } : {}) } });
  }
  if (alarms) {
    const alarm = alarms.items.filter(item => item.state === 'ALARM'), insufficient = alarms.items.filter(item => item.state === 'INSUFFICIENT_DATA');
    metrics.alarms = { total: alarms.items.length, alarm: alarm.length, insufficient: insufficient.length, partial: alarms.partial };
    alarm.forEach(item => add({ id: `alarm:${key(item)}`, severity: 'critical', kind: 'alarm', subject: item.name, detail: 'ALARM', source: 'alarms', ...at(item), link: open(item.accountId, consoleLink.alarm(item.region, item.name)) }));
    insufficient.forEach(item => add({ id: `alarm-data:${key(item)}`, severity: 'warning', kind: 'alarm-data', subject: item.name, detail: 'INSUFFICIENT_DATA', source: 'alarms', ...at(item), link: open(item.accountId, consoleLink.alarm(item.region, item.name)) }));
  }
  if (lambda) {
    const counts = new Map<string, number>();
    lambda.items.forEach(item => counts.set(item.runtime ?? 'container-image', (counts.get(item.runtime ?? 'container-image') ?? 0) + 1));
    const deprecated = eos.filter(row => row.service === 'lambda' && (row.status === 'deprecated' || row.status === 'ended'));
    metrics.lambda = { total: lambda.items.length, deprecated: deprecated.length, partial: lambda.partial, runtimes: [...counts].sort((a, b) => b[1] - a[1]) };
  }
  if (ec2) {
    const running = ec2.items.filter(item => item.state === 'running'), stopped = ec2.items.filter(item => item.state === 'stopped');
    metrics.ec2 = { total: ec2.items.length, running: running.length, stopped: stopped.length, partial: ec2.partial };
    stopped.forEach(item => add({ id: `instance:${key(item, item.id ?? item.name)}`, severity: 'info', kind: 'instance', subject: item.name, detail: 'stopped', source: 'ec2', ...at(item), ...(item.id ? { link: open(item.accountId, consoleLink.ec2(item.region, item.id)) } : {}) }));
    if (ssm) {
      // Coverage only where the SSM read of the same account/region succeeded (a failed read is not evidence of "unmanaged").
      const read = new Set(ssm.units.filter(unit => !unit.code && !unit.hasMore).map(unit => `${unit.accountId}:${unit.region}`)), managed = new Set(ssm.items.map(item => `${item.accountId}:${item.region}:${item.id}`));
      const unmanaged = running.filter(item => item.id && read.has(`${item.accountId}:${item.region}`) && !managed.has(`${item.accountId}:${item.region}:${item.id}`));
      metrics.ssm = { total: ssm.items.length, partial: ssm.partial, online: ssm.items.filter(item => item.state === 'Online').length, unmanaged: unmanaged.length };
      unmanaged.forEach(item => add({ id: `ssm-unmanaged:${key(item, item.id)}`, severity: 'info', kind: 'ssm-unmanaged', subject: item.name, detail: item.id!, source: 'ssm', ...at(item), link: open(item.accountId, consoleLink.ec2(item.region, item.id!)) }));
    }
  }
  if (ssm) {
    metrics.ssm ??= { total: ssm.items.length, partial: ssm.partial, online: ssm.items.filter(item => item.state === 'Online').length, unmanaged: 0 };
    ssm.items.filter(item => item.state === 'ConnectionLost').forEach(item => add({ id: `ssm-lost:${key(item, item.id)}`, severity: 'warning', kind: 'ssm-lost', subject: item.name, detail: 'ConnectionLost', source: 'ssm', ...at(item), ...(item.id ? { link: open(item.accountId, consoleLink.ssmNode(item.region, item.id)) } : {}) }));
  }
  if (patch) {
    const failing = patch.items.filter(item => item.state === 'NON_COMPLIANT');
    metrics.patch = { total: patch.items.length, partial: patch.partial, nonCompliant: failing.length };
    failing.forEach(item => add({ id: `patch:${key(item)}`, severity: item.detail === 'CRITICAL' ? 'critical' : 'warning', kind: 'patch', subject: item.name, detail: item.detail ?? 'NON_COMPLIANT', source: 'patch', ...at(item), ...(item.id?.startsWith('i-') ? { link: open(item.accountId, consoleLink.ssmNode(item.region, item.id)) } : {}) }));
  }
  if (automation) {
    const failed = automation.items.filter(item => item.state && failedAutomation.has(item.state));
    metrics.automation = { total: automation.items.length, partial: automation.partial, failed: failed.length };
    failed.forEach(item => add({ id: `automation:${key(item, item.id)}`, severity: 'warning', kind: 'automation', subject: item.name, detail: item.state!, source: 'automation', ...at(item), ...(item.id ? { link: open(item.accountId, consoleLink.automation(item.region, item.id)) } : {}) }));
  }
  if (eks) {
    metrics.eks = { total: eks.items.length, partial: eks.partial, active: eks.items.filter(item => item.state === 'ACTIVE').length,
      extended: eks.items.filter(item => item.support === 'EXTENDED_SUPPORT').length, unsupported: eks.items.filter(item => item.support === 'UNSUPPORTED').length };
    for (const item of eks.items) {
      const link = open(item.accountId, consoleLink.eks(item.region, item.name));
      if (item.state && item.state !== 'ACTIVE') add({ id: `eks-state:${key(item)}`, severity: item.state === 'FAILED' ? 'critical' : 'info', kind: 'resource-state', subject: item.name, detail: `EKS ${item.state}`, source: 'eks', ...at(item), link });
    }
  }
  if (rds) {
    metrics.rds = { total: rds.items.length, partial: rds.partial, available: rds.items.filter(item => item.state === 'available').length };
    rds.items.filter(item => item.state && item.state !== 'available').forEach(item => add({ id: `rds-state:${key(item)}`, severity: rdsCritical.has(item.state!) ? 'critical' : 'info', kind: 'resource-state', subject: item.name, detail: `RDS ${item.state}`, source: 'rds', ...at(item), link: open(item.accountId, consoleLink.rds(item.region, item.name)) }));
  }
  if (elasticache) {
    metrics.elasticache = { total: elasticache.items.length, partial: elasticache.partial, available: elasticache.items.filter(item => item.state === 'available').length };
    elasticache.items.filter(item => item.state && item.state !== 'available').forEach(item => add({ id: `cache-state:${key(item)}`, severity: cacheCritical.has(item.state!) ? 'critical' : 'info', kind: 'resource-state', subject: item.name, detail: `ElastiCache ${item.state}`, source: 'elasticache', ...at(item), link: open(item.accountId, consoleLink.elasticache(item.region)) }));
  }
  if (msk) {
    metrics.msk = { total: msk.items.length, partial: msk.partial, active: msk.items.filter(item => item.state === 'ACTIVE').length };
    msk.items.filter(item => item.state && item.state !== 'ACTIVE').forEach(item => add({ id: `msk-state:${key(item)}`, severity: item.state === 'FAILED' ? 'critical' : mskWarning.has(item.state!) ? 'warning' : 'info', kind: 'resource-state', subject: item.name, detail: `MSK ${item.state}`, source: 'msk', ...at(item), link: open(item.accountId, consoleLink.msk(item.region)) }));
  }
  // Security posture: one finding per account/region and severity (the detail lists live in the security view).
  if (securityhub) {
    const critical = securityhub.items.filter(item => item.state === 'CRITICAL'), high = securityhub.items.filter(item => item.state === 'HIGH');
    metrics.securityhub = { total: securityhub.items.length, partial: securityhub.partial, critical: critical.length, high: high.length, off: securityhub.disabled.length };
    for (const unit of securityhub.units.filter(unit => !unit.code)) for (const [label, severity] of [['CRITICAL', 'critical'], ['HIGH', 'warning']] as const) {
      const count = unit.items.filter(item => item.state === label).length;
      if (count) add({ id: `security-hub:${label}:${unit.accountId}:${unit.region}`, severity, kind: 'security-hub', subject: 'Security Hub', detail: label, value: count, source: 'securityhub', accountId: unit.accountId, region: unit.region,
        link: open(unit.accountId, consoleLink.securityhub(unit.region)) });
    }
  }
  if (guardduty) {
    metrics.guardduty = { total: guardduty.items.length, partial: guardduty.partial, threats: guardduty.items.length, off: guardduty.disabled.length };
    // High (7.0–8.9) and critical (9.0+) GuardDuty findings indicate a likely compromised resource: action.
    for (const unit of guardduty.units.filter(unit => !unit.code && unit.items.length)) add({ id: `guardduty:${unit.accountId}:${unit.region}`, severity: 'critical', kind: 'guardduty', subject: 'GuardDuty',
      detail: unit.items.some(item => guardDutyLevel(item.value) === 'CRITICAL') ? 'CRITICAL' : 'HIGH', value: unit.items.length, source: 'guardduty', accountId: unit.accountId, region: unit.region, link: open(unit.accountId, consoleLink.guardduty(unit.region)) });
  }
  for (const [service, value] of [['securityhub', securityhub], ['guardduty', guardduty]] as const) for (const unit of value?.disabled ?? []) {
    add({ id: `security-off:${service}:${unit.accountId}:${unit.region}`, severity: 'warning', kind: 'security-off', subject: service === 'securityhub' ? 'Security Hub' : 'GuardDuty', detail: 'not_enabled', source: service, accountId: unit.accountId, region: unit.region,
      link: open(unit.accountId, service === 'securityhub' ? consoleLink.securityhub(unit.region) : consoleLink.guardduty(unit.region)) });
  }
  if (health) {
    metrics.health = { total: health.items.length, partial: health.partial, events: health.items.length, unavailable: health.disabled.length };
    for (const item of health.items) add({ id: `health:${item.accountId}:${item.name}:${item.detail ?? ''}:${item.modified ?? ''}`, severity: healthSeverity(item), kind: 'health', subject: item.name, detail: [item.type, item.version, item.state].filter(Boolean).join(' · '),
      source: 'health', accountId: item.accountId, region: item.detail ?? 'global', link: open(item.accountId, consoleLink.health()) });
  }
  // Required tags: one informational finding per account/region/service with the resources missing any required key.
  if (requiredTags.length) {
    const rows = tagRows(data, requiredTags), groups = new Map<string, { accountId: string; region: string; service: Service; count: number; keys: Set<string> }>();
    metrics.tags = { compliant: rows.filter(row => row.status === 'compliant').length, missing: rows.filter(row => row.status === 'missing').length, unknown: rows.filter(row => row.status === 'unknown').length };
    for (const row of rows.filter(row => row.status === 'missing')) {
      const id = `${row.accountId}:${row.region}:${row.service}`, group = groups.get(id) ?? { accountId: row.accountId, region: row.region, service: row.service, count: 0, keys: new Set<string>() };
      group.count++; row.missing.forEach(keyName => group.keys.add(keyName)); groups.set(id, group);
    }
    for (const [id, group] of groups) add({ id: `tags:${id}`, severity: 'info', kind: 'tags', subject: group.service, detail: [...group.keys].join(', '), value: group.count, source: group.service, accountId: group.accountId, region: group.region });
  }
  if (dynamodb) metrics.dynamodb = { total: dynamodb.items.length, partial: dynamodb.partial };
  if (apigateway) metrics.apigateway = { total: apigateway.items.length, partial: apigateway.partial };
  if (series) {
    metrics.metricSeries = series.items.length;
    for (const item of series.items) {
      if (!item.metric || item.peak === undefined) continue;
      const rule = metricThresholds[item.metric], breach = (limit?: number) => limit !== undefined && (rule.direction === 'above' ? item.peak! >= limit : item.peak! < limit);
      const severity: Severity | undefined = breach(rule.critical) ? 'critical' : breach(rule.warning) ? 'warning' : breach(rule.info) ? 'info' : undefined;
      if (!severity) continue;
      const source = metricSource[item.metric], url = source === 'ec2' && item.id ? consoleLink.ec2(item.region, item.id) : source === 'rds' ? consoleLink.rds(item.region, item.name) : source === 'lambda' ? consoleLink.lambda(item.region, item.name)
        : source === 'elasticache' ? consoleLink.elasticache(item.region) : consoleLink.msk(item.region);
      add({ id: `metric:${item.metric}:${key(item)}`, severity, kind: 'metric', subject: item.name, detail: item.metric, source: 'metrics', ...at(item), link: open(item.accountId, url), metric: item.metric, value: item.peak });
    }
  }
  if (directory) {
    if (directory.accounts.status === 'collected') {
      metrics.accounts = { total: directory.accounts.items.length, active: directory.accounts.items.filter(item => item.lifecycle === 'ACTIVE').length, partial: directory.accounts.hasMore };
      directory.accounts.items.filter(item => item.lifecycle !== 'ACTIVE').forEach(item => add({ id: `account:${item.id}`, severity: item.lifecycle === 'UNKNOWN' ? 'info' : 'warning',
        kind: 'account', subject: `${item.name ?? item.id}`, detail: item.lifecycle, source: 'directory', accountId: item.id, link: consoleLink.account(item.id) }));
    } else add({ id: 'coverage:accounts', severity: 'info', kind: 'coverage', subject: 'Organizations', detail: directory.accounts.status, source: 'directory' });
    if (directory.organizationalUnits.status === 'collected') metrics.ous = directory.organizationalUnits.items.length;
  }
  const counts = { critical: 0, warning: 0, info: 0 } as Record<Severity, number>;
  findings.forEach(item => { counts[item.severity] += 1; });
  const anyRead = Boolean(directory || Object.values(data).some(Boolean));
  const order: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity] || a.subject.localeCompare(b.subject) || (a.accountId ?? '').localeCompare(b.accountId ?? ''));
  return { overall: !anyRead ? 'unknown' : counts.critical ? 'action' : counts.warning ? 'attention' : 'clear', findings, counts, metrics };
}
