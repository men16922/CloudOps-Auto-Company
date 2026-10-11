import { useMemo, useState } from 'react';
import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import ButtonDropdown from '@cloudscape-design/components/button-dropdown';
import Container from '@cloudscape-design/components/container';
import Header from '@cloudscape-design/components/header';
import LineChart from '@cloudscape-design/components/line-chart';
import type { PropertyFilterProps } from '@cloudscape-design/components/property-filter';
import SegmentedControl from '@cloudscape-design/components/segmented-control';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import type { TableProps } from '@cloudscape-design/components/table';
import { useLanguage } from '../../../i18n';
import type { AlertStatus } from '../domain/alerts';
import type { ReportSnapshot, SnapshotFinding } from '../domain/report';
import AlertPanel from './AlertPanel';
import ResourceTable, { type FilterField } from './ResourceTable';
import type { EosRow, EosStatus } from './lifecycle';
import { compareSnapshots, downloadText, reportHtml, reportMarkdown, type ReportDocument, type ReportScope, type ResolvedFinding } from './report';

// Validated pair (light and dark: CVD ΔE 8.9, normal-vision 20.9). Series are also named in the legend and tooltip.
const seriesColor = { critical: '#d91515', warning: '#b88a00' };
type Props = { snapshots?: ReportSnapshot[]; scope: ReportScope; scopeText: string; eos: EosRow[]; eosLabel: (status: EosStatus) => string;
  accountLabel: (id: string) => string; accountName: (id: string) => string | undefined; describe: (finding: SnapshotFinding) => { subject: string; detail: string };
  table: (id: string) => { query: PropertyFilterProps.Query; onQueryChange: (query: PropertyFilterProps.Query) => void };
  alerts?: AlertStatus; onTestAlert: () => Promise<string | undefined>; onRefreshAlerts: () => void };

/** Weekly/monthly operations report from the host's per-sync snapshots. Only what was collected is compared; read failures are never "resolved". */
export default function ReportView({ snapshots, scope, scopeText, eos, eosLabel, accountLabel, accountName, describe, table, alerts, onTestAlert, onRefreshAlerts }: Props) {
  const { t, locale } = useLanguage();
  const [period, setPeriod] = useState('7');
  const comparison = useMemo(() => snapshots ? compareSnapshots(snapshots, Number(period), scope) : undefined, [snapshots, period, scope]);
  const time = (value: string) => new Date(value).toLocaleString(locale), date = (value?: string) => value ? value.slice(0, 10) : '—';
  const level = (severity: SnapshotFinding['severity']) => severity === 'critical' ? t('조치', 'Action') : severity === 'warning' ? t('주의', 'Attention') : t('참고', 'Info');
  const where = (item: SnapshotFinding) => item.accountId ? `${accountName(item.accountId) ?? item.accountId}${item.region ? ` · ${item.region}` : ''}` : item.region ?? '—';
  const delta = (now: number, before?: number) => before === undefined ? t('비교 대상 없음', 'no comparison') : now === before ? t('변화 없음', 'no change') : now > before ? t(`이전 대비 +${now - before}`, `+${now - before} vs before`) : t(`이전 대비 −${before - now}`, `−${before - now} vs before`);
  const upcoming = useMemo(() => eos.filter(row => row.status === 'ended' || row.status === 'extended' || row.status === 'deprecated' || row.status === 'upcoming')
    .sort((a, b) => (a.date ?? '9999').localeCompare(b.date ?? '9999')), [eos]);
  const findingFields: FilterField<SnapshotFinding>[] = [{ key: 'level', label: t('수준', 'Level'), value: item => level(item.severity) }, { key: 'item', label: t('항목', 'Item'), value: item => `${describe(item).subject} ${describe(item).detail}` },
    { key: 'account', label: t('계정', 'Account'), value: item => item.accountId ? accountLabel(item.accountId) : undefined }, { key: 'region', label: t('리전', 'Region'), value: item => item.region }];
  const findingColumns: TableProps.ColumnDefinition<SnapshotFinding>[] = [
    { id: 'level', header: t('수준', 'Level'), width: 110, cell: item => <StatusIndicator type={item.severity === 'critical' ? 'error' : item.severity === 'warning' ? 'warning' : 'info'}>{level(item.severity)}</StatusIndicator> },
    { id: 'item', header: t('항목', 'Item'), minWidth: 260, cell: item => <div><Box fontWeight="bold">{describe(item).subject}</Box><Box color="text-body-secondary" fontSize="body-s">{describe(item).detail}</Box></div> },
    { id: 'where', header: t('계정 · 리전', 'Account · Region'), minWidth: 180, cell: where },
  ];
  const resolvedFields: FilterField<ResolvedFinding>[] = [...findingFields as FilterField<ResolvedFinding>[], { key: 'verdict', label: t('판정', 'Verdict'), value: item => item.verified ? t('해결', 'Resolved') : t('확인 불가', 'Unverified') }];
  const eosFields: FilterField<EosRow>[] = [{ key: 'account', label: t('계정', 'Account'), value: row => accountLabel(row.accountId) }, { key: 'region', label: t('리전', 'Region'), value: row => row.region },
    { key: 'name', label: t('자원', 'Resource'), value: row => row.name }, { key: 'component', label: t('구성 요소', 'Component'), value: row => row.component }, { key: 'status', label: t('지원 상태', 'Support state'), value: row => eosLabel(row.status) }];
  const daysLeft = (row: EosRow) => row.daysLeft === undefined ? '—' : row.daysLeft < 0 ? t(`${-row.daysLeft}일 지남`, `${-row.daysLeft} days ago`) : t(`${row.daysLeft}일`, `${row.daysLeft} days`);
  const retention = t('동기화가 끝날 때마다 호스트 디스크 캐시에 판정 결과를 기록합니다. 최근 48시간은 모두, 그 이전은 하루 1개씩 35일간 보관합니다.', 'Each finished sync records its assessment in the host disk cache: every sync from the last 48 hours, then one per day for 35 days.');

  const alertPanel = <AlertPanel status={alerts} onTest={onTestAlert} onRefresh={onRefreshAlerts} />;
  if (!comparison) return <SpaceBetween size="l"><Alert type="info" header={t('아직 리포트 기록이 없습니다', 'No report history yet')}>{t(`동기화가 끝나면 첫 기록이 생기고, 두 번째 동기화부터 변화(신규·해결)와 추이를 보여 줍니다. ${retention}`, `The first record is created when a sync finishes; changes (new and resolved) and trends appear from the second sync. ${retention}`)}</Alert>{alertPanel}</SpaceBetween>;
  const { latest, baseline, current, previous, added, resolved, trend } = comparison, verified = resolved.filter(item => item.verified);
  const periodText = t(`최근 ${period}일`, `Last ${period} days`);
  const baselineText = baseline ? t(`비교 기준: ${time(baseline.at)}${comparison.baselineShort ? ' (기록이 기간보다 짧아 가장 오래된 기록과 비교)' : ''}`, `Compared with ${time(baseline.at)}${comparison.baselineShort ? ' (history is shorter than the period; oldest record used)' : ''}`)
    : t('비교할 이전 동기화가 없습니다', 'No earlier sync to compare with');
  const notes = [
    ...(latest.state === 'partial' ? [t('최근 동기화에 일부 조회 실패가 있습니다. 실패한 영역의 항목은 해결로 보지 않습니다.', 'The latest sync had some read failures; items in those areas are not counted as resolved.')] : []),
    ...(comparison.approximate ? [t('기록에 저장된 항목 수 한도(1,500)를 넘어 범위를 적용한 수치는 최소값입니다.', 'A record exceeded the stored item limit (1,500); scoped counts are lower bounds.')] : []),
    t('신규·해결은 조치·주의 항목만 비교합니다. 참고 수준으로 낮아진 항목은 해결로 셉니다.', 'New and resolved compare action and attention items only; items lowered to info count as resolved.'),
    retention,
  ];
  const document = (): ReportDocument => ({
    title: t(`운영 리포트 · ${periodText}`, `Operations report · ${periodText}`),
    subtitle: [t(`최근 동기화: ${time(latest.at)} · 계정 ${latest.verified.length}/${latest.accounts} 접근 확인`, `Latest sync: ${time(latest.at)} · ${latest.verified.length}/${latest.accounts} accounts verified`), baselineText, t(`범위: ${scopeText}`, `Scope: ${scopeText}`), t(`작성: ${time(new Date().toISOString())}`, `Generated: ${time(new Date().toISOString())}`)],
    summary: [[t('조치', 'Action'), `${current.critical} (${delta(current.critical, previous?.critical)})`], [t('주의', 'Attention'), `${current.warning} (${delta(current.warning, previous?.warning)})`], [t('참고', 'Info'), String(current.info)],
      [t('신규 (조치·주의)', 'New (action/attention)'), String(added.length)], [t('해결 (확인됨)', 'Resolved (verified)'), String(verified.length)], [t('사라졌지만 확인 불가', 'Gone but unverified'), String(resolved.length - verified.length)]],
    sections: [
      { title: t('추이', 'Trend'), header: [t('동기화 시각', 'Sync time'), t('조치', 'Action'), t('주의', 'Attention'), t('참고', 'Info'), t('상태', 'State')], rows: trend.map(point => [time(point.at), String(point.counts.critical), String(point.counts.warning), String(point.counts.info), point.partial ? t('일부 실패', 'partial') : t('완료', 'completed')]) },
      { title: t('신규 항목', 'New items'), header: [t('수준', 'Level'), t('항목', 'Item'), t('내용', 'Detail'), t('계정 · 리전', 'Account · Region')], rows: added.map(item => [level(item.severity), describe(item).subject, describe(item).detail, where(item)]) },
      { title: t('해결된 항목', 'Resolved items'), note: t('확인 불가 = 최근 동기화에서 해당 계정·리전을 읽지 못해 해결 여부를 알 수 없음', 'Unverified = the latest sync could not read that account/region'), header: [t('판정', 'Verdict'), t('수준', 'Level'), t('항목', 'Item'), t('내용', 'Detail'), t('계정 · 리전', 'Account · Region')],
        rows: resolved.map(item => [item.verified ? t('해결', 'Resolved') : t('확인 불가', 'Unverified'), level(item.severity), describe(item).subject, describe(item).detail, where(item)]) },
      { title: t('수명주기(EOS) 일정', 'Lifecycle (EOS) schedule'), header: [t('기준일', 'Date'), t('남은 일수', 'Days left'), t('자원', 'Resource'), t('구성 요소', 'Component'), t('현재 버전', 'Current'), t('지원 상태', 'Support state'), t('계정 · 리전', 'Account · Region')],
        rows: upcoming.map(row => [date(row.date), daysLeft(row), row.name, row.component, row.current, eosLabel(row.status), `${accountName(row.accountId) ?? row.accountId} · ${row.region}`]) },
    ],
    notes,
  });
  const exportAs = (format: string) => {
    const doc = document(), stamp = new Date().toISOString().slice(0, 10);
    if (format === 'html') downloadText(`operations-report-${stamp}.html`, reportHtml(doc, locale), 'text/html;charset=utf-8');
    else downloadText(`operations-report-${stamp}.md`, reportMarkdown(doc), 'text/markdown;charset=utf-8');
  };
  const cards: Array<[string, string, string, string]> = [
    [t('조치', 'Action'), String(current.critical), delta(current.critical, previous?.critical), current.critical ? 'critical' : ''],
    [t('주의', 'Attention'), String(current.warning), delta(current.warning, previous?.warning), current.warning ? 'attention' : ''],
    [t('신규', 'New'), baseline ? String(added.length) : '—', t('조치·주의 항목', 'action/attention items'), added.length ? 'attention' : ''],
    [t('해결', 'Resolved'), baseline ? String(verified.length) : '—', resolved.length - verified.length ? t(`확인 불가 ${resolved.length - verified.length}`, `${resolved.length - verified.length} unverified`) : t('최근 동기화로 확인됨', 'confirmed by the latest sync'), ''],
    [t('동기화', 'Syncs'), String(trend.length), t(`마지막 ${time(latest.at)}`, `last ${time(latest.at)}`), latest.state === 'partial' ? 'attention' : ''],
  ];
  const points = (key: 'critical' | 'warning') => trend.map(point => ({ x: new Date(point.at), y: point.counts[key] }));
  // Several days: label day boundaries only (no repeated dates); within two days: label the time.
  const multiDay = trend.length > 1 && Date.parse(trend.at(-1)!.at) - Date.parse(trend[0]!.at) >= 2 * 86_400_000;
  const tick = (value: Date) => multiDay ? (value.getHours() || value.getMinutes() ? '' : value.toLocaleDateString(locale, { month: 'numeric', day: 'numeric' }))
    : value.toLocaleTimeString(locale, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  return <SpaceBetween size="l">
    <Container header={<Header variant="h2" description={`${baselineText} · ${t(`범위: ${scopeText}`, `Scope: ${scopeText}`)}`}
      actions={<SpaceBetween direction="horizontal" size="xs">
        <SegmentedControl selectedId={period} onChange={({ detail }) => setPeriod(detail.selectedId)} label={t('기간', 'Period')} options={[{ id: '7', text: t('7일', '7 days') }, { id: '30', text: t('30일', '30 days') }]} />
        <ButtonDropdown items={[{ id: 'markdown', text: t('Markdown (위키·이슈용)', 'Markdown (wiki/issue)') }, { id: 'html', text: t('HTML (인쇄·PDF용)', 'HTML (print/PDF)') }]} onItemClick={({ detail }) => exportAs(detail.id)}>{t('리포트 내보내기', 'Export report')}</ButtonDropdown>
      </SpaceBetween>}>{t(`운영 리포트 · ${periodText}`, `Operations report · ${periodText}`)}</Header>}>
      <div className="ops-metric-grid ops-eos-grid" aria-label={t('리포트 요약', 'Report summary')}>
        {cards.map(([title, value, detailText, severity]) => <div key={title} className={`account-state-card ${severity ? `account-state-${severity}` : ''}`}><span>{title}</span><strong>{value}</strong><span>{detailText}</span></div>)}
      </div>
    </Container>
    {notes.length > 2 ? <Alert type="warning">{notes.slice(0, -2).join(' ')}</Alert> : null}
    <Container header={<Header variant="h2" description={t('동기화별 조치·주의 항목 수 (범위 적용)', 'Action and attention items per sync (scope applied)')}>{t('추이', 'Trend')}</Header>}>
      {trend.length >= 2 ? <LineChart series={[{ title: t('조치', 'Action'), type: 'line', data: points('critical'), color: seriesColor.critical }, { title: t('주의', 'Attention'), type: 'line', data: points('warning'), color: seriesColor.warning }]}
        xScaleType="time" height={220} hideFilter yTitle={t('항목 수', 'Items')} ariaLabel={t('조치·주의 항목 추이', 'Action and attention trend')}
        xTickFormatter={tick} yTickFormatter={value => Number.isInteger(value) ? String(value) : ''}
        i18nStrings={{ legendAriaLabel: t('범례', 'Legend'), chartAriaRoleDescription: t('선 차트', 'line chart'), xAxisAriaRoleDescription: t('시간 축', 'time axis'), yAxisAriaRoleDescription: t('항목 수 축', 'item count axis') }} />
        : <Box textAlign="center" color="text-body-secondary">{t('추이는 이 기간에 동기화 기록이 2개 이상일 때 표시됩니다.', 'The trend appears once this period has two or more sync records.')}</Box>}
    </Container>
    <ResourceTable title={t('신규 항목', 'New items')} description={t('비교 기준 이후 새로 나타난 조치·주의 항목', 'Action and attention items that appeared since the comparison point')} items={added} trackBy={item => item.id}
      columns={findingColumns} fields={findingFields} exportName="report-new" {...table('report.added')}
      empty={<Box textAlign="center" color="text-body-secondary">{baseline ? t('새로 나타난 항목이 없습니다.', 'No new items.') : t('비교할 이전 동기화가 없습니다.', 'No earlier sync to compare with.')}</Box>} />
    <ResourceTable title={t('해결된 항목', 'Resolved items')} description={t('비교 기준에는 있었지만 최근 동기화에서 사라진 항목. 해당 계정·리전을 읽지 못했으면 확인 불가로 둡니다.', 'Items present at the comparison point but gone in the latest sync; unverified when that account/region could not be read.')}
      items={resolved} trackBy={item => item.id} fields={resolvedFields} exportName="report-resolved" {...table('report.resolved')}
      columns={[{ id: 'verdict', header: t('판정', 'Verdict'), width: 120, cell: item => item.verified ? <StatusIndicator type="success">{t('해결', 'Resolved')}</StatusIndicator> : <StatusIndicator type="pending">{t('확인 불가', 'Unverified')}</StatusIndicator> }, ...findingColumns as TableProps.ColumnDefinition<ResolvedFinding>[]]}
      empty={<Box textAlign="center" color="text-body-secondary">{baseline ? t('해결된 항목이 없습니다.', 'No resolved items.') : t('비교할 이전 동기화가 없습니다.', 'No earlier sync to compare with.')}</Box>} />
    <ResourceTable title={t('수명주기(EOS) 일정', 'Lifecycle (EOS) schedule')} description={t('현재 캐시 기준: 지원 종료·확장 지원·중단 및 90일 안에 종료되는 자원 (날짜순)', 'From the current cache: ended, extended, deprecated and ending within 90 days (by date)')}
      items={upcoming} trackBy={row => `${row.service}|${row.accountId}|${row.region}|${row.id ?? row.name}`} fields={eosFields} exportName="report-eos" {...table('report.eos')}
      empty={<Box textAlign="center" color="text-body-secondary">{t('종료되었거나 곧 종료되는 자원이 없습니다.', 'Nothing ended or ending soon.')}</Box>} columns={[
        { id: 'date', header: t('기준일', 'Date'), cell: row => date(row.date) }, { id: 'days', header: t('남은 일수', 'Days left'), cell: daysLeft },
        { id: 'name', header: t('자원', 'Resource'), cell: row => row.name }, { id: 'component', header: t('구성 요소', 'Component'), cell: row => `${row.component} ${row.current}` },
        { id: 'status', header: t('지원 상태', 'Support state'), cell: row => <StatusIndicator type={row.status === 'ended' ? 'error' : row.status === 'upcoming' ? 'info' : 'warning'}>{eosLabel(row.status)}</StatusIndicator> },
        { id: 'where', header: t('계정 · 리전', 'Account · Region'), cell: row => `${accountName(row.accountId) ?? row.accountId} · ${row.region}` },
      ]} />
    <Box color="text-body-secondary" fontSize="body-s">{notes.slice(-2).join(' ')}</Box>
    {alertPanel}
  </SpaceBetween>;
}
