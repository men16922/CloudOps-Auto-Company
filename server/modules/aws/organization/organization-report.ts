import type { InventoryUnit, SyncJob } from '../../../../src/modules/aws/domain/inventory';
import { reportSnapshotSchema, type ReportSnapshot, type SnapshotFinding } from '../../../../src/modules/aws/domain/report';
import { assessOperations, serviceData, type Service } from '../../../../src/modules/aws/organization/operations-assessment';

const findingLimit = 1500, day = 86_400_000;
/** Retention: every snapshot of the last 48 hours (at most 24), then the last one per UTC day, for 35 days and within a byte budget. */
export const reportRetention = { recentHours: 48, recent: 24, days: 35, bytes: 6_000_000 };

/** Assessment of one finished sync from exactly that job's units, with the same rules the dashboard uses. */
export function reportSnapshot(job: SyncJob, units: InventoryUnit[], requiredTags: readonly string[] = []): ReportSnapshot {
  const grouped: Partial<Record<Service, InventoryUnit[]>> = {};
  for (const unit of units) (grouped[unit.service] ??= []).push(unit);
  const at = job.finishedAt ?? job.startedAt, assessment = assessOperations(undefined, serviceData(grouped), undefined, Date.parse(at), requiredTags);
  // Findings are already ordered action → attention → info, so a cut drops informational items first.
  const findings: SnapshotFinding[] = assessment.findings.slice(0, findingLimit).map(({ link: _, ...finding }) => ({ ...finding, subject: finding.subject.slice(0, 300), detail: finding.detail.slice(0, 300) }));
  return reportSnapshotSchema.parse({ jobId: job.jobId, at, state: job.state, mode: job.mode, verified: job.accounts.filter(account => account.access === 'verified').map(account => account.accountId),
    accounts: job.accounts.length, counts: assessment.counts, findings, truncated: assessment.findings.length > findingLimit });
}

/** Keeps the history bounded: recent syncs in full, older ones as one per day, oldest dropped first. */
export function retainSnapshots(list: readonly ReportSnapshot[], now: number): ReportSnapshot[] {
  const sorted = [...new Map(list.map(item => [item.jobId, item])).values()].filter(item => Date.parse(item.at) >= now - reportRetention.days * day).sort((a, b) => a.at.localeCompare(b.at));
  const recentFrom = now - reportRetention.recentHours * 3_600_000, recent = sorted.filter(item => Date.parse(item.at) >= recentFrom).slice(-reportRetention.recent);
  const daily = new Map<string, ReportSnapshot>();
  for (const item of sorted.filter(item => Date.parse(item.at) < recentFrom)) daily.set(item.at.slice(0, 10), item);
  const kept = [...daily.values(), ...recent];
  while (kept.length > 1 && JSON.stringify(kept).length > reportRetention.bytes) kept.shift();
  return kept;
}
