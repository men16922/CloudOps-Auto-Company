import { awsModule } from '../manifest';
import { useState } from 'react';
import Alert from '@cloudscape-design/components/alert';
import Button from '@cloudscape-design/components/button';
import Container from '@cloudscape-design/components/container';
import Header from '@cloudscape-design/components/header';
import Select from '@cloudscape-design/components/select';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Table from '@cloudscape-design/components/table';
import { useLanguage } from '../../../i18n';
import ModuleShell from '../../shared/ModuleShell';
import { useOrganizationAccess } from '../../../platform/OrganizationAccess';
import ConnectedAccounts from './ConnectedAccounts';

type AccountState = 'observed' | 'attention' | 'unknown';
type AccountRow = { id: string; name: string; ou: string; access: 'connected' | 'expired' | 'denied'; state: AccountState; observedAt: string | null };
// Explicit preview only. These are never used as membership, AWS connections or execution targets.
const previewAccounts: AccountRow[] = [
  { id: 'demo-production', name: 'Production · Example', ou: 'Workloads / Production', access: 'connected', state: 'attention', observedAt: '2026-10-09T09:00:00Z' },
  { id: 'demo-development', name: 'Development · Example', ou: 'Workloads / Development', access: 'connected', state: 'observed', observedAt: '2026-10-09T09:00:00Z' },
  { id: 'demo-security', name: 'Security · Example', ou: 'Security', access: 'expired', state: 'unknown', observedAt: null },
  { id: 'demo-shared', name: 'Shared services · Example', ou: 'Infrastructure', access: 'denied', state: 'unknown', observedAt: null },
];

export default function AccountDashboard({ company = false }: { company?: boolean }) {
  const { t, locale } = useLanguage();
  const webAccess = useOrganizationAccess();
  const [preview, setPreview] = useState(false), [filter, setFilter] = useState('all');
  const [selected, setSelected] = useState<AccountRow>();
  const accounts = preview ? previewAccounts : [];
  const labels = { observed: t('점검됨', 'Inspected'), attention: t('후속 확인', 'Follow-up'), unknown: t('미확인', 'Unknown') };
  const access = { connected: t('접근 확인', 'Access verified'), expired: t('세션 만료', 'Session expired'), denied: t('접근 거절', 'Access denied') };
  const options = [{ label: t('모든 계정', 'All accounts'), value: 'all' }, ...Object.entries(labels).map(([value, label]) => ({ value, label }))];
  return <ModuleShell icon={awsModule.icon} name="AWS" edition="organization" href="#/organization/aws" company={company}><SpaceBetween size="l">
    <Header variant="h1" description={t('조직과 OU에서 계정별 접근·점검·후속 확인 상태를 살펴봅니다.', 'Review account access, inspections and follow-up by organization and OU.')}
      actions={<Button onClick={() => { setPreview(value => !value); setSelected(undefined); setFilter('all'); }}>{preview ? t('예시 닫기', 'Close example') : t('합성 계정 예시 보기', 'View synthetic account example')}</Button>}>
      {t('조직 AWS 계정 상태', 'Organization AWS account status')}
    </Header>
    {webAccess.state === 'ready' ? <ConnectedAccounts client={webAccess.client} scope={webAccess.scope} /> : webAccess.state === 'loading' ? <StatusIndicator type="loading">{t('조직 로그인 설정 확인 중', 'Checking organization sign-in configuration')}</StatusIndicator> : webAccess.state === 'failed' ? <Alert type="error">{t('조직 로그인 설정을 확인할 수 없습니다.', 'Organization sign-in configuration could not be verified.')}</Alert> : null}
    {preview ? <Alert type="warning" header={t('합성 계정 예시', 'Synthetic account example')}>{t('화면 구성을 확인하는 예시입니다. 실제 AWS 계정·로그인·수집 결과가 아니며 실행 대상으로 사용할 수 없습니다.', 'This is a layout example, not real AWS accounts, sign-in or collected results. These rows cannot be execution targets.')}</Alert>
      : webAccess.state !== 'ready' ? <Alert type="info" header={t('조직 계정 연결이 필요합니다', 'Connect organization accounts')}>{t('웹 로그인과 구성원 확인 후 본인에게 할당된 AWS 연결을 사용합니다. 현재 회사 로그인과 계정 수집은 연결되지 않았습니다.', 'Use your assigned AWS connections after web sign-in and membership verification. Company sign-in and account collection are not connected yet.')}</Alert> : null}
    {preview || webAccess.state !== 'ready' ? <><div className="account-state-grid" aria-label={t('계정 상태 요약', 'Account state summary')}>{[
      { key: 'all', label: t('범위 내 계정', 'Accounts in scope'), count: accounts.length },
      ...(['observed', 'attention', 'unknown'] as const).map(key => ({ key, label: labels[key], count: accounts.filter(row => row.state === key).length })),
    ].map(item => <button key={item.key} className={`account-state-card account-state-${item.key}`} aria-pressed={filter === item.key} onClick={() => setFilter(item.key)} disabled={!preview}>
      <span>{item.label}</span><strong>{preview ? item.count : '—'}</strong><span>{preview ? t('예시 계정', 'Example accounts') : t('수집 전', 'Not collected')}</span>
    </button>)}</div>
    <Table items={accounts.filter(row => filter === 'all' || row.state === filter)} trackBy="id"
      header={<Header variant="h2">{t('계정별 상태', 'Account state')}</Header>}
      filter={<Select ariaLabel={t('점검 상태 필터', 'Inspection state filter')} options={options} selectedOption={options.find(option => option.value === filter)!} onChange={({ detail }) => setFilter(detail.selectedOption.value!)} />}
      columnDefinitions={[
        { id: 'account', header: t('계정', 'Account'), cell: row => <Button variant="inline-link" onClick={() => setSelected(row)}>{row.name}</Button> },
        { id: 'ou', header: 'OU', cell: row => row.ou },
        { id: 'access', header: t('접근 상태', 'Access'), cell: row => <StatusIndicator type={row.access === 'connected' ? 'success' : row.access === 'expired' ? 'warning' : 'error'}>{access[row.access]}</StatusIndicator> },
        { id: 'state', header: t('점검 결과', 'Inspection'), cell: row => <StatusIndicator type={row.state === 'observed' ? 'info' : row.state === 'attention' ? 'warning' : 'pending'}>{labels[row.state]}</StatusIndicator> },
        { id: 'time', header: t('예시 수집 시각', 'Example observation time'), cell: row => row.observedAt ? new Date(row.observedAt).toLocaleString(locale) : t('수집 근거 없음', 'No observation') },
      ]} empty={<p>{preview ? t('선택한 상태의 계정이 없습니다.', 'No accounts match this state.') : t('계정 수집 전입니다. 0개 또는 정상으로 판정하지 않습니다.', 'Accounts have not been collected. This does not mean zero accounts or healthy state.')}</p>} /></> : null}
    {selected ? <Container header={<Header variant="h2">{selected.name}</Header>}><SpaceBetween size="m"><p>{t('합성 예시 · 계정별 인계', 'Synthetic example · Account handoff')}</p>
      <p>{selected.state === 'attention' ? t('CloudWatch 경보의 근거와 최근 변경을 확인할 후속 업무가 있습니다. 로그인 성공이 계정 정상 판정은 아닙니다.', 'Follow up on CloudWatch alarm evidence and recent changes. Successful sign-in does not establish account health.') : selected.state === 'unknown' ? t('유효한 접근과 수집 근거를 먼저 확보해야 합니다. 미확인을 정상으로 바꾸지 않습니다.', 'Establish valid access and collect evidence first. Unknown state is not treated as healthy.') : t('선택한 점검 범위의 근거가 있는 예시입니다. 계정 전체의 정상 상태를 보증하지 않습니다.', 'This example has evidence for the selected inspection scope. It does not establish the health of the entire account.')}</p>
    </SpaceBetween></Container> : null}
    <Container header={<Header variant="h2">{t('연결과 운영 범위', 'Connection and operations scope')}</Header>}><p>{t('사용자별 SSO 프로필과 캐시를 사용하며, 선택한 한 계정·리전부터 조회합니다. OU와 Payer 선택은 접근 권한을 부여하지 않습니다.', 'Each user has an isolated SSO profile and cache. Start with one selected account and region. Selecting an OU or payer does not grant access.')}</p>
      {!company ? <Button href="#/organization/sign-in">{t('Device Code 연결 화면', 'Device Code connection screen')}</Button> : null}
    </Container>
  </SpaceBetween></ModuleShell>;
}
