import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { CloudOperationError } from '../src/domain/cloud-workflow';
import type { ReportSnapshot, SnapshotFinding } from '../src/modules/aws/domain/report';
import { EmailAlerts, emailNotificationsSchema } from './modules/aws/organization/organization-alerts';
import type { ObservationCache } from './observation-cache';
import type { MailMessage } from './smtp-mail';
import { SmtpError } from './smtp-mail';

const scope = ['synthetic-org', 'workspace-a', 'actor', 'connection', 'digest'];
const config = (route: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({ from: 'alerts@example.invalid', smtp: { host: 'smtp.example.invalid', port: 465, security: 'tls', username: 'alerts@example.invalid', passwordFile: '/synthetic/password' },
  routes: [{ configurationId: 'aws-read', to: ['ops@example.invalid', 'lead@example.invalid'], ...route }], ...extra });
const finding = (id: string, severity: SnapshotFinding['severity'], options: Partial<SnapshotFinding> = {}): SnapshotFinding => ({ id, severity, kind: 'alarm', subject: `synthetic-${id}`, detail: 'ALARM', source: 'alarms', accountId: '111111111111', region: 'ap-northeast-2', ...options });
const snapshot = (findings: SnapshotFinding[], options: Partial<ReportSnapshot> = {}): ReportSnapshot => ({ jobId: randomUUID(), at: '2026-10-11T00:00:00.000Z', state: 'completed', mode: 'direct', verified: ['111111111111'], accounts: 1,
  counts: { critical: findings.filter(item => item.severity === 'critical').length, warning: findings.filter(item => item.severity === 'warning').length, info: findings.filter(item => item.severity === 'info').length }, findings, truncated: false, ...options });
function fixture(options: { config?: unknown; fail?: () => boolean; now?: () => number } = {}) {
  const mails: MailMessage[] = []; let alerts: unknown;
  const cache = { loadAlerts: async () => alerts, saveAlerts: async (_scope: readonly string[], value: unknown) => { alerts = JSON.parse(JSON.stringify(value)); } } as unknown as ObservationCache;
  const service = new EmailAlerts({ config: options.config ?? config(), cache, labels: new Map([['aws-read', 'Synthetic payer']]), publicOrigin: 'http://127.0.0.1:5176', now: options.now,
    send: async message => { if (options.fail?.()) throw new SmtpError('smtp_auth_failed'); mails.push(message); } });
  return { service, mails, state: () => alerts as { known: Array<{ id: string }>; history: Array<{ kind: string; outcome: string; count: number; code?: string }> } };
}
const ids = (mail: MailMessage) => [...mail.text.matchAll(/synthetic-([a-z0-9-]+)/g)].map(match => match[1]);

test('the first sync sends a baseline; later syncs send only items not alerted before', async () => {
  const s = fixture();
  await s.service.afterSnapshot(scope, 'aws-read', snapshot([finding('a', 'critical'), finding('b', 'warning'), finding('c', 'info'), finding('r', 'warning', { kind: 'read-failed', subject: 'ec2', source: 'ec2' })]));
  assert.equal(s.mails.length, 1); assert.match(s.mails[0]!.subject, /알림 시작/); assert.deepEqual(ids(s.mails[0]!), ['a', 'b'], 'info items and read failures are not alerted as items');
  assert.match(s.mails[0]!.text, /조회 실패 1곳/); assert.deepEqual(s.mails[0]!.to, ['ops@example.invalid', 'lead@example.invalid']);
  await s.service.afterSnapshot(scope, 'aws-read', snapshot([finding('a', 'critical'), finding('b', 'warning')]));
  assert.equal(s.mails.length, 1, 'nothing new, nothing sent');
  await s.service.afterSnapshot(scope, 'aws-read', snapshot([finding('a', 'critical'), finding('b', 'warning'), finding('d', 'critical')]));
  assert.equal(s.mails.length, 2); assert.match(s.mails[1]!.subject, /신규 조치 1 · 주의 0/); assert.deepEqual(ids(s.mails[1]!), ['d']);
  assert.deepEqual(s.state().history.map(event => [event.kind, event.outcome, event.count]), [['digest', 'sent', 1], ['baseline', 'sent', 2]]);
});

test('an item that vanished where the sync could not see is not alerted again; a verified resolution is', async () => {
  const s = fixture();
  await s.service.afterSnapshot(scope, 'aws-read', snapshot([finding('a', 'critical'), finding('b', 'critical', { accountId: '222222222222' })], { verified: ['111111111111', '222222222222'], accounts: 2 }));
  // Account 222… was not verified this time and a's place had a read failure: both disappearances are unverified.
  await s.service.afterSnapshot(scope, 'aws-read', snapshot([finding('f', 'warning', { kind: 'read-failed', subject: 'alarms', source: 'ec2' }), finding('x', 'warning', { kind: 'read-failed', subject: 'alarms', source: 'alarms' })], { verified: ['111111111111'], accounts: 2 }));
  await s.service.afterSnapshot(scope, 'aws-read', snapshot([finding('a', 'critical'), finding('b', 'critical', { accountId: '222222222222' })], { verified: ['111111111111', '222222222222'], accounts: 2 }));
  assert.equal(s.mails.length, 1, 'reappearing after an unverified gap is not new');
  await s.service.afterSnapshot(scope, 'aws-read', snapshot([], { verified: ['111111111111', '222222222222'], accounts: 2 }));
  await s.service.afterSnapshot(scope, 'aws-read', snapshot([finding('a', 'critical')], { verified: ['111111111111', '222222222222'], accounts: 2 }));
  assert.equal(s.mails.length, 2); assert.deepEqual(ids(s.mails[1]!), ['a'], 'a verified resolution followed by a recurrence is alerted');
});

test('failed or deferred mail is retried with the next sync; summary mode omits names, accounts and regions', async () => {
  let failing = true, clock = Date.parse('2026-10-11T00:00:00Z');
  const s = fixture({ fail: () => failing, now: () => clock, config: config({ detail: 'summary', minSeverity: 'critical', language: 'en' }, { minIntervalMinutes: 30 }) });
  await s.service.afterSnapshot(scope, 'aws-read', snapshot([finding('a', 'critical'), finding('b', 'warning')]));
  assert.deepEqual(s.state().history[0], { at: '2026-10-11T00:00:00.000Z', kind: 'baseline', outcome: 'failed', count: 1, code: 'smtp_auth_failed' });
  failing = false; clock += 60_000;
  await s.service.afterSnapshot(scope, 'aws-read', snapshot([finding('a', 'critical'), finding('b', 'warning')]));
  assert.equal(s.mails.length, 1); assert.match(s.mails[0]!.subject, /Alerts started: action 1/);
  assert.doesNotMatch(s.mails[0]!.text + s.mails[0]!.html, /synthetic-|111111111111|ap-northeast-2/, 'summary detail carries counts per kind only');
  assert.match(s.mails[0]!.text, /Action · Alarm firing · 1/);
  clock += 60_000;
  await s.service.afterSnapshot(scope, 'aws-read', snapshot([finding('a', 'critical'), finding('c', 'critical')]));
  assert.equal(s.mails.length, 1); assert.equal(s.state().history[0]!.outcome, 'deferred');
  clock += 30 * 60_000;
  await s.service.afterSnapshot(scope, 'aws-read', snapshot([finding('a', 'critical'), finding('c', 'critical')]));
  assert.equal(s.mails.length, 2, 'the deferred item is sent once the interval has passed');
});

test('values are escaped in HTML, status masks recipients and the fixed test message is rate limited', async () => {
  let clock = 0; const s = fixture({ now: () => clock });
  await s.service.afterSnapshot(scope, 'aws-read', snapshot([finding('x', 'critical', { subject: '<img src=x onerror=alert(1)>' })]));
  assert.doesNotMatch(s.mails[0]!.html, /<img/); assert.match(s.mails[0]!.html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  const status = await s.service.status(scope, 'aws-read');
  assert.deepEqual(status.recipients, ['o•••@example.invalid', 'l•••@example.invalid']); assert.equal(status.configured, true);
  assert.deepEqual(await s.service.status(scope, 'other'), { configured: false, recipients: [], history: [] });
  await s.service.test(scope, 'aws-read'); assert.match(s.mails[1]!.subject, /테스트 메일 — Synthetic payer/); assert.doesNotMatch(s.mails[1]!.text, /synthetic-x|111111111111/);
  await assert.rejects(s.service.test(scope, 'aws-read'), (error: unknown) => error instanceof CloudOperationError && error.code === 'alert_rate_limited');
  clock += 61_000; await s.service.test(scope, 'aws-read'); assert.equal(s.mails.length, 3);
  await assert.rejects(s.service.test(scope, 'other'), (error: unknown) => error instanceof CloudOperationError && error.code === 'alerts_not_configured');
  assert.equal(emailNotificationsSchema.safeParse(config({ to: ['Ops <ops@example.invalid>'] })).success, false);
  assert.equal(emailNotificationsSchema.safeParse({ ...config(), routes: [...config().routes, ...config().routes] }).success, false, 'one route per configuration');
});
