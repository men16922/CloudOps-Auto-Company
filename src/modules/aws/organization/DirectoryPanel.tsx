import { useState } from 'react';
import Alert from '@cloudscape-design/components/alert';
import Button from '@cloudscape-design/components/button';
import Container from '@cloudscape-design/components/container';
import Header from '@cloudscape-design/components/header';
import KeyValuePairs from '@cloudscape-design/components/key-value-pairs';
import Select from '@cloudscape-design/components/select';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Table from '@cloudscape-design/components/table';
import { useLanguage } from '../../../i18n';
import { accountLifecycleSchema, type DirectorySnapshot } from '../domain/directory';

const lifecycleLabels = {
  PENDING_ACTIVATION: ['활성화 대기', 'Pending activation'], ACTIVE: ['활성', 'Active'], SUSPENDED: ['일시 중지', 'Suspended'],
  PENDING_CLOSURE: ['폐쇄 대기', 'Pending closure'], CLOSED: ['폐쇄', 'Closed'], UNKNOWN: ['미확인', 'Unknown'],
} as const;

export default function DirectoryPanel({ snapshot, onNavigate }: { snapshot: DirectorySnapshot; onNavigate(cursor: string): void }) {
  const { t, locale } = useLanguage(), [filter, setFilter] = useState('all');
  const { accounts, organizationalUnits: ous } = snapshot;
  const expired = Date.parse(snapshot.navigation.expiresAt) <= Date.now();
  const labels = [{ value: 'all', label: t('모든 수명주기', 'All lifecycle states') }, ...accountLifecycleSchema.options.map(value => ({ value, label: t(lifecycleLabels[value][0], lifecycleLabels[value][1]) }))];
  return <Container header={<Header variant="h3">{t('조직 디렉터리 관측', 'Organization directory observation')}</Header>}><SpaceBetween size="m">
    <KeyValuePairs columns={2} items={[
      { label: t('AWS 조직', 'AWS organization'), value: snapshot.scope.awsOrganizationId },
      { label: t('현재 Root / OU', 'Current root / OU'), value: `${snapshot.parentName ?? ''} · ${snapshot.parentId}` },
      { label: t('수집 완료 시각', 'Collection finished'), value: new Date(snapshot.collectedAt).toLocaleString(locale) },
      { label: t('조회 주체의 계정', 'Querying account'), value: snapshot.accountId },
    ]} />
    <SpaceBetween direction="horizontal" size="xs">{snapshot.navigation.path.map((node, index) => <Button key={node.id} disabled={expired} onClick={() => onNavigate(node.cursor)}>{index === 0 ? t('설정 범위 처음부터', 'Configured scope start') : node.name}</Button>)}</SpaceBetween>
    {expired ? <Alert type="warning">{t('탐색 시간이 만료됐습니다. 지정 Root/OU 계정 상태를 새로 조회하세요.', 'Navigation has expired. Read the configured root/OU again.')}</Alert> : null}
    <Alert type="info">{t('현재 Root/OU의 바로 아래 계정과 OU를 각각 한 페이지씩 조회합니다. OU 이름으로 들어가거나 다음 페이지를 선택하세요. 페이지 수치를 조직 총계로 합산하지 않습니다. ACTIVE는 수명주기이며 서비스 정상이나 접근 권한을 뜻하지 않습니다.', 'Each read collects one page of direct accounts and OUs. Open an OU or choose the next page. Page counts are not organization totals. ACTIVE describes lifecycle, not service health or access.')}</Alert>
    <div className="account-state-grid" aria-label={t('관측 페이지 요약', 'Observed page summary')}>{[
      { label: t('반환된 계정', 'Returned accounts'), value: accounts.status === 'collected' ? accounts.items.length : '—' },
      { label: t('활성 계정', 'Active accounts'), value: accounts.status === 'collected' ? accounts.items.filter(item => item.lifecycle === 'ACTIVE').length : '—' },
      { label: t('상태 확인 필요', 'Lifecycle review'), value: accounts.status === 'collected' ? accounts.items.filter(item => item.lifecycle !== 'ACTIVE').length : '—' },
      { label: t('반환된 하위 OU', 'Returned child OUs'), value: ous.status === 'collected' ? ous.items.length : '—' },
    ].map(item => <div className="account-state-card" key={item.label}><span>{item.label}</span><strong>{item.value}</strong><span>{t('이 관측 페이지', 'This observation page')}</span></div>)}</div>
    {accounts.status !== 'collected' ? <Alert type={accounts.status === 'denied' ? 'warning' : 'error'} header={t('계정 목록 미수집', 'Accounts not collected')}>{accounts.status === 'denied' ? t('현재 역할의 Organizations 조회가 거절되어 계정 목록을 수집하지 못했습니다. AWS 연결 상태와 서비스 점검 결과는 별도입니다.', 'An Organizations query was denied for this role; accounts were not collected. AWS connection state and service inspection are separate.') : t('계정 조회 결과를 확인할 수 없습니다. 계정 수를 0으로 판단하지 않습니다.', 'Account results could not be verified. This does not establish an account count of zero.')}</Alert> : <>
      <Table items={accounts.items.filter(item => filter === 'all' || item.lifecycle === filter)} trackBy="id"
        header={<Header variant="h3" description={`${t('페이지', 'Page')} ${accounts.pageNumber}`}>{t('바로 아래 계정', 'Direct child accounts')}</Header>}
        filter={<Select ariaLabel={t('계정 수명주기 필터', 'Account lifecycle filter')} options={labels} selectedOption={labels.find(item => item.value === filter)!} onChange={({ detail }) => setFilter(detail.selectedOption.value!)} />}
        columnDefinitions={[
          { id: 'name', header: t('계정', 'Account'), cell: item => <><strong>{item.name}</strong><br /><span className="aws-account-id">{item.id}</span></> },
          { id: 'lifecycle', header: t('Organizations 수명주기', 'Organizations lifecycle'), cell: item => <StatusIndicator type={item.lifecycle === 'ACTIVE' ? 'info' : item.lifecycle === 'UNKNOWN' ? 'pending' : 'warning'}>{t(lifecycleLabels[item.lifecycle][0], lifecycleLabels[item.lifecycle][1])}</StatusIndicator> },
          { id: 'access', header: t('사용자 접근', 'User access'), cell: () => t('미확인', 'Not checked') },
          { id: 'inspection', header: t('서비스 점검', 'Service inspection'), cell: () => t('미수집', 'Not collected') },
        ]} empty={<p>{accounts.items.length ? t('이 필터에 해당하는 계정이 없습니다.', 'No accounts match this filter.') : t('이번 페이지에 반환된 계정이 없습니다.', 'No accounts were returned on this page.')}</p>} />
      {accounts.hasMore ? <Alert type="warning">{t('계정의 다음 페이지가 있습니다. 빈 페이지여도 전체 계정이 0개라는 뜻은 아닙니다.', 'There are more account pages. An empty page does not establish that no accounts exist.')}</Alert> : null}
      {accounts.hasMore ? <Button disabled={expired || !accounts.nextCursor} onClick={() => accounts.nextCursor && onNavigate(accounts.nextCursor)}>{t('계정 다음 페이지', 'Next account page')}</Button> : null}
    </>}
    <p style={{ overflowWrap: 'anywhere' }}>{accounts.source} · {new Date(accounts.observedAt).toLocaleString(locale)}</p>
    {ous.status !== 'collected' ? <Alert type="warning" header={t('OU 목록 미수집', 'OUs not collected')}>{ous.status === 'denied' ? t('현재 역할의 Organizations 조회가 거절되어 OU 목록을 수집하지 못했습니다.', 'An Organizations query was denied for this role; OUs were not collected.') : t('OU 조회 결과를 확인할 수 없습니다.', 'OU results could not be verified.')}</Alert> : <>
      <Table items={ous.items} trackBy="id" header={<Header variant="h3" description={`${t('페이지', 'Page')} ${ous.pageNumber}`}>{t('바로 아래 OU', 'Direct child OUs')}</Header>} columnDefinitions={[
        { id: 'name', header: t('이름', 'Name'), cell: item => item.browseCursor ? <Button variant="inline-link" disabled={expired} onClick={() => onNavigate(item.browseCursor!)}>{item.name}</Button> : item.name }, { id: 'id', header: 'OU ID', cell: item => item.id },
      ]} empty={<p>{t('이번 페이지에 반환된 OU가 없습니다.', 'No OUs were returned on this page.')}</p>} />
      {ous.hasMore ? <Alert type="warning">{t('OU의 다음 페이지가 있습니다.', 'There are more OU pages.')}</Alert> : null}
      {ous.hasMore ? <Button disabled={expired || !ous.nextCursor} onClick={() => ous.nextCursor && onNavigate(ous.nextCursor)}>{t('OU 다음 페이지', 'Next OU page')}</Button> : null}
    </>}
    <p style={{ overflowWrap: 'anywhere' }}>{ous.source} · {new Date(ous.observedAt).toLocaleString(locale)}</p>
  </SpaceBetween></Container>;
}
