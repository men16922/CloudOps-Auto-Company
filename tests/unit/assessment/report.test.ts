import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { ReportSnapshot, SnapshotFinding } from '../../../packages/contracts/aws/report';
import { compareSnapshots, reportHtml, reportMarkdown } from '../../../packages/assessment/report';
import { retainSnapshots } from '../../../apps/host/src/connections/report-snapshots';

const day = 86_400_000, base = Date.parse('2026-10-01T00:00:00.000Z');
const finding = (id: string, severity: SnapshotFinding['severity'], accountId: string, source = 'alarms', extra: Partial<SnapshotFinding> = {}): SnapshotFinding =>
  ({ id, severity, kind: 'alarm', subject: id, detail: 'ALARM', source, accountId, region: 'eu-west-1', ...extra });
const snapshot = (at: number, findings: SnapshotFinding[], verified: string[], extra: Partial<ReportSnapshot> = {}): ReportSnapshot => ({ jobId: randomUUID(), at: new Date(at).toISOString(), state: 'completed', mode: 'direct', verified, accounts: 2,
  counts: { critical: findings.filter(item => item.severity === 'critical').length, warning: findings.filter(item => item.severity === 'warning').length, info: findings.filter(item => item.severity === 'info').length }, findings, truncated: false, ...extra });

test('report comparison: new and resolved action/attention items, and disappearances in unread places are never resolved', () => {
  const first = snapshot(base, [finding('a', 'critical', '111111111111'), finding('b', 'warning', '222222222222'), finding('c', 'warning', '111111111111', 'rds'), finding('i', 'info', '111111111111')], ['111111111111', '222222222222']);
  const middle = snapshot(base + 4 * day, [finding('a', 'critical', '111111111111')], ['111111111111', '222222222222']);
  const latest = snapshot(base + 8 * day, [finding('a', 'critical', '111111111111'), finding('d', 'critical', '111111111111'),
    finding('read:rds:111111111111:eu-west-1', 'info', '111111111111', 'rds', { kind: 'read-failed', subject: 'rds', detail: 'read_access_denied' })], ['111111111111'], { state: 'partial' });
  const week = compareSnapshots([latest, first, middle], 7, { accounts: [], regions: [] })!;
  assert.equal(week.baseline?.jobId, first.jobId); assert.equal(week.baselineShort, false);
  assert.deepEqual(week.added.map(item => item.id), ['d']);
  assert.deepEqual(week.resolved.map(item => [item.id, item.verified]), [['b', false], ['c', false]], 'lost account access and a failed read keep items unverified');
  assert.equal(week.persisting, 1); assert.deepEqual(week.current, latest.counts); assert.deepEqual(week.previous, first.counts);
  assert.deepEqual(week.trend.map(point => point.at), [first.at, middle.at, latest.at]);
  const later = compareSnapshots([first, middle], 7, { accounts: [], regions: [] })!;
  assert.deepEqual(later.resolved.map(item => [item.id, item.verified]), [['b', true], ['c', true]], 'gone while still readable = resolved');
  const month = compareSnapshots([first, middle, latest], 30, { accounts: [], regions: [] })!;
  assert.equal(month.baseline?.jobId, first.jobId); assert.equal(month.baselineShort, true, 'history shorter than the period uses the oldest record');
  const scoped = compareSnapshots([first, latest], 7, { accounts: ['222222222222'], regions: [] })!;
  assert.deepEqual([scoped.current.critical, scoped.previous?.warning, scoped.added.length], [0, 1, 0]);
  assert.equal(compareSnapshots([first], 7, { accounts: [], regions: [] })!.baseline, undefined);
  assert.equal(compareSnapshots([], 7, { accounts: [], regions: [] }), undefined);
});

test('report retention keeps recent syncs, then one per day, and drops records older than 35 days', () => {
  const now = base + 40 * day, at = (offset: number) => snapshot(now - offset, [], []);
  const kept = retainSnapshots([at(1_000), at(3_600_000), at(30 * 3_600_000), at(5 * day + 1_000), at(5 * day + 2_000), at(5 * day + 3_000), at(36 * day)], now);
  assert.deepEqual(kept.map(item => now - Date.parse(item.at)), [5 * day + 1_000, 30 * 3_600_000, 3_600_000, 1_000]);
});

test('report documents escape every value (Markdown and self-contained HTML)', () => {
  const document = { title: 'Report <b>', subtitle: ['scope | all'], summary: [['Action', '1'] as [string, string]], notes: ['note'],
    sections: [{ title: 'New', header: ['Item'], rows: [['# bad | <script>alert(1)</script>']] }] };
  const markdown = reportMarkdown(document);
  assert.ok(markdown.includes('| \\# bad \\| <script>alert(1)</script> |'), 'table separators and leading markup are escaped');
  const html = reportHtml(document, 'ko');
  assert.ok(!html.includes('<script>') && html.includes('&lt;script&gt;alert(1)&lt;/script&gt;') && html.includes('Report &lt;b&gt;'));
  assert.ok(html.includes("default-src 'none'"), 'the exported page loads nothing and runs nothing');
});
