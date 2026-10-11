import type { InventoryUnit } from '../domain/inventory';
import type { Located, Service, ServiceData } from './operations-assessment';

/** Resource services checked for the organization's required tag keys. */
export const taggedServices: Service[] = ['ec2', 'eks', 'rds', 'elasticache', 'msk', 'lambda', 'dynamodb', 'apigateway'];
export type TagStatus = 'compliant' | 'missing' | 'unknown';
export type TagRow = Located & { service: Service; status: TagStatus; missing: string[] };

/** Tag keys are case-sensitive in AWS. A resource whose tags were not collected stays unknown (never compliant or missing). */
export function tagRows(data: Partial<Record<Service, ServiceData>>, required: readonly string[]): TagRow[] {
  return taggedServices.flatMap(service => (data[service]?.items ?? []).map(item => {
    const missing = item.tags ? required.filter(key => !item.tags!.includes(key)) : [];
    return { ...item, service, missing, status: !item.tags ? 'unknown' as const : missing.length ? 'missing' as const : 'compliant' as const };
  }));
}

/** GuardDuty numeric severity: 9.0–10.0 critical, 7.0–8.9 high (lower severities are not read). */
export const guardDutyLevel = (value?: number) => value === undefined ? undefined : value >= 9 ? 'CRITICAL' : value >= 7 ? 'HIGH' : value >= 4 ? 'MEDIUM' : 'LOW';

export type CoverageState = 'enabled' | 'not-enabled' | 'failed' | 'not-collected';
export type CoverageRow = { accountId: string; region: string; securityhub: CoverageState; guardduty: CoverageState; hubFindings: number; guardFindings: number; partial: boolean };
const coverageOf = (unit?: InventoryUnit): CoverageState => !unit ? 'not-collected' : !unit.code ? 'enabled' : unit.code === 'read_not_enabled' ? 'not-enabled' : 'failed';

/** Security Hub and GuardDuty state per account and region that was read. */
export function securityCoverage(data: Partial<Record<Service, ServiceData>>): CoverageRow[] {
  const key = (unit: InventoryUnit) => `${unit.accountId}|${unit.region}`, hub = new Map((data.securityhub?.units ?? []).map(unit => [key(unit), unit])), guard = new Map((data.guardduty?.units ?? []).map(unit => [key(unit), unit]));
  return [...new Set([...hub.keys(), ...guard.keys()])].sort().map(id => {
    const [accountId, region] = id.split('|') as [string, string], h = hub.get(id), g = guard.get(id);
    return { accountId, region, securityhub: coverageOf(h), guardduty: coverageOf(g), hubFindings: h?.items.length ?? 0, guardFindings: g?.items.length ?? 0, partial: Boolean(h?.hasMore || g?.hasMore) };
  });
}

/** Health event severity: open issues and scheduled changes need attention; account notifications are informational. */
export const healthSeverity = (item: Located) => item.version === 'accountNotification' ? 'info' as const : 'warning' as const;
