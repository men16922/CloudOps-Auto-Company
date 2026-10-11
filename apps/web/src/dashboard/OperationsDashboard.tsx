import { useEffect, useMemo, useState, type ReactNode } from 'react';
import Alert from '@cloudscape-design/components/alert';
import Badge from '@cloudscape-design/components/badge';
import BarChart from '@cloudscape-design/components/bar-chart';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Container from '@cloudscape-design/components/container';
import Header from '@cloudscape-design/components/header';
import Link from '@cloudscape-design/components/link';
import Multiselect from '@cloudscape-design/components/multiselect';
import type { PropertyFilterProps } from '@cloudscape-design/components/property-filter';
import PieChart from '@cloudscape-design/components/pie-chart';
import ProgressBar from '@cloudscape-design/components/progress-bar';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator, { type StatusIndicatorProps } from '@cloudscape-design/components/status-indicator';
import Table, { type TableProps } from '@cloudscape-design/components/table';
import Tabs from '@cloudscape-design/components/tabs';
import { useLanguage } from '../i18n';
import type { DirectorySnapshot } from '../../../../packages/contracts/aws/directory';
import type { InventoryUnit, SyncSummary } from '../../../../packages/contracts/aws/inventory';
import type { ReportSnapshot, SnapshotFinding } from '../../../../packages/contracts/aws/report';
import type { RunbookCommand, RunbookState } from '../../../../packages/contracts/aws/runbooks';
import RunbooksView from './RunbooksView';
import type { SavedQuery, SavedView, SavedViewInput } from '../../../../packages/contracts/aws/saved-views';
import type { DashboardView } from './AccountDashboard';
import DirectoryPanel from './DirectoryPanel';
import ReportView from './ReportView';
import ResourceTable, { emptyQuery, type FilterField } from './ResourceTable';
import SavedViews from './SavedViews';
import { assessOperations, consoleLink, metricThresholds, serviceData, type Finding, type Located, type MetricId, type Service } from '../../../../packages/assessment/operations-assessment';
import { findingKindLabel, metricLabel as metricLabelOf } from '../../../../packages/assessment/finding-labels';
import { lambdaRuntimeStatus, lifecycleCapturedAt, lifecycleRows, upcomingWindowDays, type EosRow, type EosStatus } from '../../../../packages/assessment/eos-rules';
import { guardDutyLevel, securityCoverage, tagRows, type CoverageRow, type CoverageState, type TagRow, type TagStatus } from '../../../../packages/assessment/governance';

type Props = { view: DashboardView; viewHref: (view: DashboardView) => string; pageTitle: (view: DashboardView) => string; connected: boolean;
  report?: ReportSnapshot[]; views: SavedView[]; onSaveView: (view: SavedViewInput) => Promise<boolean>; onDeleteView: (id: string) => Promise<boolean>; busy: boolean; portal?: { startUrl: string; roleName: string }; requiredTags?: readonly string[];
  runbooks?: RunbookState; onRunbookCommand: (command: RunbookCommand) => Promise<string | undefined>; onRefreshRunbooks: () => void; payer: { accountId: string; region: string };
  sync?: SyncSummary; syncEveryMinutes?: number; units: Partial<Record<Service, InventoryUnit[]>>; directory?: DirectorySnapshot; hasDirectoryScope: boolean;
  onSync: () => void; onReadDirectory: () => void; onNavigate: (cursor: string) => void };
const tone: Record<Finding['severity'], StatusIndicatorProps.Type> = { critical: 'error', warning: 'warning', info: 'info' };
// Status hues (validated: CVD and normal-vision separation pass). The neutral gray is the "no data / stopped" status and always carries a label.
const statusColor = { critical: '#d91515', neutral: '#8d99a8', positive: '#037f0c', info: '#0972d3' };
const cpuMetrics: Array<[MetricId, string]> = [['ec2_cpu', 'EC2'], ['rds_cpu', 'RDS'], ['cache_cpu', 'ElastiCache'], ['msk_cpu', 'MSK']];
const resourceServices: Service[] = ['ec2', 'eks', 'rds', 'elasticache', 'msk', 'lambda', 'dynamodb', 'apigateway'];
const serviceLabel: Partial<Record<Service, string>> = { ec2: 'EC2', eks: 'EKS', rds: 'RDS', elasticache: 'ElastiCache', msk: 'MSK', lambda: 'Lambda', dynamodb: 'DynamoDB', apigateway: 'API Gateway' };
/** Identity Center shortcut link: opens the console URL in the resource's account with the user's own permission set. */
const shortcut = (startUrl: string, accountId: string, roleName: string, url: string) => `${startUrl.replace(/\/?$/, '/')}#/console?account_id=${encodeURIComponent(accountId)}&role_name=${encodeURIComponent(roleName)}&destination=${encodeURIComponent(url)}`;

/** Read-only operations views over the cached multi-account inventory. Status is derived only from collected evidence. */
export default function OperationsDashboard(props: Props) {
  const { view, viewHref, pageTitle, connected, busy, portal, requiredTags = [], sync, syncEveryMinutes, units, directory, hasDirectoryScope, onSync, onReadDirectory, onNavigate, report, views, onSaveView, onDeleteView, runbooks, onRunbookCommand, onRefreshRunbooks, payer } = props;
  const { t, locale } = useLanguage();
  const [accountScope, setAccountScope] = useState<string[]>([]), [regionScope, setRegionScope] = useState<string[]>([]);
  const [serverlessTab, setServerlessTab] = useState('lambda'), [ssmTab, setSsmTab] = useState('nodes'), [securityTab, setSecurityTab] = useState('securityhub'), [allFindings, setAllFindings] = useState(false);
  // Search conditions per table (`<page>.<table>`), kept here so a saved view can restore them.
  const [queries, setQueries] = useState<Record<string, PropertyFilterProps.Query>>({});
  const table = (id: string) => ({ query: queries[id] ?? emptyQuery, onQueryChange: (query: PropertyFilterProps.Query) => setQueries(previous => ({ ...previous, [id]: query })) });
  const reportScope = useMemo(() => ({ accounts: accountScope, regions: regionScope }), [accountScope, regionScope]);
  useEffect(() => { window.scrollTo?.({ top: 0 }); }, [view]);
  const accountNames = useMemo(() => new Map((sync?.accounts ?? []).filter(account => account.name).map(account => [account.accountId, account.name!])), [sync]);
  const accountLabel = (id: string) => accountNames.get(id) ? `${accountNames.get(id)} (${id})` : id;
  const allUnits = useMemo(() => Object.values(units).flat(), [units]);
  const accountOptions = useMemo(() => [...new Set([...(sync?.accounts ?? []).map(account => account.accountId), ...allUnits.map(unit => unit.accountId)])].sort().map(id => ({ value: id, label: accountLabel(id) })), [sync, allUnits, accountNames]);
  // AWS Health is account-wide (read from us-east-1), so it follows the account scope only.
  const regionOptions = useMemo(() => [...new Set(allUnits.filter(unit => unit.service !== 'health').map(unit => unit.region))].sort().map(region => ({ value: region, label: region })), [allUnits]);
  const keep = (unit: InventoryUnit) => (!accountScope.length || accountScope.includes(unit.accountId)) && (unit.service === 'health' || !regionScope.length || regionScope.includes(unit.region));
  const data = serviceData(units, keep);
  const open = (accountId: string, url: string) => portal ? shortcut(portal.startUrl, accountId, portal.roleName, url) : url;
  const assessment = assessOperations(directory, data, open, Date.now(), requiredTags), m = assessment.metrics;
  const time = (value?: string) => value ? new Date(value).toLocaleString(locale) : t('수집 안 됨', 'Not collected');
  const items = (service: Service) => data[service]?.items ?? [];
  const collected = (service: Service) => Boolean(data[service]);
  const notCollected = t('수집 안 됨', 'Not collected');
  const errorLabel = (code?: string) => !code ? '' : ({ read_access_denied: t('권한 없음(IAM)', 'Not permitted (IAM)'), read_throttled: t('AWS 요청 제한', 'AWS throttling'), read_timeout: t('시간 초과', 'Timed out'),
    read_invalid_result: t('응답 확인 실패', 'Unverifiable response'), read_not_enabled: t('사용 안 함', 'Not enabled'), read_not_subscribed: t('지원 플랜 필요', 'Support plan required') } as Record<string, string>)[code] ?? t('조회 실패', 'Read failed');
  const metricOf = (id: MetricId, item: Located, name = item.id ?? item.name) => data.metrics?.items.find(entry => entry.metric === id && entry.accountId === item.accountId && entry.region === item.region && entry.name === name);
  const formatMetric = (id: MetricId, value?: number) => value === undefined ? '—' : metricThresholds[id].unit === 'percent' ? `${value.toFixed(1)}%`
    : metricThresholds[id].unit === 'bytes' ? `${(value / 1024 ** 3).toFixed(1)} GiB` : String(Math.round(value));
  const metricCell = (id: MetricId, item: Located, name?: string) => collected('metrics') ? formatMetric(id, metricOf(id, item, name)?.peak) : notCollected;
  const state = (value?: string) => { const lower = value?.toLowerCase();
    const type: StatusIndicatorProps.Type = !lower ? 'pending' : ['available', 'active', 'running', 'ok', 'online', 'compliant', 'success'].includes(lower) ? 'success' : lower === 'stopped' ? 'stopped'
      : lower.includes('fail') || lower.startsWith('incompatible') || lower === 'storage-full' || lower === 'alarm' || lower === 'non_compliant' || lower === 'connectionlost' || lower === 'timedout' ? 'error' : 'in-progress';
    return <StatusIndicator type={type}>{value ?? t('확인 안 됨', 'Unknown')}</StatusIndicator>; };
  const support = (item: Located) => item.support === 'STANDARD_SUPPORT' ? <StatusIndicator type="success">{t('표준 지원', 'Standard support')}</StatusIndicator>
    : item.support === 'EXTENDED_SUPPORT' ? <StatusIndicator type="warning">{t('확장 지원(추가 요금)', 'Extended support (extra cost)')}</StatusIndicator>
    : item.support === 'UNSUPPORTED' ? <StatusIndicator type="error">{t('지원 종료', 'Unsupported')}</StatusIndicator> : <StatusIndicator type="pending">{item.version ? t('확인 안 됨', 'Unknown') : t('상세 미수집', 'Details not collected')}</StatusIndicator>;
  const overall = { action: { type: 'error' as const, label: t('조치 필요', 'Action needed') }, attention: { type: 'warning' as const, label: t('주의', 'Attention') },
    clear: { type: 'success' as const, label: t('수집 범위에서 이상 없음', 'No issues in collected scope') }, unknown: { type: 'pending' as const, label: t('수집 전', 'Not collected') } }[assessment.overall];
  const metricLabel = (id: MetricId) => metricLabelOf(id, t);
  const kindLabel = (finding: Finding) => findingKindLabel(finding, t);
  const nextStep = (finding: Finding) => {
    if (finding.kind === 'metric') return finding.metric === 'ec2_status' ? t('인스턴스 상태 검사를 확인하고 필요하면 중지/시작 또는 복구하세요.', 'Check the status checks; stop/start or recover if needed.')
      : finding.metric === 'rds_storage' ? t('저장공간 자동 확장 여부와 증가 추세를 확인하세요.', 'Check storage autoscaling and the growth trend.')
      : finding.metric === 'lambda_errors' ? t('함수 로그에서 오류 원인을 확인하세요.', 'Check the function logs for the error cause.')
      : t('지속적인 부하인지 확인하고 용량·스케일링을 검토하세요.', 'Confirm whether the load is sustained and review capacity/scaling.');
    return ({ alarm: t('경보 지표와 최근 배포·변경을 확인하고 담당자에게 인계하세요.', 'Check the alarm metric and recent changes, then hand off to the owner.'),
      'alarm-data': t('지표가 수집되는지, 대상 자원이 남아 있는지 확인하세요.', 'Check that the metric is still emitted and the target resource exists.'),
      eos: !finding.eos ? '' : finding.eos.component === 'EKS' ? t('클러스터 업그레이드 계획을 세우세요. 확장 지원은 추가 요금이 발생하고, 지원 종료 버전은 AWS가 자동 업그레이드합니다.', 'Plan a cluster upgrade. Extended support costs extra; unsupported versions are upgraded by AWS.')
        : finding.eos.component === 'RDS' ? t('메이저 버전 업그레이드를 계획하세요. RDS 확장 지원은 vCPU 시간당 추가 요금이 발생합니다.', 'Plan a major version upgrade. RDS Extended Support is billed per vCPU-hour.')
        : finding.eos.component === 'Lambda' ? t('지원 런타임으로 업그레이드하세요. 업데이트 차단일 이후에는 함수 코드를 수정할 수 없습니다.', 'Upgrade to a supported runtime; after the update-block date the function code cannot be updated.')
        : finding.eos.component === 'ElastiCache' ? t('Valkey 또는 지원 버전으로 업그레이드하세요. 확장 지원 기간에는 추가 요금이 발생합니다.', 'Upgrade to Valkey or a supported version; Extended Support is billed.')
        : finding.eos.component === 'MSK' ? t('지원 Kafka 버전으로 업그레이드하세요.', 'Upgrade to a supported Kafka version.') : t('지원 운영체제로 이전 계획을 세우세요.', 'Plan a migration to a supported operating system.'),
      account: t('Organizations에서 계정 수명주기와 결제 상태를 확인하세요.', 'Check the account lifecycle and billing state in Organizations.'),
      instance: t('계속 필요한지, 연결된 EBS 비용이 남는지 확인하세요.', 'Confirm the instance is still needed and review attached EBS cost.'),
      coverage: t('권한 또는 조회 범위를 확인하세요.', 'Check permissions or the configured scope.'),
      'resource-state': t('AWS 콘솔에서 이벤트와 최근 변경을 확인하세요.', 'Check events and recent changes in the AWS console.'), metric: '',
      'ssm-unmanaged': t('SSM Agent와 인스턴스 프로파일(AmazonSSMManagedInstanceCore)을 확인하세요. 패치·인벤토리·세션 관리가 불가능합니다.', 'Check the SSM Agent and instance profile (AmazonSSMManagedInstanceCore); patching, inventory and sessions are unavailable.'),
      'ssm-lost': t('인스턴스 상태와 네트워크(SSM 엔드포인트) 연결을 확인하세요.', 'Check the instance state and network path to the SSM endpoints.'),
      patch: t('Patch Manager 기준선과 유지 관리 기간을 확인하고 패치를 적용하세요.', 'Review the Patch Manager baseline and maintenance window, then patch.'),
      automation: t('실행 단계의 오류를 확인하고 원인 해결 후 다시 실행하세요.', 'Check the failed step output, fix the cause and run again.'),
      'read-failed': t('이 계정·리전에서 연결된 역할의 IAM 권한을 확인하세요. 이 영역은 정상으로 간주하지 않습니다.', 'Check the connected role’s IAM permissions in this account/region. This area is not assumed healthy.'),
      'security-hub': t('결과를 담당자에게 배정하고 해결 후 워크플로 상태를 RESOLVED로 바꾸세요. 억제는 예외 승인 후에만 하세요.', 'Assign the findings to an owner and set the workflow to RESOLVED once fixed; suppress only with an approved exception.'),
      guardduty: t('영향받은 자원을 격리하고 결과의 권장 조치를 따르세요. 오탐이면 억제 규칙을 검토하세요.', 'Isolate the affected resource and follow the finding’s remediation; review a suppression rule if it is a false positive.'),
      'security-off': t('조직 위임 관리자 계정에서 이 리전에 활성화하세요(추가 요금 발생). 사용하지 않는 리전이면 VPC 태그를 정리하세요.', 'Enable it for this region from the delegated administrator account (billed). If the region is unused, clean up the VPC tags.'),
      tags: t('필수 태그를 추가하세요. Organizations 태그 정책으로 새 자원에 강제할 수 있습니다.', 'Add the required tags; an Organizations tag policy can enforce them on new resources.'),
      health: t('이벤트 세부 정보와 영향받는 자원을 확인하고 예정일 전에 조치하세요.', 'Check the event details and affected resources, and act before the scheduled date.') } as Record<Finding['kind'], string>)[finding.kind];
  };
  const eosLabel = (status: EosStatus) => ({ ended: t('지원 종료', 'Ended'), extended: t('확장 지원(추가 요금)', 'Extended support (extra cost)'), deprecated: t('지원 중단(패치 없음)', 'Deprecated (no patches)'),
    upcoming: t('종료 예정', 'Ending soon'), supported: t('지원 중', 'Supported'), unknown: t('확인 불가', 'Unknown') })[status];
  const eosIndicator = (status: EosStatus) => <StatusIndicator type={status === 'ended' ? 'error' : status === 'extended' || status === 'deprecated' ? 'warning' : status === 'upcoming' ? 'info' : status === 'supported' ? 'success' : 'pending'}>{eosLabel(status)}</StatusIndicator>;
  const dateOnly = (value?: string) => value ? value.slice(0, 10) : '—';
  const pieStrings = { detailsValue: t('값', 'Value'), detailsPercentage: t('비율', 'Percentage'), filterLabel: t('범례 필터', 'Filter displayed data'), filterPlaceholder: t('데이터 필터', 'Filter data'),
    filterSelectedAriaLabel: t('선택됨', 'selected'), legendAriaLabel: t('범례', 'Legend'), chartAriaRoleDescription: t('도넛 차트', 'donut chart'), segmentAriaRoleDescription: t('구간', 'segment') };
  const barStrings = { filterLabel: t('범례 필터', 'Filter displayed data'), filterPlaceholder: t('데이터 필터', 'Filter data'), filterSelectedAriaLabel: t('선택됨', 'selected'),
    legendAriaLabel: t('범례', 'Legend'), chartAriaRoleDescription: t('막대 차트', 'bar chart'), yTickFormatter: (value: number) => Number.isInteger(value) ? String(value) : '' };
  const widget = (title: string, counter: string | undefined, target: DashboardView, footer: string, body: ReactNode, wide: boolean | 'full' = false) =>
    <div className={wide === 'full' ? 'ops-widget-full' : wide ? 'ops-widget-wide' : undefined}><Container fitHeight header={<Header variant="h2" counter={counter} actions={<Link href={viewHref(target)}>{t('자세히 보기', 'View details')}</Link>}>{title}</Header>}
      footer={<Box color="text-body-secondary" fontSize="body-s">{footer}</Box>}>{body}</Container></div>;
  const miniList = (rows: Array<{ key: string; name: ReactNode; detail?: string; status: ReactNode }>) => <ul className="ops-mini-list">{rows.map(row =>
    <li key={row.key}><span className="ops-mini-name">{row.name}{row.detail ? <Box variant="small" color="text-body-secondary">{row.detail}</Box> : null}</span>{row.status}</li>)}</ul>;
  const empty = (service: Service | undefined, none: string) => <Box textAlign="center" color="text-body-secondary">{service && !collected(service) ? notCollected : none}</Box>;
  const counter = (service: Service) => collected(service) ? `(${items(service).length}${data[service]!.partial ? '+' : ''})` : undefined;
  const source = (service: Service) => { const list = data[service]?.units; if (!list?.length) return notCollected;
    const latest = list.reduce((value, unit) => unit.collectedAt > value ? unit.collectedAt : value, list[0]!.collectedAt);
    return t(`${time(latest)} · 계정 ${new Set(list.map(unit => unit.accountId)).size} · 리전 ${new Set(list.map(unit => unit.region)).size}${data[service]!.failed.length ? ` · 실패 ${data[service]!.failed.length}` : ''}`,
      `${time(latest)} · ${new Set(list.map(unit => unit.accountId)).size} accounts · ${new Set(list.map(unit => unit.region)).size} regions${data[service]!.failed.length ? ` · ${data[service]!.failed.length} failed` : ''}`); };
  const failedAlert = (service: Service) => data[service]?.failed.length ? <Alert type="warning" header={t('일부 계정·리전에서 조회하지 못했습니다', 'Some account/region reads failed')}>
    {data[service]!.failed.slice(0, 8).map(unit => `${accountLabel(unit.accountId)} · ${unit.region}: ${errorLabel(unit.code)}`).join(' / ')}{data[service]!.failed.length > 8 ? ' …' : ''}</Alert> : null;
  const accountColumn: TableProps.ColumnDefinition<Located> = { id: 'account', header: t('계정', 'Account'), cell: item => <span className="ops-mini-name">{accountNames.get(item.accountId) ?? item.accountId}{accountNames.get(item.accountId) ? <Box variant="small" color="text-body-secondary">{item.accountId}</Box> : null}</span> };
  const regionColumn: TableProps.ColumnDefinition<Located> = { id: 'region', header: t('리전', 'Region'), cell: item => item.region };
  const baseFields: FilterField<Located>[] = [{ key: 'account', label: t('계정', 'Account'), value: item => accountLabel(item.accountId) }, { key: 'region', label: t('리전', 'Region'), value: item => item.region },
    { key: 'name', label: t('이름', 'Name'), value: item => item.name }, { key: 'state', label: t('상태', 'State'), value: item => item.state }];
  const field = (key: string, label: string, value: (item: Located) => string | undefined): FilterField<Located> => ({ key, label, value });
  const trackBy = (item: Located) => `${item.accountId}|${item.region}|${item.id ?? item.name}|${item.metric ?? ''}`;
  const created: TableProps.ColumnDefinition<Located> = { id: 'modified', header: t('생성 시각', 'Created'), cell: item => item.modified ? time(item.modified) : '—' };
  const resourceTable = (service: Service, title: string, columns: TableProps.ColumnDefinition<Located>[], none: string, extraFields: FilterField<Located>[] = [], header?: ReactNode) => <SpaceBetween size="m">
    {failedAlert(service)}
    <ResourceTable title={title} description={source(service)} counter={counter(service)} items={items(service)} trackBy={trackBy} empty={empty(service, none)} header={header} exportName={`aws-${service}`} {...table(`${view}.${service}`)}
      columns={[columns[0]!, accountColumn, regionColumn, ...columns.slice(1)]} fields={[...baseFields, ...extraFields]} /></SpaceBetween>;
  const managed = new Set(items('ssm').map(item => `${item.accountId}:${item.region}:${item.id}`));
  const ssmRead = new Set((data.ssm?.units ?? []).filter(unit => !unit.code).map(unit => `${unit.accountId}:${unit.region}`));

  // Saved views: the page (and its tab), the scope and this page's search conditions. Nothing collected is stored with them.
  const tabOf = (page: DashboardView) => page === 'serverless' ? serverlessTab : page === 'ssm' ? ssmTab : page === 'security' ? securityTab : undefined;
  const pageQueries = () => Object.fromEntries(Object.entries(queries).filter(([id, query]) => id.startsWith(`${view}.`) && query.tokens.length).slice(0, 6).map(([id, query]): [string, SavedQuery] => [id, {
    operation: query.operation, tokens: query.tokens.filter(token => ['=', '!=', ':', '!:'].includes(token.operator)).slice(0, 10)
      .map(token => ({ ...(token.propertyKey ? { propertyKey: token.propertyKey } : {}), operator: token.operator as SavedQuery['tokens'][number]['operator'], value: String(token.value ?? '').slice(0, 128) })) }]));
  const conditionCount = Object.values(pageQueries()).reduce((sum, query) => sum + query.tokens.length, 0);
  const viewSummary = t(`${pageTitle(view)}${tabOf(view) ? ` (${tabOf(view)})` : ''} · 계정 ${accountScope.length || '전체'} · 리전 ${regionScope.length || '전체'} · 검색 조건 ${conditionCount}`,
    `${pageTitle(view)}${tabOf(view) ? ` (${tabOf(view)})` : ''} · ${accountScope.length || 'all'} accounts · ${regionScope.length || 'all'} regions · ${conditionCount} conditions`);
  const saveView = (name: string) => { const tab = tabOf(view); return onSaveView({ name, page: view, ...(tab ? { tab } : {}), accounts: accountScope, regions: regionScope, queries: pageQueries() }); };
  const applyView = (saved: SavedView) => {
    const value = saved.view;
    setAccountScope(value.accounts); setRegionScope(value.regions); setQueries(value.queries);
    if (value.tab) { if (value.page === 'serverless') setServerlessTab(value.tab); else if (value.page === 'ssm') setSsmTab(value.tab); else if (value.page === 'security') setSecurityTab(value.tab); }
    if (value.page !== view) window.location.hash = viewHref(value.page);
  };

  // Sync status, action and scope filters shared by every view.
  // A running state read from the cache without a live job means the worker that ran it is gone (host restart, AWS session ended).
  const interrupted = sync?.state === 'running' && !sync.live;
  const syncLabel = interrupted ? t('이전 동기화가 끝나지 않음', 'Previous sync did not finish') : sync ? ({ running: t('동기화 중', 'Syncing'), completed: t('동기화 완료', 'Sync completed'), partial: t('일부 실패 포함 완료', 'Completed with failures'), failed: t('동기화 실패', 'Sync failed'),
    cancelled: t('동기화 취소됨', 'Sync cancelled'), expired: t('세션 만료로 중단', 'Stopped: session expired') } as const)[sync.state] : t('동기화 기록 없음', 'Never synced');
  const usedRegions = new Set((sync?.accounts ?? []).flatMap(account => account.regions.filter(region => region.taggedVpcs > 0).map(region => region.region)));
  const syncBar = <Container><SpaceBetween size="s">
    <div className="ops-sync-row">
      <SpaceBetween size="xxs">
        <StatusIndicator type={!sync ? 'pending' : interrupted ? 'warning' : sync.state === 'running' ? 'in-progress' : sync.state === 'completed' ? 'success' : sync.state === 'partial' ? 'warning' : 'error'}>{syncLabel}</StatusIndicator>
        <Box color="text-body-secondary" fontSize="body-s">{sync ? t(`${time(sync.finishedAt ?? sync.startedAt)} · 계정 ${sync.accounts.length} · 사용 리전 ${usedRegions.size} (VPC 태그 기준) · ${sync.mode === 'config' ? 'AWS Config 집계자' : '계정별 직접 조회'}${sync.live ? '' : ' · 캐시'}${interrupted ? ' · AWS 연결 후 다시 동기화하세요' : ''}`,
          `${time(sync.finishedAt ?? sync.startedAt)} · ${sync.accounts.length} accounts · ${usedRegions.size} regions in use (tagged VPC) · ${sync.mode === 'config' ? 'AWS Config aggregator' : 'direct per account'}${sync.live ? '' : ' · cached'}${interrupted ? ' · sync again once connected' : ''}`)
          : t('동기화하면 Organizations 범위의 계정을 확인하고 VPC 태그가 있는 리전의 자원을 읽어 디스크에 저장합니다.', 'Sync checks the accounts in the Organizations scope and reads resources in regions with tagged VPCs, saving them to disk.')}</Box>
        {sync ? <Box color="text-body-secondary" fontSize="body-s">{t('이 화면은 전체 자산이 아니라 설정된 수집 범위의 현황입니다. 태그된 VPC가 있는 리전(Payer는 기본 리전 포함)만 읽으므로, 그 밖의 리전에 있는 자원(예: VPC에 연결하지 않은 Lambda)은 포함되지 않습니다. 리전별 제외 수는 조직 계정 화면에서 봅니다.',
          'This view shows the configured collection scope, not every asset. Only regions with a tagged VPC (plus the payer’s home region) are read, so resources elsewhere (for example Lambda functions outside a VPC) are not included. Excluded regions per account are on the Organization accounts page.')}</Box> : null}
        {syncEveryMinutes ? <Box color="text-body-secondary" fontSize="body-s">{(() => {
          const every = syncEveryMinutes % 60 ? t(`${syncEveryMinutes}분`, `${syncEveryMinutes} min`) : t(`${syncEveryMinutes / 60}시간`, `${syncEveryMinutes / 60} h`);
          const last = sync?.finishedAt ?? sync?.startedAt, next = last ? new Date(Date.parse(last) + syncEveryMinutes * 60_000) : undefined;
          return connected ? t(`자동 동기화: ${every}마다${next ? ` · 다음 ${next.toLocaleString(locale)}` : ''} (AWS 세션이 유지되는 동안, 화면을 닫아도 진행)`, `Automatic sync every ${every}${next ? ` · next ${next.toLocaleString(locale)}` : ''} (while the AWS session lasts, even with this page closed)`)
            : t(`자동 동기화: ${every}마다 (AWS 로그인 후 시작)`, `Automatic sync every ${every} (starts after AWS sign-in)`);
        })()}</Box> : null}
      </SpaceBetween>
      <Button variant="primary" iconName="refresh" loading={sync?.state === 'running' && sync.live} disabled={!connected || busy || sync?.state === 'running' && sync.live} onClick={onSync}>{t('동기화', 'Sync')}</Button>
    </div>
    {sync?.state === 'running' && sync.live ? <ProgressBar value={sync.progress.total ? Math.min(100, Math.round(sync.progress.done / sync.progress.total * 100)) : 0} label={t('동기화 진행률', 'Sync progress')}
      description={t(`단계 ${sync.progress.done}/${sync.progress.total} · 저장된 단위 ${sync.cachedUnits}`, `Step ${sync.progress.done}/${sync.progress.total} · ${sync.cachedUnits} units saved`)} /> : null}
    <div className="ops-scope-row">
      <Multiselect selectedOptions={accountOptions.filter(option => accountScope.includes(option.value))} options={accountOptions} onChange={({ detail }) => setAccountScope(detail.selectedOptions.map(option => option.value!))}
        placeholder={t('모든 계정', 'All accounts')} filteringType="auto" ariaLabel={t('계정 범위', 'Account scope')} empty={t('동기화된 계정이 없습니다', 'No synced accounts')} hideTokens={accountScope.length > 3} />
      <Multiselect selectedOptions={regionOptions.filter(option => regionScope.includes(option.value))} options={regionOptions} onChange={({ detail }) => setRegionScope(detail.selectedOptions.map(option => option.value!))}
        placeholder={t('모든 리전', 'All regions')} ariaLabel={t('리전 범위', 'Region scope')} empty={t('동기화된 리전이 없습니다', 'No synced regions')} hideTokens={regionScope.length > 3} />
      {accountScope.length || regionScope.length ? <Button variant="link" onClick={() => { setAccountScope([]); setRegionScope([]); }}>{t('범위 초기화', 'Clear scope')}</Button> : null}
      <div className="ops-scope-views"><SavedViews views={views} current={viewSummary} pageTitle={pageTitle} onApply={applyView} onSave={saveView} onDelete={onDeleteView} /></div>
    </div>
  </SpaceBetween></Container>;
  const page = (content: ReactNode) => <SpaceBetween size="l">{syncBar}{content}</SpaceBetween>;

  const findingDetail = (item: Finding) => item.kind === 'metric' && item.metric ? t(`지난 1시간 ${formatMetric(item.metric, item.value)}`, `last hour ${formatMetric(item.metric, item.value)}`) : item.kind === 'read-failed' ? errorLabel(item.detail)
    : item.kind === 'eos' && item.eos ? `${item.eos.current} · ${eosLabel(item.eos.status)}${item.eos.date ? ` · ${dateOnly(item.eos.date)}` : ''}`
    : item.kind === 'security-hub' ? t(`${item.detail} ${item.value}건`, `${item.value} ${item.detail}`) : item.kind === 'guardduty' ? t(`높음 이상 ${item.value}건`, `${item.value} high or above`)
    : item.kind === 'security-off' ? t('이 리전에서 사용 안 함', 'Not enabled in this region') : item.kind === 'tags' ? t(`자원 ${item.value}개 · 누락 ${item.detail}`, `${item.value} resources · missing ${item.detail}`) : item.detail;
  const findingsTable = (limit?: number) => <Table items={limit ? assessment.findings.slice(0, limit) : assessment.findings} trackBy="id" variant="embedded" wrapLines columnDefinitions={[
    { id: 'severity', header: t('수준', 'Level'), width: 110, cell: item => <StatusIndicator type={tone[item.severity]}>{item.severity === 'critical' ? t('조치', 'Action') : item.severity === 'warning' ? t('주의', 'Attention') : t('참고', 'Info')}</StatusIndicator> },
    { id: 'subject', header: t('항목', 'Item'), minWidth: 240, cell: item => <div><Box fontWeight="bold">{item.kind === 'tags' || item.kind === 'read-failed' ? serviceLabel[item.subject as Service] ?? item.subject : item.subject}</Box><Box color="text-body-secondary" fontSize="body-s">{kindLabel(item)} · {findingDetail(item)}</Box></div> },
    { id: 'where', header: t('계정 · 리전', 'Account · Region'), minWidth: 170, cell: item => item.accountId ? <span className="ops-mini-name">{accountNames.get(item.accountId) ?? item.accountId}<Box variant="small" color="text-body-secondary">{[accountNames.get(item.accountId) ? item.accountId : undefined, item.region].filter(Boolean).join(' · ')}</Box></span> : '—' },
    { id: 'next', header: t('권장 다음 단계', 'Suggested next step'), minWidth: 240, cell: item => nextStep(item) },
    { id: 'actions', header: t('작업', 'Actions'), minWidth: 150, cell: item => item.link ? <Button variant="inline-link" href={item.link} target="_blank" iconName="external" iconAlign="right" ariaLabel={t(`${item.subject} AWS 콘솔에서 열기`, `Open ${item.subject} in AWS console`)}>{t('콘솔에서 열기', 'Open in console')}</Button> : '—' },
  ]} empty={<Box textAlign="center" color="text-body-secondary">{assessment.overall === 'unknown' ? t('아직 수집한 정보가 없습니다. 동기화를 실행하세요.', 'Nothing collected yet. Run a sync.') : t('수집 범위에서 조치·주의 항목이 없습니다. 전체 정상 판정은 아닙니다.', 'No items in the collected scope. This is not a health verdict for the whole account.')}</Box>} />;

  if (view === 'runbooks') {
    const instances = allUnits.filter(unit => unit.service === 'ec2').flatMap(unit => unit.items.filter(item => item.id).map(item => ({ id: item.id!, name: item.name, state: item.state, accountId: unit.accountId, region: unit.region })));
    return <RunbooksView state={runbooks} instances={instances} payer={payer} accountLabel={accountLabel} onRefresh={onRefreshRunbooks} onCommand={onRunbookCommand} />;
  }
  if (view === 'report') {
    const describe = (item: SnapshotFinding) => { const finding = item as unknown as Finding;
      return { subject: item.kind === 'tags' || item.kind === 'read-failed' ? serviceLabel[item.subject as Service] ?? item.subject : item.subject, detail: `${kindLabel(finding) ?? item.kind} · ${findingDetail(finding)}` }; };
    const scopeText = accountScope.length || regionScope.length ? t(`계정 ${accountScope.length || '전체'} · 리전 ${regionScope.length || '전체'}`, `${accountScope.length || 'all'} accounts · ${regionScope.length || 'all'} regions`) : t('전체 동기화 범위', 'Entire sync scope');
    return page(<ReportView snapshots={report} scope={reportScope} scopeText={scopeText} eos={lifecycleRows(data)} eosLabel={eosLabel} accountLabel={accountLabel} accountName={id => accountNames.get(id)} describe={describe} table={table} />);
  }
  if (view === 'ec2') return page(resourceTable('ec2', t('EC2 인스턴스', 'EC2 instances'), [
    { id: 'name', header: t('인스턴스', 'Instance'), cell: item => item.id ? <Link external href={open(item.accountId, consoleLink.ec2(item.region, item.id))}>{item.name}</Link> : item.name },
    { id: 'id', header: 'ID', cell: item => item.id ?? '—' },
    { id: 'type', header: t('유형', 'Type'), cell: item => item.type ?? item.runtime ?? '—' },
    { id: 'state', header: t('상태', 'State'), cell: item => state(item.state) },
    { id: 'cpu', header: t('CPU 최고(1시간)', 'Peak CPU (1h)'), cell: item => metricCell('ec2_cpu', item) },
    { id: 'status', header: t('상태 검사', 'Status checks'), cell: item => { const failed = metricOf('ec2_status', item)?.peak; return !collected('metrics') ? notCollected : failed === undefined ? '—' : failed >= 1 ? <StatusIndicator type="error">{t('실패', 'Failed')}</StatusIndicator> : <StatusIndicator type="success">{t('통과', 'Passed')}</StatusIndicator>; } },
    { id: 'ssm', header: 'SSM', cell: item => !ssmRead.has(`${item.accountId}:${item.region}`) ? notCollected : managed.has(`${item.accountId}:${item.region}:${item.id}`) ? <StatusIndicator type="success">{t('관리됨', 'Managed')}</StatusIndicator> : <StatusIndicator type="warning">{t('미관리', 'Unmanaged')}</StatusIndicator> },
    { id: 'launched', header: t('시작 시각', 'Launched'), cell: item => item.modified ? time(item.modified) : '—' },
  ], t('인스턴스가 없습니다.', 'No instances.'), [field('type', t('유형', 'Type'), item => item.type ?? item.runtime ?? undefined), field('id', 'ID', item => item.id)]));
  if (view === 'eks') return page(resourceTable('eks', t('EKS 클러스터', 'EKS clusters'), [
    { id: 'name', header: t('클러스터', 'Cluster'), cell: item => <Link external href={open(item.accountId, consoleLink.eks(item.region, item.name))}>{item.name}</Link> },
    { id: 'state', header: t('상태', 'State'), cell: item => item.state ? state(item.state) : '—' },
    { id: 'version', header: t('Kubernetes 버전', 'Kubernetes version'), cell: item => item.version ?? '—' },
    { id: 'support', header: t('버전 지원', 'Version support'), cell: support },
    { id: 'platform', header: t('플랫폼 버전', 'Platform version'), cell: item => item.type ?? '—' }, created,
  ], t('클러스터가 없습니다.', 'No clusters.'), [field('version', t('버전', 'Version'), item => item.version), field('support', t('버전 지원', 'Version support'), item => item.support)],
    <Box color="text-body-secondary" fontSize="body-s">{t('버전 지원 상태는 AWS(DescribeClusterVersions)에서 읽습니다. 확장 지원 기간에는 클러스터당 시간 요금이 더 높습니다.', 'Support status is read from AWS (DescribeClusterVersions). Extended support has a higher hourly per-cluster price.')}</Box>));
  if (view === 'rds') return page(resourceTable('rds', t('RDS DB 인스턴스', 'RDS DB instances'), [
    { id: 'name', header: t('DB 인스턴스', 'DB instance'), cell: item => <Link external href={open(item.accountId, consoleLink.rds(item.region, item.name))}>{item.name}</Link> },
    { id: 'engine', header: t('엔진', 'Engine'), cell: item => item.version ?? '—' },
    { id: 'class', header: t('클래스', 'Class'), cell: item => item.type ?? '—' },
    { id: 'state', header: t('상태', 'State'), cell: item => state(item.state) },
    { id: 'cpu', header: t('CPU 최고(1시간)', 'Peak CPU (1h)'), cell: item => metricCell('rds_cpu', item, item.name) },
    { id: 'storage', header: t('여유 저장공간 최저', 'Lowest free storage'), cell: item => metricCell('rds_storage', item, item.name) }, created,
  ], t('DB 인스턴스가 없습니다.', 'No DB instances.'), [field('engine', t('엔진', 'Engine'), item => item.version), field('type', t('클래스', 'Class'), item => item.type)]));
  if (view === 'elasticache') return page(resourceTable('elasticache', t('ElastiCache 클러스터', 'ElastiCache clusters'), [
    { id: 'name', header: t('클러스터', 'Cluster'), cell: item => <Link external href={open(item.accountId, consoleLink.elasticache(item.region))}>{item.name}</Link> },
    { id: 'engine', header: t('엔진', 'Engine'), cell: item => item.version ?? '—' },
    { id: 'type', header: t('노드 유형', 'Node type'), cell: item => item.type ?? '—' },
    { id: 'state', header: t('상태', 'State'), cell: item => state(item.state) },
    { id: 'cpu', header: t('CPU 최고(1시간)', 'Peak CPU (1h)'), cell: item => metricCell('cache_cpu', item, item.name) },
    { id: 'memory', header: t('메모리 최고(1시간)', 'Peak memory (1h)'), cell: item => metricCell('cache_memory', item, item.name) }, created,
  ], t('캐시 클러스터가 없습니다.', 'No cache clusters.'), [field('engine', t('엔진', 'Engine'), item => item.version), field('type', t('노드 유형', 'Node type'), item => item.type)]));
  if (view === 'msk') return page(resourceTable('msk', t('MSK 클러스터', 'MSK clusters'), [
    { id: 'name', header: t('클러스터', 'Cluster'), cell: item => <Link external href={open(item.accountId, consoleLink.msk(item.region))}>{item.name}</Link> },
    { id: 'type', header: t('브로커 유형', 'Broker type'), cell: item => item.type ?? '—' },
    { id: 'version', header: t('Kafka 버전', 'Kafka version'), cell: item => item.version ?? '—' },
    { id: 'state', header: t('상태', 'State'), cell: item => state(item.state) },
    { id: 'cpu', header: t('브로커 CPU 최고', 'Peak broker CPU'), cell: item => metricCell('msk_cpu', item, item.name) },
    { id: 'disk', header: t('디스크 최고', 'Peak disk'), cell: item => metricCell('msk_disk', item, item.name) }, created,
  ], t('Kafka 클러스터가 없습니다.', 'No Kafka clusters.'), [field('version', t('Kafka 버전', 'Kafka version'), item => item.version), field('type', t('브로커 유형', 'Broker type'), item => item.type)]));
  if (view === 'serverless') return page(<Tabs activeTabId={serverlessTab} onChange={({ detail }) => setServerlessTab(detail.activeTabId)} ariaLabel="Serverless"
    i18nStrings={{ scrollLeftAriaLabel: t('왼쪽으로 스크롤', 'Scroll left'), scrollRightAriaLabel: t('오른쪽으로 스크롤', 'Scroll right') }} tabs={[
    { id: 'lambda', label: `Lambda${counter('lambda') ? ` ${counter('lambda')}` : ''}`, content: resourceTable('lambda', t('Lambda 함수', 'Lambda functions'), [
      { id: 'name', header: t('함수', 'Function'), cell: item => <Link external href={open(item.accountId, consoleLink.lambda(item.region, item.name))}>{item.name}</Link> },
      { id: 'runtime', header: t('런타임', 'Runtime'), cell: item => { const status = lambdaRuntimeStatus(item.runtime); return !item.runtime ? t('컨테이너 이미지', 'Container image') : status === 'supported' ? item.runtime : <span className="ops-mini-name">{item.runtime}{eosIndicator(status!)}</span>; } },
      { id: 'errors', header: t('오류(1시간)', 'Errors (1h)'), cell: item => metricCell('lambda_errors', item, item.name) },
      { id: 'modified', header: t('최근 수정', 'Last modified'), cell: item => item.modified ? time(item.modified) : '—' },
    ], t('함수가 없습니다.', 'No functions.'), [field('runtime', t('런타임', 'Runtime'), item => item.runtime ?? 'container-image')]) },
    { id: 'dynamodb', label: `DynamoDB${counter('dynamodb') ? ` ${counter('dynamodb')}` : ''}`, content: resourceTable('dynamodb', t('DynamoDB 테이블', 'DynamoDB tables'), [
      { id: 'name', header: t('테이블', 'Table'), cell: item => <Link external href={open(item.accountId, consoleLink.dynamodb(item.region, item.name))}>{item.name}</Link> },
    ], t('테이블이 없습니다.', 'No tables.')) },
    { id: 'apigateway', label: `API Gateway${counter('apigateway') ? ` ${counter('apigateway')}` : ''}`, content: resourceTable('apigateway', t('API Gateway API', 'API Gateway APIs'), [
      { id: 'name', header: 'API', cell: item => item.id ? <Link external href={open(item.accountId, consoleLink.apigateway(item.region, item.id, item.type))}>{item.name}</Link> : item.name },
      { id: 'type', header: t('유형', 'Type'), cell: item => item.type ?? '—' },
      { id: 'endpoint', header: t('엔드포인트', 'Endpoint'), cell: item => item.version ?? '—' },
      { id: 'id', header: 'API ID', cell: item => item.id ?? '—' }, created,
    ], t('API가 없습니다.', 'No APIs.'), [field('type', t('유형', 'Type'), item => item.type), field('id', 'API ID', item => item.id)]) },
  ]} />);
  if (view === 'ssm') return page(<SpaceBetween size="m">
    <Alert type="info">{t('Systems Manager는 현재 읽기 전용입니다(관리 노드·패치 준수·Automation 실행 기록). Automation 실행(런북)은 승인·감사 흐름이 정해진 뒤 별도 단계로 추가합니다.', 'Systems Manager is read-only for now (managed nodes, patch compliance, Automation history). Running runbooks will be added separately once approval and audit flows are defined.')}</Alert>
    <Tabs activeTabId={ssmTab} onChange={({ detail }) => setSsmTab(detail.activeTabId)} ariaLabel="Systems Manager" i18nStrings={{ scrollLeftAriaLabel: t('왼쪽으로 스크롤', 'Scroll left'), scrollRightAriaLabel: t('오른쪽으로 스크롤', 'Scroll right') }} tabs={[
      { id: 'nodes', label: t('관리 노드', 'Managed nodes'), content: resourceTable('ssm', t('SSM 관리 노드', 'SSM managed nodes'), [
        { id: 'name', header: t('노드', 'Node'), cell: item => item.id ? <Link external href={open(item.accountId, consoleLink.ssmNode(item.region, item.id))}>{item.name}</Link> : item.name },
        { id: 'state', header: t('연결', 'Ping'), cell: item => state(item.state) },
        { id: 'platform', header: t('플랫폼', 'Platform'), cell: item => [item.version, item.detail].filter(Boolean).join(' ') || item.type || '—' },
        { id: 'agent', header: t('에이전트', 'Agent'), cell: item => item.runtime ?? '—' },
        { id: 'ping', header: t('마지막 연결', 'Last ping'), cell: item => item.modified ? time(item.modified) : '—' },
      ], t('관리 노드가 없습니다.', 'No managed nodes.'), [field('platform', t('플랫폼', 'Platform'), item => [item.version, item.detail].filter(Boolean).join(' ') || undefined), field('type', t('플랫폼 유형', 'Platform type'), item => item.type)]) },
      { id: 'patch', label: t('패치 준수', 'Patch compliance'), content: resourceTable('patch', t('패치 준수', 'Patch compliance'), [
        { id: 'name', header: t('리소스', 'Resource'), cell: item => item.id?.startsWith('i-') ? <Link external href={open(item.accountId, consoleLink.ssmNode(item.region, item.id))}>{item.name}</Link> : item.name },
        { id: 'state', header: t('준수', 'Compliance'), cell: item => state(item.state) },
        { id: 'severity', header: t('최고 심각도', 'Highest severity'), cell: item => item.detail ?? '—' },
      ], t('패치 준수 데이터가 없습니다.', 'No patch compliance data.'), [field('severity', t('심각도', 'Severity'), item => item.detail)]) },
      { id: 'automation', label: 'Automation', content: resourceTable('automation', t('Automation 실행(최근 7일)', 'Automation executions (last 7 days)'), [
        { id: 'name', header: t('문서', 'Document'), cell: item => item.id ? <Link external href={open(item.accountId, consoleLink.automation(item.region, item.id))}>{item.name}</Link> : item.name },
        { id: 'state', header: t('상태', 'Status'), cell: item => state(item.state) },
        { id: 'started', header: t('시작', 'Started'), cell: item => item.modified ? time(item.modified) : '—' },
        { id: 'ended', header: t('종료', 'Ended'), cell: item => item.detail ? time(item.detail) : '—' },
      ], t('최근 7일 실행 기록이 없습니다.', 'No executions in the last 7 days.')) },
    ]} /></SpaceBetween>);
  if (view === 'lifecycle') {
    const rows = lifecycleRows(data);
    const count = (status: EosStatus) => rows.filter(row => row.status === status).length;
    const eosFields: FilterField<EosRow>[] = [...(baseFields as FilterField<EosRow>[]), { key: 'component', label: t('구성 요소', 'Component'), value: row => row.component }, { key: 'status', label: t('지원 상태', 'Support state'), value: row => eosLabel(row.status) },
      { key: 'current', label: t('현재 버전', 'Current version'), value: row => row.current }];
    return page(<SpaceBetween size="l">
      <div className="ops-metric-grid ops-eos-grid" aria-label={t('수명주기 요약', 'Lifecycle summary')}>
        {([['ended', 'critical'], ['extended', 'attention'], ['deprecated', 'attention'], ['upcoming', ''], ['unknown', '']] as const).map(([status, severity]) =>
          <div key={status} className={`account-state-card ${severity ? `account-state-${severity}` : ''}`}><span>{eosLabel(status)}</span><strong>{count(status)}</strong><span>{status === 'upcoming' ? t(`${upcomingWindowDays}일 안에 종료`, `ends within ${upcomingWindowDays} days`) : status === 'unknown' ? t('근거 없음(정상 아님)', 'no evidence (not healthy)') : t('자원', 'resources')}</span></div>)}
      </div>
      <ResourceTable title={t('수명주기(EOS)', 'Lifecycle (EOS)')} description={t(`EKS·RDS·MSK 상태는 AWS API, Lambda·ElastiCache·MSK 종료일·운영체제는 AWS/벤더 문서(${lifecycleCapturedAt} 기준, 변경될 수 있음)를 근거로 합니다.`, `EKS/RDS/MSK status from AWS APIs; Lambda, ElastiCache, MSK end dates and operating systems from AWS/vendor documentation (as of ${lifecycleCapturedAt}, subject to change).`)}
        items={rows} trackBy={row => `${row.service}|${row.accountId}|${row.region}|${row.id ?? row.name}`} fields={eosFields} exportName="lifecycle-eos" {...table('lifecycle.eos')}
        empty={<Box textAlign="center" color="text-body-secondary">{sync ? t('수명주기를 판단할 자원이 없습니다.', 'No resources with a lifecycle to evaluate.') : notCollected}</Box>}
        columns={[
          { id: 'name', header: t('자원', 'Resource'), cell: row => row.name },
          accountColumn as TableProps.ColumnDefinition<EosRow>, regionColumn as TableProps.ColumnDefinition<EosRow>,
          { id: 'component', header: t('구성 요소', 'Component'), cell: row => row.component },
          { id: 'current', header: t('현재 버전', 'Current version'), cell: row => row.current },
          { id: 'status', header: t('지원 상태', 'Support state'), cell: row => eosIndicator(row.status) },
          { id: 'date', header: t('기준일', 'Date'), cell: row => dateOnly(row.date) },
          { id: 'days', header: t('남은 일수', 'Days left'), cell: row => row.daysLeft === undefined ? '—' : row.daysLeft < 0 ? t(`${-row.daysLeft}일 지남`, `${-row.daysLeft} days ago`) : t(`${row.daysLeft}일`, `${row.daysLeft} days`) },
          { id: 'basis', header: t('근거', 'Basis'), cell: row => row.basis === 'api' ? 'AWS API' : t(`문서 (${lifecycleCapturedAt})`, `Docs (${lifecycleCapturedAt})`) },
        ]} />
    </SpaceBetween>);
  }
  if (view === 'alarms') return page(resourceTable('alarms', t('CloudWatch 경보', 'CloudWatch alarms'), [
    { id: 'name', header: t('경보', 'Alarm'), cell: item => <Link external href={open(item.accountId, consoleLink.alarm(item.region, item.name))}>{item.name}</Link> },
    { id: 'state', header: t('상태', 'State'), cell: item => <StatusIndicator type={item.state === 'ALARM' ? 'error' : item.state === 'OK' ? 'success' : 'warning'}>{item.state ?? '—'}</StatusIndicator> },
  ], t('경보가 없습니다.', 'No alarms.')));
  if (view === 'metrics') {
    const threshold = (id: MetricId) => { const rule = metricThresholds[id], sign = rule.direction === 'above' ? '≥' : '<';
      return [rule.critical !== undefined ? t(`조치 ${sign} ${formatMetric(id, rule.critical)}`, `action ${sign} ${formatMetric(id, rule.critical)}`) : '', rule.warning !== undefined ? t(`주의 ${sign} ${formatMetric(id, rule.warning)}`, `attention ${sign} ${formatMetric(id, rule.warning)}`) : '',
        rule.info !== undefined ? t(`참고 ${sign} ${formatMetric(id, rule.info)}`, `info ${sign} ${formatMetric(id, rule.info)}`) : ''].filter(Boolean).join(' · '); };
    return page(<SpaceBetween size="l">
      {failedAlert('metrics')}
      <Header variant="h2" description={`${source('metrics')} · ${t('지난 1시간 · 5분 간격 · 계정·리전별 최악값 상위 10개', 'last hour · 5-minute periods · worst 10 per account/region')}`}>{t('CloudWatch 표준 지표', 'CloudWatch standard metrics')}</Header>
      <div className="ops-widget-grid ops-widget-grid-2">
        {(Object.keys(metricThresholds) as MetricId[]).map(id => { const rows = items('metrics').filter(item => item.metric === id && item.peak !== undefined).sort((a, b) => metricThresholds[id].direction === 'below' ? a.peak! - b.peak! : b.peak! - a.peak!).slice(0, 10);
          const unit = metricThresholds[id].unit, scale = (value: number) => unit === 'bytes' ? Math.round(value / 1024 ** 3 * 10) / 10 : Math.round(value * 10) / 10;
          return <Container key={id} fitHeight header={<Header variant="h3" counter={collected('metrics') ? `(${rows.length})` : undefined} description={threshold(id)}>{metricLabel(id)}</Header>}>
            {rows.length ? <BarChart series={[{ title: metricLabel(id), type: 'bar', data: rows.map(item => ({ x: `${item.name} · ${accountNames.get(item.accountId) ?? item.accountId} · ${item.region}`, y: scale(item.peak!) })) }]} horizontalBars hideFilter hideLegend height={Math.max(80, rows.length * 30)}
              xScaleType="categorical" yTitle={unit === 'percent' ? '%' : unit === 'bytes' ? 'GiB' : t('건수', 'count')} ariaLabel={metricLabel(id)} i18nStrings={barStrings} {...(unit === 'percent' ? { yDomain: [0, 100] } : {})} />
              : empty('metrics', t('최근 1시간 데이터가 없습니다.', 'No data in the last hour.'))}
          </Container>; })}
      </div>
    </SpaceBetween>);
  }
  const coverageLabel = (value: CoverageState) => <StatusIndicator type={value === 'enabled' ? 'success' : value === 'not-enabled' ? 'warning' : value === 'failed' ? 'error' : 'pending'}>{({ enabled: t('사용 중', 'Enabled'), 'not-enabled': t('사용 안 함', 'Not enabled'),
    failed: t('확인 실패', 'Check failed'), 'not-collected': notCollected } as const)[value]}</StatusIndicator>;
  const severityBadge = (label?: string) => <StatusIndicator type={label === 'CRITICAL' ? 'error' : label === 'HIGH' ? 'warning' : 'info'}>{label ?? '—'}</StatusIndicator>;
  const summaryCards = (label: string, cards: Array<[string, string | number, string, string]>) => <div className="ops-metric-grid ops-eos-grid" aria-label={label}>
    {cards.map(([title, value, detailText, severity]) => <div key={title} className={`account-state-card ${severity ? `account-state-${severity}` : ''}`}><span>{title}</span><strong>{value}</strong><span>{detailText}</span></div>)}</div>;
  if (view === 'security') {
    const coverage = securityCoverage(data), hubOff = coverage.filter(row => row.securityhub === 'not-enabled').length, guardOff = coverage.filter(row => row.guardduty === 'not-enabled').length;
    const coverageFields: FilterField<CoverageRow>[] = [{ key: 'account', label: t('계정', 'Account'), value: row => accountLabel(row.accountId) }, { key: 'region', label: t('리전', 'Region'), value: row => row.region },
      { key: 'securityhub', label: 'Security Hub', value: row => row.securityhub }, { key: 'guardduty', label: 'GuardDuty', value: row => row.guardduty }];
    const disabledNote = (service: Service, name: string) => data[service]?.disabled.length ? <Alert type="warning">{t(`${name}가 활성화되지 않은 계정·리전: ${data[service]!.disabled.length}곳. 이 영역의 위협·규정 준수는 확인되지 않습니다.`, `${name} is not enabled in ${data[service]!.disabled.length} account/region(s); threats and compliance there are not checked.`)}</Alert> : null;
    return page(<SpaceBetween size="l">
      {summaryCards(t('보안 태세 요약', 'Security posture summary'), [
        ['Security Hub CRITICAL', m.securityhub ? m.securityhub.critical : '—', m.securityhub ? t('활성 · 미해결', 'active · unresolved') : notCollected, m.securityhub?.critical ? 'critical' : ''],
        ['Security Hub HIGH', m.securityhub ? m.securityhub.high : '—', m.securityhub ? t('활성 · 미해결', 'active · unresolved') : notCollected, m.securityhub?.high ? 'attention' : ''],
        [t('GuardDuty 위협', 'GuardDuty threats'), m.guardduty ? m.guardduty.threats : '—', m.guardduty ? t('심각도 7.0 이상 · 보관 안 됨', 'severity 7.0+ · not archived') : notCollected, m.guardduty?.threats ? 'critical' : ''],
        [t('미사용 리전', 'Regions not covered'), coverage.length ? hubOff + guardOff : '—', t(`Security Hub ${hubOff} · GuardDuty ${guardOff}`, `Security Hub ${hubOff} · GuardDuty ${guardOff}`), hubOff + guardOff ? 'attention' : ''],
      ])}
      <Tabs activeTabId={securityTab} onChange={({ detail }) => setSecurityTab(detail.activeTabId)} ariaLabel={t('보안 태세', 'Security posture')} i18nStrings={{ scrollLeftAriaLabel: t('왼쪽으로 스크롤', 'Scroll left'), scrollRightAriaLabel: t('오른쪽으로 스크롤', 'Scroll right') }} tabs={[
        { id: 'securityhub', label: `Security Hub${counter('securityhub') ? ` ${counter('securityhub')}` : ''}`, content: <SpaceBetween size="m">{disabledNote('securityhub', 'Security Hub')}{resourceTable('securityhub', t('Security Hub 결과 (CRITICAL·HIGH, 활성·미해결)', 'Security Hub findings (CRITICAL/HIGH, active, unresolved)'), [
          { id: 'name', header: t('결과', 'Finding'), minWidth: 260, cell: item => <Link external href={open(item.accountId, consoleLink.securityhub(item.region))}>{item.name}</Link> },
          { id: 'severity', header: t('심각도', 'Severity'), cell: item => severityBadge(item.state) },
          { id: 'control', header: t('컨트롤', 'Control'), cell: item => item.version ?? '—' },
          { id: 'product', header: t('제품', 'Product'), cell: item => item.type ?? '—' },
          { id: 'resource', header: t('자원 유형', 'Resource type'), cell: item => item.detail ?? '—' },
          { id: 'updated', header: t('최근 갱신', 'Updated'), cell: item => item.modified ? time(item.modified) : '—' },
        ], data.securityhub && !data.securityhub.units.some(unit => !unit.code) ? t('이 범위에서 Security Hub가 활성화되지 않았습니다.', 'Security Hub is not enabled in this scope.') : t('CRITICAL·HIGH 결과가 없습니다.', 'No CRITICAL or HIGH findings.'),
          [field('severity', t('심각도', 'Severity'), item => item.state), field('control', t('컨트롤', 'Control'), item => item.version), field('product', t('제품', 'Product'), item => item.type), field('resource', t('자원 유형', 'Resource type'), item => item.detail)])}</SpaceBetween> },
        { id: 'guardduty', label: `GuardDuty${counter('guardduty') ? ` ${counter('guardduty')}` : ''}`, content: <SpaceBetween size="m">{disabledNote('guardduty', 'GuardDuty')}{resourceTable('guardduty', t('GuardDuty 결과 (심각도 7.0 이상)', 'GuardDuty findings (severity 7.0+)'), [
          { id: 'name', header: t('결과', 'Finding'), minWidth: 260, cell: item => <Link external href={open(item.accountId, consoleLink.guardduty(item.region))}>{item.name}</Link> },
          { id: 'severity', header: t('심각도', 'Severity'), cell: item => <span className="ops-mini-name">{severityBadge(guardDutyLevel(item.value))}<Box variant="small" color="text-body-secondary">{item.value?.toFixed(1)}</Box></span> },
          { id: 'type', header: t('위협 유형', 'Threat type'), minWidth: 220, cell: item => item.type ?? '—' },
          { id: 'resource', header: t('자원 유형', 'Resource type'), cell: item => item.detail ?? '—' },
          { id: 'updated', header: t('최근 갱신', 'Updated'), cell: item => item.modified ? time(item.modified) : '—' },
        ], data.guardduty && !data.guardduty.units.some(unit => !unit.code) ? t('이 범위에서 GuardDuty가 활성화되지 않았습니다.', 'GuardDuty is not enabled in this scope.') : t('심각도 7.0 이상 결과가 없습니다.', 'No findings with severity 7.0 or above.'),
          [field('severity', t('심각도', 'Severity'), item => guardDutyLevel(item.value)), field('type', t('위협 유형', 'Threat type'), item => item.type), field('resource', t('자원 유형', 'Resource type'), item => item.detail)])}</SpaceBetween> },
        { id: 'coverage', label: t('적용 범위', 'Coverage'), content: <ResourceTable title={t('계정·리전별 보안 서비스', 'Security services per account and region')} description={t('사용 리전(VPC 태그 기준)마다 Security Hub와 GuardDuty 활성 여부를 확인합니다.', 'Security Hub and GuardDuty state in each region in use (tagged VPC).')}
          items={coverage} trackBy={row => `${row.accountId}|${row.region}`} fields={coverageFields} exportName="security-coverage" {...table('security.coverage')}
          empty={<Box textAlign="center" color="text-body-secondary">{notCollected}</Box>} columns={[
            { id: 'account', header: t('계정', 'Account'), cell: row => <span className="ops-mini-name">{accountNames.get(row.accountId) ?? row.accountId}{accountNames.get(row.accountId) ? <Box variant="small" color="text-body-secondary">{row.accountId}</Box> : null}</span> },
            { id: 'region', header: t('리전', 'Region'), cell: row => row.region },
            { id: 'securityhub', header: 'Security Hub', cell: row => coverageLabel(row.securityhub) },
            { id: 'guardduty', header: 'GuardDuty', cell: row => coverageLabel(row.guardduty) },
            { id: 'findings', header: t('결과 수', 'Findings'), cell: row => `${row.hubFindings} · ${row.guardFindings}${row.partial ? '+' : ''}` },
          ]} /> },
      ]} /></SpaceBetween>);
  }
  if (view === 'tags') {
    const rows = tagRows(data, requiredTags), count = (status: TagStatus) => rows.filter(row => row.status === status).length, evaluated = count('compliant') + count('missing');
    const tagLabel = (status: TagStatus) => <StatusIndicator type={status === 'compliant' ? 'success' : status === 'missing' ? 'warning' : 'pending'}>{({ compliant: t('준수', 'Compliant'), missing: t('누락', 'Missing'), unknown: t('태그 미수집', 'Tags not collected') } as const)[status]}</StatusIndicator>;
    const tagFields: FilterField<TagRow>[] = [...(baseFields as FilterField<TagRow>[]), { key: 'service', label: t('서비스', 'Service'), value: row => serviceLabel[row.service] }, { key: 'status', label: t('준수', 'Compliance'), value: row => row.status },
      { key: 'missing', label: t('누락 태그', 'Missing tags'), value: row => row.missing.join(' ') }, { key: 'tag', label: t('보유 태그', 'Tags present'), value: row => row.tags?.join(' ') }];
    return page(<SpaceBetween size="l">
      {requiredTags.length ? null : <Alert type="info" header={t('필수 태그가 설정되지 않았습니다', 'No required tags configured')}>{t('서버 연결 설정의 inventory.requiredTags에 태그 키(예: Owner, CostCenter, Environment)를 지정하면 자원별 준수 여부를 평가합니다. 지금은 수집한 태그 키만 보여 줍니다.', 'Set tag keys (for example Owner, CostCenter, Environment) in the connection’s inventory.requiredTags to evaluate compliance. Only collected tag keys are shown for now.')}</Alert>}
      {requiredTags.length ? summaryCards(t('태그 준수 요약', 'Tag compliance summary'), [
        [t('준수율', 'Compliance rate'), evaluated ? `${Math.round(count('compliant') / evaluated * 100)}%` : '—', t(`평가한 자원 ${evaluated}개`, `${evaluated} resources evaluated`), ''],
        [t('준수', 'Compliant'), count('compliant'), t('필수 태그 모두 있음', 'all required tags present'), ''],
        [t('누락', 'Missing'), count('missing'), t('필수 태그 일부 없음', 'some required tags absent'), count('missing') ? 'attention' : ''],
        [t('태그 미수집', 'Tags not collected'), count('unknown'), t('근거 없음(준수 아님)', 'no evidence (not compliant)'), ''],
      ]) : null}
      <ResourceTable title={t('자원별 태그 준수', 'Tag compliance by resource')} description={requiredTags.length ? t(`필수 태그: ${requiredTags.join(', ')} · 태그 키는 대소문자를 구분합니다. Lambda·DynamoDB·ElastiCache 태그는 Resource Groups Tagging API에서 읽습니다.`, `Required tags: ${requiredTags.join(', ')} · tag keys are case-sensitive. Lambda, DynamoDB and ElastiCache tags come from the Resource Groups Tagging API.`) : undefined}
        items={rows} trackBy={row => `${row.service}|${row.accountId}|${row.region}|${row.id ?? row.name}`} fields={tagFields} exportName="tag-compliance" {...table('tags.resources')}
        empty={<Box textAlign="center" color="text-body-secondary">{sync ? t('평가할 자원이 없습니다.', 'No resources to evaluate.') : notCollected}</Box>} columns={[
          { id: 'name', header: t('자원', 'Resource'), cell: row => row.name },
          accountColumn as TableProps.ColumnDefinition<TagRow>, regionColumn as TableProps.ColumnDefinition<TagRow>,
          { id: 'service', header: t('서비스', 'Service'), cell: row => serviceLabel[row.service] ?? row.service },
          ...(requiredTags.length ? [{ id: 'status', header: t('준수', 'Compliance'), cell: (row: TagRow) => tagLabel(row.status) },
            { id: 'missing', header: t('누락 태그', 'Missing tags'), cell: (row: TagRow) => row.missing.length ? <div className="ops-badges">{row.missing.map(key => <Badge key={key} color="red">{key}</Badge>)}</div> : '—' }] : []),
          { id: 'tags', header: t('보유 태그 키', 'Tag keys present'), minWidth: 200, cell: row => !row.tags ? t('미수집', 'Not collected') : row.tags.length ? <Box fontSize="body-s">{row.tags.filter(key => !key.startsWith('aws:')).slice(0, 8).join(', ')}{row.tags.length > 8 ? ' …' : ''}</Box> : t('없음', 'None') },
        ]} />
    </SpaceBetween>);
  }
  if (view === 'health') {
    const health = data.health, unavailable = health?.disabled.length ?? 0, read = health?.units.filter(unit => !unit.code).length ?? 0;
    const healthFields: FilterField<Located>[] = [{ key: 'account', label: t('계정', 'Account'), value: item => accountLabel(item.accountId) }, { key: 'event', label: t('이벤트 유형', 'Event type'), value: item => item.name },
      { key: 'service', label: t('서비스', 'Service'), value: item => item.type }, { key: 'category', label: t('분류', 'Category'), value: item => item.version }, { key: 'state', label: t('상태', 'Status'), value: item => item.state }, { key: 'region', label: t('리전', 'Region'), value: item => item.detail }];
    const category = (value?: string) => ({ issue: t('서비스 이슈', 'Issue'), scheduledChange: t('예정된 변경', 'Scheduled change'), accountNotification: t('계정 알림', 'Account notification') } as Record<string, string>)[value ?? ''] ?? value ?? '—';
    return page(<SpaceBetween size="l">
      {unavailable ? <Alert type="info" header={t('일부 계정에서 AWS Health를 확인할 수 없습니다', 'AWS Health is unavailable for some accounts')}>{t(`AWS Health API는 Business·Enterprise On-Ramp·Enterprise 지원 플랜에서만 쓸 수 있습니다. 해당 계정 ${unavailable}곳은 '확인 불가'이며 예정된 변경이 없다는 뜻이 아닙니다.`, `The AWS Health API requires a Business, Enterprise On-Ramp or Enterprise support plan. ${unavailable} account(s) show as unavailable, which does not mean there are no scheduled changes.`)}</Alert> : null}
      {failedAlert('health')}
      <ResourceTable title={t('AWS Health 이벤트 (진행 중·예정)', 'AWS Health events (open and upcoming)')} description={health ? t(`${source('health')} · 확인한 계정 ${read}`, `${source('health')} · ${read} accounts checked`) : notCollected}
        counter={counter('health')} items={items('health')} trackBy={item => `${item.accountId}|${item.name}|${item.detail ?? ''}|${item.modified ?? ''}`} fields={healthFields} exportName="aws-health" {...table('health.events')}
        empty={<Box textAlign="center" color="text-body-secondary">{!health ? notCollected : read ? t('진행 중이거나 예정된 이벤트가 없습니다.', 'No open or upcoming events.') : t('확인 가능한 계정이 없습니다.', 'No account could be checked.')}</Box>} columns={[
          { id: 'name', header: t('이벤트 유형', 'Event type'), minWidth: 240, cell: item => <Link external href={open(item.accountId, consoleLink.health())}>{item.name}</Link> },
          accountColumn,
          { id: 'region', header: t('리전', 'Region'), cell: item => item.detail ?? '—' },
          { id: 'service', header: t('서비스', 'Service'), cell: item => item.type ?? '—' },
          { id: 'category', header: t('분류', 'Category'), cell: item => category(item.version) },
          { id: 'state', header: t('상태', 'Status'), cell: item => <StatusIndicator type={item.state === 'upcoming' ? 'pending' : item.state === 'open' ? 'warning' : 'info'}>{item.state ?? '—'}</StatusIndicator> },
          { id: 'start', header: t('시작(예정)', 'Start (scheduled)'), cell: item => item.modified ? time(item.modified) : '—' },
        ]} />
    </SpaceBetween>);
  }
  if (view === 'accounts') {
    type AccountRow = NonNullable<SyncSummary['accounts']>[number];
    const accessCell = (account: AccountRow) => account.code === 'account_not_active' ? <StatusIndicator type="stopped">{t('비활성 계정', 'Inactive account')}</StatusIndicator>
      : ({ verified: <StatusIndicator type="success">{t('접근 확인', 'Verified')}</StatusIndicator>, denied: <StatusIndicator type="warning">{t('권한 없음(할당 없음)', 'No access (not assigned)')}</StatusIndicator>,
        failed: <StatusIndicator type="error">{t('확인 실패', 'Check failed')}</StatusIndicator>, pending: <StatusIndicator type="pending">{t('확인 전', 'Not checked')}</StatusIndicator> } as const)[account.access];
    const accounts = (sync?.accounts ?? []).filter(account => !accountScope.length || accountScope.includes(account.accountId));
    const accountFields: FilterField<AccountRow>[] = [{ key: 'account', label: t('계정', 'Account'), value: account => accountLabel(account.accountId) }, { key: 'lifecycle', label: t('수명주기', 'Lifecycle'), value: account => account.lifecycle },
      { key: 'access', label: t('접근', 'Access'), value: account => account.access }, { key: 'region', label: t('사용 리전', 'Region in use'), value: account => account.regions.filter(region => region.taggedVpcs > 0).map(region => region.region).join(' ') }];
    return page(<SpaceBetween size="l">
      <ResourceTable title={t('계정별 사용 리전', 'Regions in use per account')} description={t('사용 리전 = 태그가 있는 VPC가 하나 이상 있는 리전. 활성화돼 있어도 태그된 VPC가 없으면 사용하지 않는 리전으로 봅니다.', 'Region in use = at least one VPC with a tag. Enabled regions without a tagged VPC count as unused.')}
        items={accounts} trackBy={account => account.accountId} fields={accountFields} {...table('accounts.regions')} empty={<Box textAlign="center" color="text-body-secondary">{sync ? t('범위에 계정이 없습니다.', 'No accounts in scope.') : t('동기화하면 표시됩니다.', 'Shown after a sync.')}</Box>}
        columns={[
          { id: 'account', header: t('계정', 'Account'), cell: account => <span className="ops-mini-name">{account.name ?? account.accountId}{account.name ? <Box variant="small" color="text-body-secondary">{account.accountId}</Box> : null}</span> },
          { id: 'lifecycle', header: t('수명주기', 'Lifecycle'), cell: account => account.lifecycle ?? '—' },
          { id: 'access', header: t('접근', 'Access'), cell: accessCell },
          { id: 'regions', header: t('사용 리전 (VPC 태그)', 'Regions in use (tagged VPC)'), minWidth: 260, cell: account => { const used = account.regions.filter(region => region.taggedVpcs > 0);
            return used.length ? <div className="ops-badges">{used.map(region => <Badge key={region.region} color="blue">{`${region.region} · VPC ${region.taggedVpcs}/${region.vpcs}`}</Badge>)}</div> : <Box color="text-body-secondary">{account.access === 'verified' ? t('없음', 'None') : '—'}</Box>; } },
          { id: 'checked', header: t('확인한 리전', 'Regions checked'), cell: account => account.candidateRegions ? String(account.candidateRegions) : '—' },
          { id: 'excluded', header: t('수집하지 않은 리전', 'Regions not collected'), cell: account => account.candidateRegions ? String(Math.max(account.candidateRegions - account.regions.filter(region => region.taggedVpcs > 0).length, 0)) : '—' },
          { id: 'code', header: t('비고', 'Notes'), cell: account => !account.code || ['access_denied', 'sso_denied', 'account_not_active'].includes(account.code) ? '—' : account.code.startsWith('region_') ? t(`일부 리전 확인 실패 (${errorLabel(account.code.slice(7))})`, `Some regions unchecked (${errorLabel(account.code.slice(7))})`) : account.code.startsWith('config_') ? t('Config 조회 실패', 'Config query failed') : errorLabel(account.code) },
        ]} />
      {hasDirectoryScope ? <Container header={<Header variant="h2" description={directory ? time(directory.collectedAt) : notCollected} actions={<Button iconName="refresh" disabled={busy || !connected} onClick={onReadDirectory}>{t('다시 조회', 'Read again')}</Button>}>{t('조직 디렉터리 (Root/OU 탐색)', 'Organization directory (Root/OU)')}</Header>}>
        {directory ? <DirectoryPanel key={`${directory.parentId}:${directory.collectedAt}`} snapshot={directory} onNavigate={onNavigate} /> : <Box textAlign="center" color="text-body-secondary">{notCollected}</Box>}</Container>
        : <Alert type="info">{t('이 Payer에는 Organizations 조회 범위가 지정되지 않았습니다. 동기화는 Payer 계정만 대상으로 합니다.', 'No Organizations scope is configured for this payer. Sync covers the payer account only.')}</Alert>}
    </SpaceBetween>);
  }

  // Overview
  const alarmCounts = [{ title: 'ALARM', value: m.alarms?.alarm ?? 0, color: statusColor.critical }, { title: 'INSUFFICIENT_DATA', value: m.alarms?.insufficient ?? 0, color: statusColor.neutral },
    { title: 'OK', value: m.alarms ? m.alarms.total - m.alarms.alarm - m.alarms.insufficient : 0, color: statusColor.positive }].filter(item => item.value > 0);
  const ec2States = (() => { const counts = new Map<string, number>(); items('ec2').forEach(item => counts.set(item.state ?? 'unknown', (counts.get(item.state ?? 'unknown') ?? 0) + 1));
    return [...counts].map(([title, value]) => ({ title, value, color: title === 'running' ? statusColor.positive : title === 'stopped' ? statusColor.neutral : statusColor.info })); })();
  const cpuTop = cpuMetrics.flatMap(([id, label]) => items('metrics').filter(item => item.metric === id && item.peak !== undefined).map(item => ({ x: `${label} · ${item.name} · ${item.region}`, y: Math.round(item.peak! * 10) / 10 })))
    .sort((left, right) => right.y - left.y).slice(0, 8);
  const resources = resourceServices.flatMap(service => items(service));
  const byRegion = [...resources.reduce((counts, item) => counts.set(item.region, (counts.get(item.region) ?? 0) + 1), new Map<string, number>())].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([x, y]) => ({ x, y }));
  const byAccount = [...resources.reduce((counts, item) => counts.set(item.accountId, (counts.get(item.accountId) ?? 0) + 1), new Map<string, number>())].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([id, y]) => ({ x: accountNames.get(id) ?? id, y }));
  const regionUse = [...(sync?.accounts ?? []).filter(account => !accountScope.length || accountScope.includes(account.accountId)).flatMap(account => account.regions.filter(region => region.taggedVpcs > 0).map(region => region.region))
    .reduce((counts, region) => counts.set(region, (counts.get(region) ?? 0) + 1), new Map<string, number>())].sort((a, b) => b[1] - a[1]).map(([x, y]) => ({ x, y }));
  const lambdaWithErrors = items('metrics').filter(item => item.metric === 'lambda_errors' && (item.peak ?? 0) > 0).length;
  const eosRows = lifecycleRows(data);
  const cards: Array<[DashboardView, string, string, string, string]> = [
    ['ec2', 'EC2', m.ec2 ? `${m.ec2.running} / ${m.ec2.total}` : '—', m.ec2 ? t('실행 중 / 전체', 'running / total') : notCollected, ''],
    ['eks', 'EKS', m.eks ? String(m.eks.total) : '—', m.eks ? t(`확장 지원 ${m.eks.extended} · 지원 종료 ${m.eks.unsupported}`, `extended ${m.eks.extended} · unsupported ${m.eks.unsupported}`) : notCollected, m.eks?.unsupported ? 'critical' : m.eks?.extended ? 'attention' : ''],
    ['rds', 'RDS', m.rds ? `${m.rds.available} / ${m.rds.total}` : '—', m.rds ? t('사용 가능 / 전체', 'available / total') : notCollected, m.rds && m.rds.available < m.rds.total ? 'attention' : ''],
    ['elasticache', 'ElastiCache', m.elasticache ? `${m.elasticache.available} / ${m.elasticache.total}` : '—', m.elasticache ? t('사용 가능 / 전체', 'available / total') : notCollected, m.elasticache && m.elasticache.available < m.elasticache.total ? 'attention' : ''],
    ['msk', 'MSK', m.msk ? `${m.msk.active} / ${m.msk.total}` : '—', m.msk ? t('ACTIVE / 전체', 'ACTIVE / total') : notCollected, m.msk && m.msk.active < m.msk.total ? 'attention' : ''],
    ['alarms', t('CloudWatch 경보', 'CloudWatch alarms'), m.alarms ? `${m.alarms.alarm} / ${m.alarms.total}` : '—', m.alarms ? t('ALARM / 전체', 'ALARM / total') : notCollected, m.alarms?.alarm ? 'critical' : m.alarms?.insufficient ? 'attention' : ''],
    ['serverless', 'Serverless', m.lambda || m.dynamodb || m.apigateway ? `${m.lambda?.total ?? '—'} · ${m.dynamodb?.total ?? '—'} · ${m.apigateway?.total ?? '—'}` : '—', t('Lambda · DynamoDB · API', 'Lambda · DynamoDB · APIs'), m.lambda?.deprecated ? 'attention' : ''],
    ['ssm', 'Systems Manager', m.ssm ? `${m.ssm.online} / ${m.ssm.total}` : '—', m.ssm ? t(`온라인 / 관리 노드 · 미관리 EC2 ${m.ssm.unmanaged}`, `online / managed · unmanaged EC2 ${m.ssm.unmanaged}`) : notCollected, m.patch?.nonCompliant || m.automation?.failed ? 'attention' : ''],
    ['lifecycle', t('수명주기(EOS)', 'Lifecycle (EOS)'), eosRows.length ? `${eosRows.filter(row => row.status === 'ended').length} · ${eosRows.filter(row => row.status === 'extended' || row.status === 'deprecated').length}` : '—',
      eosRows.length ? t(`종료 · 확장/중단 · 예정 ${eosRows.filter(row => row.status === 'upcoming').length}`, `ended · extended/deprecated · upcoming ${eosRows.filter(row => row.status === 'upcoming').length}`) : notCollected,
      eosRows.some(row => row.status === 'ended') ? 'critical' : eosRows.some(row => row.status === 'extended' || row.status === 'deprecated') ? 'attention' : ''],
    ['security', t('보안 태세', 'Security posture'), m.securityhub || m.guardduty ? `${m.securityhub?.critical ?? '—'} · ${m.guardduty?.threats ?? '—'}` : '—',
      m.securityhub || m.guardduty ? t(`Security Hub 심각 · GuardDuty 위협 · 미사용 ${(m.securityhub?.off ?? 0) + (m.guardduty?.off ?? 0)}`, `Security Hub critical · GuardDuty threats · ${(m.securityhub?.off ?? 0) + (m.guardduty?.off ?? 0)} not enabled`) : notCollected,
      m.securityhub?.critical || m.guardduty?.threats ? 'critical' : m.securityhub?.high || m.securityhub?.off || m.guardduty?.off ? 'attention' : ''],
    ['tags', t('태그 준수', 'Tag compliance'), m.tags && m.tags.compliant + m.tags.missing ? `${Math.round(m.tags.compliant / (m.tags.compliant + m.tags.missing) * 100)}%` : '—',
      m.tags ? t(`누락 ${m.tags.missing} · 미수집 ${m.tags.unknown}`, `missing ${m.tags.missing} · not collected ${m.tags.unknown}`) : requiredTags.length ? notCollected : t('필수 태그 미설정', 'No required tags set'), m.tags?.missing ? 'attention' : ''],
    ['accounts', t('조직 계정', 'Organization accounts'), sync ? `${sync.accounts.filter(account => account.access === 'verified').length} / ${sync.accounts.length}` : '—', sync ? t(`접근 확인 / 범위 · 사용 리전 ${usedRegions.size}`, `verified / in scope · ${usedRegions.size} regions in use`) : hasDirectoryScope ? notCollected : t('Payer만', 'Payer only'), sync?.accounts.some(account => account.access === 'denied' || account.access === 'failed') ? 'attention' : ''],
  ];
  const dataRows = [...items('rds').map(item => ({ key: `rds:${item.accountId}:${item.region}:${item.name}`, name: <Link external href={open(item.accountId, consoleLink.rds(item.region, item.name))}>{item.name}</Link>, detail: `RDS · ${item.version ?? ''} · ${item.region}`, status: state(item.state) })),
    ...items('elasticache').map(item => ({ key: `cache:${item.accountId}:${item.region}:${item.name}`, name: <Link external href={open(item.accountId, consoleLink.elasticache(item.region))}>{item.name}</Link>, detail: `ElastiCache · ${item.version ?? ''} · ${item.region}`, status: state(item.state) }))];
  return page(<SpaceBetween size="l">
    <div className="ops-metric-grid ops-metric-grid-wide" aria-label={t('운영 요약', 'Operations summary')}>
      <div className={`account-state-card ops-overall ops-overall-${assessment.overall}`}><span>{t('운영 상태', 'Operations status')}</span>
        <StatusIndicator type={overall.type}>{overall.label}</StatusIndicator>
        <span>{t(`조치 ${assessment.counts.critical} · 주의 ${assessment.counts.warning} · 참고 ${assessment.counts.info}`, `Action ${assessment.counts.critical} · Attention ${assessment.counts.warning} · Info ${assessment.counts.info}`)}</span></div>
      {cards.map(([target, label, value, detailText, severity]) => <a key={target} href={viewHref(target)} className={`account-state-card ops-card-link ${severity ? `account-state-${severity}` : ''}`}>
        <span>{label}</span><strong>{value}</strong><span>{detailText}</span></a>)}
    </div>
    <Container header={<Header variant="h2" counter={`(${assessment.findings.length})`} description={t('수집한 근거로만 판정합니다. 수집하지 않은 영역은 정상으로 간주하지 않습니다.', 'Derived only from collected evidence. Areas not collected are never assumed healthy.')}
      actions={assessment.findings.length > 10 ? <Button onClick={() => setAllFindings(value => !value)}>{allFindings ? t('상위 10개만 보기', 'Show top 10') : t(`모두 보기 (${assessment.findings.length})`, `Show all (${assessment.findings.length})`)}</Button> : undefined}>{t('조치·주의 항목', 'Action and attention items')}</Header>}>
      {findingsTable(allFindings ? undefined : 10)}</Container>
    <div className="ops-widget-grid">
      {widget(t('CPU 사용률 상위', 'Top CPU utilization'), undefined, 'metrics', `${source('metrics')} · ${t('지난 1시간 최고값', 'last-hour peak')}`,
        cpuTop.length ? <BarChart series={[{ title: t('CPU 최고(%)', 'Peak CPU (%)'), type: 'bar', data: cpuTop }]} horizontalBars hideFilter hideLegend height={Math.max(120, cpuTop.length * 32)} yDomain={[0, 100]}
          xScaleType="categorical" yTitle="%" ariaLabel={t('CPU 사용률 상위 자원', 'Resources with the highest CPU')} i18nStrings={barStrings} />
          : empty('metrics', t('최근 1시간 EC2·RDS·ElastiCache·MSK CPU 데이터가 없습니다.', 'No EC2/RDS/ElastiCache/MSK CPU data in the last hour.')), true)}
      {widget(t('경보 상태', 'Alarm states'), m.alarms ? `(${m.alarms.total})` : undefined, 'alarms', source('alarms'),
        alarmCounts.length ? <PieChart data={alarmCounts} variant="donut" size="medium" hideFilter innerMetricValue={String(m.alarms?.alarm ?? 0)} innerMetricDescription="ALARM"
          ariaLabel={t('경보 상태 분포', 'Alarm state distribution')} i18nStrings={pieStrings} detailPopoverContent={datum => [{ key: t('경보 수', 'Alarms'), value: datum.value }]}
          segmentDescription={(datum, sum) => `${datum.value} (${Math.round(datum.value / sum * 100)}%)`} />
          : empty('alarms', t('경보가 없습니다.', 'No alarms.')))}
      {widget(t('리전별 자원', 'Resources by region'), resources.length ? `(${resources.length})` : undefined, 'ec2', t('EC2·EKS·RDS·ElastiCache·MSK·Serverless 합계', 'EC2, EKS, RDS, ElastiCache, MSK and serverless'),
        byRegion.length ? <BarChart series={[{ title: t('자원 수', 'Resources'), type: 'bar', data: byRegion }]} horizontalBars hideFilter hideLegend height={Math.max(100, byRegion.length * 30)} xScaleType="categorical"
          yTitle={t('자원 수', 'Resources')} ariaLabel={t('리전별 자원 수', 'Resources by region')} i18nStrings={barStrings} /> : empty(undefined, sync ? t('자원이 없습니다.', 'No resources.') : notCollected))}
      {widget(t('계정별 자원', 'Resources by account'), undefined, 'accounts', t('상위 10개 계정', 'Top 10 accounts'),
        byAccount.length ? <BarChart series={[{ title: t('자원 수', 'Resources'), type: 'bar', data: byAccount }]} horizontalBars hideFilter hideLegend height={Math.max(100, byAccount.length * 30)} xScaleType="categorical"
          yTitle={t('자원 수', 'Resources')} ariaLabel={t('계정별 자원 수', 'Resources by account')} i18nStrings={barStrings} /> : empty(undefined, sync ? t('자원이 없습니다.', 'No resources.') : notCollected))}
      {widget(t('EC2 인스턴스 상태', 'EC2 instance states'), m.ec2 ? `(${m.ec2.total})` : undefined, 'ec2', source('ec2'),
        ec2States.length ? <PieChart data={ec2States} variant="donut" size="medium" hideFilter innerMetricValue={String(m.ec2?.running ?? 0)} innerMetricDescription={t('실행 중', 'running')}
          ariaLabel={t('EC2 상태 분포', 'EC2 state distribution')} i18nStrings={pieStrings} detailPopoverContent={datum => [{ key: t('인스턴스 수', 'Instances'), value: datum.value }]}
          segmentDescription={(datum, sum) => `${datum.value} (${Math.round(datum.value / sum * 100)}%)`} />
          : empty('ec2', t('인스턴스가 없습니다.', 'No instances.')))}
      {widget(t('EKS 버전 지원', 'EKS version support'), counter('eks'), 'eks', source('eks'),
        items('eks').length ? miniList(items('eks').slice(0, 6).map(item => ({ key: `${item.accountId}:${item.region}:${item.name}`, name: <Link external href={open(item.accountId, consoleLink.eks(item.region, item.name))}>{item.name}</Link>, detail: [item.version && `Kubernetes ${item.version}`, item.region].filter(Boolean).join(' · '), status: support(item) })))
          : empty('eks', t('클러스터가 없습니다.', 'No clusters.')))}
      {widget(t('데이터베이스·캐시', 'Databases and caches'), collected('rds') || collected('elasticache') ? `(${dataRows.length})` : undefined, 'rds', `RDS ${source('rds')}`,
        dataRows.length ? miniList(dataRows.slice(0, 6)) : collected('rds') || collected('elasticache') ? <Box textAlign="center" color="text-body-secondary">{t('RDS·ElastiCache 자원이 없습니다.', 'No RDS or ElastiCache resources.')}</Box> : empty('rds', ''))}
      {widget('MSK', counter('msk'), 'msk', source('msk'),
        items('msk').length ? miniList(items('msk').slice(0, 6).map(item => ({ key: `${item.accountId}:${item.region}:${item.name}`, name: <Link external href={open(item.accountId, consoleLink.msk(item.region))}>{item.name}</Link>, detail: [item.version && `Kafka ${item.version}`, item.region, collected('metrics') && t(`디스크 최고 ${metricCell('msk_disk', item, item.name)}`, `disk peak ${metricCell('msk_disk', item, item.name)}`)].filter(Boolean).join(' · '), status: state(item.state) })))
          : empty('msk', t('Kafka 클러스터가 없습니다.', 'No Kafka clusters.')))}
      {widget('Serverless', undefined, 'serverless', source('lambda'),
        collected('lambda') || collected('dynamodb') || collected('apigateway') ? <dl className="ops-stat-list">
          <div><dt>{t('Lambda 함수', 'Lambda functions')}</dt><dd>{m.lambda ? m.lambda.total : notCollected}</dd></div>
          <div><dt>{t('지원 종료 런타임', 'Deprecated runtimes')}</dt><dd>{m.lambda ? m.lambda.deprecated : notCollected}</dd></div>
          <div><dt>{t('최근 1시간 오류가 있는 함수', 'Functions with errors (1h)')}</dt><dd>{collected('metrics') ? lambdaWithErrors : notCollected}</dd></div>
          <div><dt>{t('DynamoDB 테이블', 'DynamoDB tables')}</dt><dd>{m.dynamodb ? m.dynamodb.total : notCollected}</dd></div>
          <div><dt>API Gateway</dt><dd>{m.apigateway ? m.apigateway.total : notCollected}</dd></div>
        </dl> : empty('lambda', ''))}
      {widget('Systems Manager', undefined, 'ssm', source('ssm'),
        collected('ssm') || collected('patch') || collected('automation') ? <dl className="ops-stat-list">
          <div><dt>{t('관리 노드 (온라인 / 전체)', 'Managed nodes (online / total)')}</dt><dd>{m.ssm ? `${m.ssm.online} / ${m.ssm.total}` : notCollected}</dd></div>
          <div><dt>{t('SSM 미관리 실행 중 EC2', 'Running EC2 not managed by SSM')}</dt><dd>{m.ssm ? m.ssm.unmanaged : notCollected}</dd></div>
          <div><dt>{t('패치 비준수', 'Patch non-compliant')}</dt><dd>{m.patch ? m.patch.nonCompliant : notCollected}</dd></div>
          <div><dt>{t('실패한 Automation (7일)', 'Failed Automation (7 days)')}</dt><dd>{m.automation ? m.automation.failed : notCollected}</dd></div>
        </dl> : empty('ssm', ''))}
      {widget(t('수명주기(EOS) 일정', 'Lifecycle (EOS) schedule'), eosRows.length ? `(${eosRows.filter(row => row.status !== 'supported').length})` : undefined, 'lifecycle', t(`종료·확장 지원·${upcomingWindowDays}일 내 예정`, `ended, extended and within ${upcomingWindowDays} days`),
        eosRows.some(row => row.status !== 'supported' && row.status !== 'unknown') ? miniList(eosRows.filter(row => row.status !== 'supported' && row.status !== 'unknown').slice(0, 6).map(row => ({ key: `${row.service}:${row.accountId}:${row.region}:${row.id ?? row.name}`, name: row.name,
          detail: `${row.component} ${row.current} · ${row.region}${row.date ? ` · ${dateOnly(row.date)}` : ''}`, status: eosIndicator(row.status) }))) : <Box textAlign="center" color="text-body-secondary">{eosRows.length ? t('종료·예정 항목이 없습니다.', 'Nothing ended or ending soon.') : notCollected}</Box>)}
      {widget(t('보안 태세', 'Security posture'), undefined, 'security', `Security Hub ${source('securityhub')}`,
        collected('securityhub') || collected('guardduty') ? <dl className="ops-stat-list">
          <div><dt>Security Hub CRITICAL · HIGH</dt><dd>{m.securityhub ? `${m.securityhub.critical} · ${m.securityhub.high}` : notCollected}</dd></div>
          <div><dt>{t('GuardDuty 위협 (7.0 이상)', 'GuardDuty threats (7.0+)')}</dt><dd>{m.guardduty ? m.guardduty.threats : notCollected}</dd></div>
          <div><dt>{t('Security Hub 미사용 리전', 'Regions without Security Hub')}</dt><dd>{m.securityhub ? m.securityhub.off : notCollected}</dd></div>
          <div><dt>{t('GuardDuty 미사용 리전', 'Regions without GuardDuty')}</dt><dd>{m.guardduty ? m.guardduty.off : notCollected}</dd></div>
        </dl> : empty('securityhub', ''))}
      {widget(t('태그 준수', 'Tag compliance'), undefined, 'tags', requiredTags.length ? t(`필수 태그: ${requiredTags.join(', ')}`, `Required: ${requiredTags.join(', ')}`) : t('필수 태그 미설정', 'No required tags set'),
        m.tags ? <dl className="ops-stat-list">
          <div><dt>{t('준수율', 'Compliance rate')}</dt><dd>{m.tags.compliant + m.tags.missing ? `${Math.round(m.tags.compliant / (m.tags.compliant + m.tags.missing) * 100)}%` : '—'}</dd></div>
          <div><dt>{t('준수', 'Compliant')}</dt><dd>{m.tags.compliant}</dd></div>
          <div><dt>{t('누락', 'Missing')}</dt><dd>{m.tags.missing}</dd></div>
          <div><dt>{t('태그 미수집', 'Tags not collected')}</dt><dd>{m.tags.unknown}</dd></div>
        </dl> : <Box textAlign="center" color="text-body-secondary">{requiredTags.length ? notCollected : t('서버 설정에 필수 태그를 지정하면 평가합니다.', 'Evaluated once required tags are configured on the server.')}</Box>)}
      {widget('AWS Health', counter('health'), 'health', source('health'),
        items('health').length ? miniList(items('health').slice(0, 6).map(item => ({ key: `${item.accountId}:${item.name}:${item.modified ?? ''}`, name: item.name, detail: [item.type, item.detail, item.modified && dateOnly(item.modified)].filter(Boolean).join(' · '),
          status: <StatusIndicator type={item.state === 'upcoming' ? 'pending' : 'warning'}>{item.state ?? '—'}</StatusIndicator> })))
          : <Box textAlign="center" color="text-body-secondary">{!collected('health') ? notCollected : data.health!.units.some(unit => !unit.code) ? t('진행 중·예정 이벤트가 없습니다.', 'No open or upcoming events.') : t('확인 불가 (Business 이상 지원 플랜 필요)', 'Unavailable (Business support plan or higher required)')}</Box>)}
      {widget(t('리전 사용 현황', 'Region usage'), sync ? `(${usedRegions.size})` : undefined, 'accounts', t('리전별 사용 계정 수 (VPC 태그 기준)', 'Accounts using each region (tagged VPC)'),
        regionUse.length ? <BarChart series={[{ title: t('계정 수', 'Accounts'), type: 'bar', data: regionUse }]} horizontalBars hideFilter hideLegend height={Math.max(100, regionUse.length * 30)} xScaleType="categorical"
          yTitle={t('계정 수', 'Accounts')} ariaLabel={t('리전별 사용 계정 수', 'Accounts per region in use')} i18nStrings={barStrings} /> : <Box textAlign="center" color="text-body-secondary">{sync ? t('태그된 VPC가 있는 리전이 없습니다.', 'No region has a tagged VPC.') : notCollected}</Box>, 'full')}
    </div>
  </SpaceBetween>);
}
