import { z } from 'zod';
import { CloudOperationError } from '../../../../src/domain/cloud-workflow';
import type { ObservationCache } from '../../../observation-cache';
import { emailAddressSchema, sendMail, smtpConfigSchema, SmtpError, type MailMessage, type SmtpOptions } from '../../../smtp-mail';
import { alertEventSchema, type AlertEvent, type AlertStatus } from '../../../../src/modules/aws/domain/alerts';
import type { ReportSnapshot, SnapshotFinding } from '../../../../src/modules/aws/domain/report';
import { findingKindLabel, type Translate } from '../../../../src/modules/aws/organization/finding-labels';
import type { Finding } from '../../../../src/modules/aws/organization/operations-assessment';
import { resolvedVisibility } from '../../../../src/modules/aws/organization/report';

const validTimeZone = (value: string) => { try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; } };
/** Who receives alerts for one payer configuration. Recipients and wording are server settings; the browser cannot change them. */
export const emailRouteSchema = z.object({
  configurationId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/), to: z.array(emailAddressSchema).min(1).max(10),
  /** `warning` sends new action and attention items; `critical` only new action items. */
  minSeverity: z.enum(['critical', 'warning']).default('warning'),
  /** `summary` sends counts per kind only, without resource names, accounts or regions. */
  detail: z.enum(['full', 'summary']).default('full'),
  language: z.enum(['ko', 'en']).default('ko'), timeZone: z.string().max(64).refine(validTimeZone).default('UTC'),
}).strict();
export const emailNotificationsSchema = z.object({
  from: emailAddressSchema, smtp: smtpConfigSchema, routes: z.array(emailRouteSchema).min(1).max(100),
  /** Minimum gap between alert mails of one connection; items found meanwhile are sent with the next sync. */
  minIntervalMinutes: z.number().int().min(0).max(1440).default(0),
}).strict().refine(value => new Set(value.routes.map(route => route.configurationId)).size === value.routes.length, 'One route per configuration.');
export const notificationsSchema = z.object({ email: emailNotificationsSchema.optional() }).strict();
export type EmailNotifications = z.infer<typeof emailNotificationsSchema>;
type Route = z.infer<typeof emailRouteSchema>;

const knownSchema = z.object({ id: z.string().max(400), source: z.string().max(32), accountId: z.string().max(12).optional(), region: z.string().max(32).optional() }).strict();
const stateSchema = z.object({ initialized: z.boolean(), known: z.array(knownSchema).max(5000), lastSentAt: z.iso.datetime().optional(), lastTestAt: z.iso.datetime().optional(),
  history: z.array(alertEventSchema).max(20) }).strict();
type State = z.infer<typeof stateSchema>;
type Known = z.infer<typeof knownSchema>;
const rowLimit = 50, testGapMs = 60_000;
/** Read failures and coverage limits are about the collection itself; they are summarized, not alerted as items. */
const alertable = (finding: SnapshotFinding, route: Route) => finding.kind !== 'read-failed' && finding.kind !== 'coverage' && (finding.severity === 'critical' || route.minSeverity === 'warning' && finding.severity === 'warning');
const mask = (address: string) => { const [local, domain] = address.split('@') as [string, string]; return `${local.slice(0, 1)}•••@${domain}`; };
const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export type AlertSender = (message: MailMessage) => Promise<void>;
/** Host-side alerts after each finished sync. State lives next to the report history in the user's disk cache. Sending happens
 * outside any store transaction; a failed or deferred item is retried with the next sync while it is still present. */
export class EmailAlerts {
  private readonly config: EmailNotifications;
  private readonly cache: ObservationCache;
  private readonly labels: ReadonlyMap<string, string>;
  private readonly origin: string;
  private readonly now: () => number;
  private readonly send: AlertSender;
  private readonly queues = new Map<string, Promise<unknown>>();
  constructor(options: { config: unknown; cache: ObservationCache; labels: ReadonlyMap<string, string>; publicOrigin: string; now?: () => number; send?: AlertSender; smtp?: SmtpOptions }) {
    this.config = emailNotificationsSchema.parse(options.config); this.cache = options.cache; this.labels = options.labels; this.origin = options.publicOrigin; this.now = options.now ?? Date.now;
    this.send = options.send ?? (message => sendMail(this.config.smtp, message, options.smtp));
  }
  private route(configurationId: string) { return this.config.routes.find(route => route.configurationId === configurationId); }
  /** One alert operation at a time per user connection, so two polls finishing the same sync cannot send twice. */
  private serial<T>(scope: readonly string[], task: () => Promise<T>): Promise<T> {
    const key = JSON.stringify(scope), run = (this.queues.get(key) ?? Promise.resolve()).then(task, task);
    this.queues.set(key, run.catch(() => undefined)); return run;
  }
  private async state(scope: readonly string[]): Promise<State> {
    const parsed = stateSchema.safeParse(await this.cache.loadAlerts(scope).catch(() => undefined));
    return parsed.success ? parsed.data : { initialized: false, known: [], history: [] };
  }
  private async deliver(message: MailMessage): Promise<Pick<AlertEvent, 'outcome' | 'code'>> {
    try { await this.send(message); return { outcome: 'sent' }; } catch (error) { return { outcome: 'failed', code: error instanceof SmtpError ? error.code : 'smtp_failed' }; }
  }
  private record(state: State, event: AlertEvent): State { return { ...state, history: [event, ...state.history].slice(0, 20) }; }
  async status(scope: readonly string[], configurationId: string): Promise<AlertStatus> {
    const route = this.route(configurationId);
    if (!route) return { configured: false, recipients: [], history: [] };
    return { configured: true, recipients: route.to.map(mask), minSeverity: route.minSeverity, detail: route.detail, history: (await this.state(scope)).history };
  }
  /** Called once per recorded snapshot. The first one sends a baseline summary; later ones send only items not alerted before. */
  afterSnapshot(scope: readonly string[], configurationId: string, snapshot: ReportSnapshot): Promise<void> {
    const route = this.route(configurationId);
    if (!route) return Promise.resolve();
    return this.serial(scope, async () => {
      const state = await this.state(scope), at = new Date(this.now()).toISOString();
      const items = snapshot.findings.filter(finding => alertable(finding, route)), current = new Set(items.map(item => item.id));
      const visible = resolvedVisibility(snapshot), knownIds = new Set(state.known.map(item => item.id));
      // Keep a known item while it is present or while this sync could not see its place (an unverified disappearance is not a resolution).
      const kept = state.known.filter(item => current.has(item.id) || !visible(item));
      const fresh = state.initialized ? items.filter(item => !knownIds.has(item.id)) : items;
      const toKnown = (item: SnapshotFinding): Known => ({ id: item.id, source: item.source, ...(item.accountId ? { accountId: item.accountId } : {}), ...(item.region ? { region: item.region } : {}) });
      if (state.initialized && !fresh.length) { await this.cache.saveAlerts(scope, { ...state, known: kept }); return; }
      const kind = state.initialized ? 'digest' as const : 'baseline' as const;
      const gap = this.config.minIntervalMinutes * 60_000;
      if (state.initialized && gap && state.lastSentAt && this.now() - Date.parse(state.lastSentAt) < gap) {
        await this.cache.saveAlerts(scope, this.record({ ...state, known: kept }, { at, kind, outcome: 'deferred', count: fresh.length })); return;
      }
      const result = await this.deliver(this.message(route, configurationId, kind, snapshot, fresh));
      const sent = result.outcome === 'sent';
      // Unsent items stay unknown, so a failed or deferred mail is retried with the next sync while they are still present.
      const next: State = { ...state, initialized: state.initialized || sent, known: sent ? [...kept, ...fresh.map(toKnown)].slice(-5000) : kept, ...(sent ? { lastSentAt: at } : {}) };
      await this.cache.saveAlerts(scope, this.record(next, { at, kind, ...result, count: fresh.length }));
    });
  }
  /** Fixed wording without observations, to the configured recipients only; at most one per minute per connection. */
  test(scope: readonly string[], configurationId: string): Promise<AlertStatus> {
    const route = this.route(configurationId);
    if (!route) return Promise.reject(new CloudOperationError(409, 'alerts_not_configured', 'E-mail alerts are not configured for this payer.'));
    return this.serial(scope, async () => {
      const state = await this.state(scope), at = new Date(this.now()).toISOString();
      if (state.lastTestAt && this.now() - Date.parse(state.lastTestAt) < testGapMs) throw new CloudOperationError(429, 'alert_rate_limited', 'Wait a minute before sending another test.');
      const t = this.translate(route), label = this.labels.get(configurationId) ?? configurationId;
      const lines = [t('이메일 알림 설정을 확인하는 테스트 메일입니다. 계정·자원 정보는 포함하지 않습니다.', 'This is a test of the e-mail alert settings. It contains no account or resource information.'),
        `${t('Payer', 'Payer')}: ${label}`, `${t('보내는 항목', 'Sends')}: ${route.minSeverity === 'warning' ? t('새로 나타난 조치·주의 항목', 'new action and attention items') : t('새로 나타난 조치 항목', 'new action items')}`,
        `${t('대시보드', 'Dashboard')}: ${this.origin}/#/organization/aws/report`];
      const result = await this.deliver(this.mail(route, `[CloudOps Auto] ${t('테스트 메일', 'Test message')} — ${label}`, lines, []));
      await this.cache.saveAlerts(scope, this.record({ ...state, lastTestAt: at }, { at, kind: 'test', ...result, count: 0 }));
      if (result.outcome !== 'sent') throw new CloudOperationError(502, result.code ?? 'smtp_failed', 'The test message could not be sent.');
      return this.status(scope, configurationId);
    });
  }
  private translate(route: Route): Translate { return (ko, en) => route.language === 'ko' ? ko : en; }
  private message(route: Route, configurationId: string, kind: 'baseline' | 'digest', snapshot: ReportSnapshot, fresh: SnapshotFinding[]): MailMessage {
    const t = this.translate(route), label = this.labels.get(configurationId) ?? configurationId;
    const time = new Intl.DateTimeFormat(route.language === 'ko' ? 'ko-KR' : 'en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: route.timeZone, timeZoneName: 'short' }).format(new Date(snapshot.at));
    const severity = (item: SnapshotFinding) => item.severity === 'critical' ? t('조치', 'Action') : t('주의', 'Attention');
    const critical = fresh.filter(item => item.severity === 'critical').length, warning = fresh.length - critical;
    const failed = snapshot.findings.filter(item => item.kind === 'read-failed').length;
    const subject = kind === 'baseline' ? `[CloudOps Auto] ${label} — ${t('알림 시작', 'Alerts started')}: ${t('조치', 'action')} ${critical} · ${t('주의', 'attention')} ${warning}`
      : `[CloudOps Auto] ${label} — ${t('신규', 'new')} ${t('조치', 'action')} ${critical} · ${t('주의', 'attention')} ${warning}`;
    const lines = [
      `${t('Payer', 'Payer')}: ${label}`,
      `${t('동기화 완료', 'Sync finished')}: ${time}${snapshot.state === 'partial' ? ` (${t('일부 결과', 'partial')})` : ''}`,
      `${t('현재 판정', 'Current assessment')}: ${t('조치', 'action')} ${snapshot.counts.critical} · ${t('주의', 'attention')} ${snapshot.counts.warning} · ${t('참고', 'info')} ${snapshot.counts.info} · ${t('계정', 'accounts')} ${snapshot.accounts} (${t('접근 확인', 'verified')} ${snapshot.verified.length})`,
      ...(failed ? [t(`조회 실패 ${failed}곳: 일부 결과가 빠졌을 수 있습니다.`, `${failed} reads failed: some results may be missing.`)] : []),
      ...(snapshot.truncated ? [t('항목이 많아 일부만 기록됐습니다.', 'Too many items; only part was recorded.')] : []),
      kind === 'baseline' ? t(`알림을 시작합니다. 현재 조치·주의 항목 ${fresh.length}개를 기준으로 삼고, 다음 동기화부터 새로 나타난 항목만 보냅니다.`, `Alerts are starting. The current ${fresh.length} items are the baseline; later syncs send only new items.`)
        : t(`새로 나타난 항목 ${fresh.length}개`, `${fresh.length} new items`),
    ];
    const describe = (item: SnapshotFinding) => findingKindLabel({ kind: item.kind as Finding['kind'], ...(item.metric ? { metric: item.metric as Finding['metric'] } : {}), ...(item.eos ? { eos: item.eos as Finding['eos'] } : {}) }, t) ?? item.kind;
    const detail = (item: SnapshotFinding) => item.eos ? [item.eos.current, item.eos.date].filter(Boolean).join(' · ') : item.value !== undefined ? `${item.detail} ${item.value}` : item.detail;
    const rows = route.detail === 'summary'
      ? [...fresh.reduce((counts, item) => counts.set(`${severity(item)} · ${describe(item)}`, (counts.get(`${severity(item)} · ${describe(item)}`) ?? 0) + 1), new Map<string, number>())].map(([name, count]) => [name, String(count)])
      : fresh.slice(0, rowLimit).map(item => [severity(item), describe(item), item.subject, [item.accountId, item.region].filter(Boolean).join(' / ') || '—', detail(item)]);
    const more = route.detail === 'full' && fresh.length > rowLimit ? [t(`외 ${fresh.length - rowLimit}개는 대시보드에서 확인하세요.`, `See the dashboard for ${fresh.length - rowLimit} more.`)] : [];
    return this.mail(route, subject, [...lines, ...more, `${t('대시보드', 'Dashboard')}: ${this.origin}/#/organization/aws/report`], rows,
      route.detail === 'summary' ? [t('항목', 'Item'), t('개수', 'Count')] : [t('수준', 'Level'), t('항목', 'Item'), t('대상', 'Subject'), t('계정 / 리전', 'Account / region'), t('내용', 'Detail')]);
  }
  private mail(route: Route, subject: string, lines: string[], rows: string[][], header: string[] = []): MailMessage {
    const t = this.translate(route), footer = t('이 메일은 서버 설정에 따라 자동으로 보냈습니다. 동기화가 끝날 때 새로 나타난 항목만 보냅니다.', 'Sent automatically by the server configuration. Only items that are new at the end of a sync are sent.');
    const text = [...lines, '', ...rows.map(row => `- ${row.join(' · ')}`), '', footer].join('\n');
    const html = `<!doctype html><html><body style="font:14px/1.5 system-ui,sans-serif;color:#16191f">${lines.map(line => `<p style="margin:4px 0">${escape(line)}</p>`).join('')}
${rows.length ? `<table style="border-collapse:collapse;margin:12px 0"><thead><tr>${header.map(cell => `<th style="border:1px solid #d1d5db;padding:4px 8px;text-align:left;background:#f3f4f6">${escape(cell)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(cell => `<td style="border:1px solid #d1d5db;padding:4px 8px;vertical-align:top">${escape(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table>` : ''}
<p style="color:#5f6b7a;font-size:12px">${escape(footer)}</p></body></html>`;
    return { from: this.config.from, fromName: 'CloudOps Auto', to: route.to, subject, text, html };
  }
}
