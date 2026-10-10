import { useEffect, useState, useSyncExternalStore } from 'react';
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
import type { WebIdentityClient } from '../../../platform/web-identity';
import type { WebScope } from '../../../platform/web-config';
import { OrganizationConnectionClient } from './connection-client';
import DirectoryPanel from './DirectoryPanel';

export default function ConnectedAccounts({ client, scope }: { client: WebIdentityClient; scope: WebScope }) {
  const [controller, setController] = useState<OrganizationConnectionClient>();
  useEffect(() => { const value = new OrganizationConnectionClient(client, scope); setController(value); return () => value.close(); }, [client, scope]);
  return controller ? <ConnectionView controller={controller} scope={scope} /> : null;
}
function ConnectionView({ controller, scope }: { controller: OrganizationConnectionClient; scope: WebScope }) {
  const { t, locale } = useLanguage();
  const value = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const [configuration, setConfiguration] = useState('');
  const selected = value.list.items.find(item => item.id === value.selectedId);
  useEffect(() => { setConfiguration(''); }, [value.identity?.key]);
  useEffect(() => {
    if (!value.status || !['starting', 'awaiting-user', 'verifying'].includes(value.status.status)) return;
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void controller.refreshStatus(); }, 2500);
    return () => window.clearInterval(timer);
  }, [controller, value.selectedId, value.status?.status]);
  const errors: Record<string, [string, string]> = {
    web_sign_in_required: ['웹 로그인이 만료됐습니다. 다시 로그인하세요.', 'Web sign-in has expired. Sign in again.'],
    organization_access_denied: ['조직 접근 권한을 확인할 수 없어 계정 정보를 지웠습니다.', 'Organization access could not be verified. Account data has been cleared.'],
    worker_unavailable: ['전용 AWS 연결 환경을 사용할 수 없습니다.', 'The isolated AWS connection worker is unavailable.'],
    directory_cursor_invalid: ['이 탐색 정보를 사용할 수 없습니다. 지정 Root/OU부터 새로 조회하세요.', 'This navigation reference is no longer available. Read the configured root/OU again.'],
    directory_cursor_expired: ['탐색 시간이 만료됐습니다. 지정 Root/OU부터 새로 조회하세요.', 'Navigation has expired. Read the configured root/OU again.'],
    directory_scope_unverified: ['OU의 현재 위치를 확인하지 못해 결과를 지웠습니다. 지정 범위부터 다시 조회하세요.', 'The current OU path could not be verified. Results were cleared; start from the configured scope again.'],
    worker_request_uncertain: ['요청 결과가 미확인입니다. 연결 상태를 새로 확인하세요.', 'The request result is unknown. Refresh the connection state.'],
    logout_unknown: ['AWS 로그아웃 결과가 미확인입니다. 연결은 해제됐습니다.', 'AWS logout is unconfirmed. The connection is disconnected.'],
    sign_in_failed: ['웹 로그인을 완료하지 못했습니다.', 'Web sign-in could not be completed.'],
    sign_out_failed: ['웹 로그아웃 결과를 확인하지 못했습니다. 화면의 계정 정보는 지웠습니다.', 'Web logout could not be confirmed. Account data has been cleared from this screen.'],
  };
  const states: Record<string, [string, string]> = { disconnected: ['미연결', 'Disconnected'], starting: ['로그인 시작 중', 'Starting sign-in'], 'awaiting-user': ['AWS 사용자 확인 대기', 'Waiting for AWS sign-in'], verifying: ['계정·역할 확인 중', 'Verifying account and role'], connected: ['접근 확인', 'Access verified'], denied: ['접근 거절', 'Access denied'], expired: ['만료', 'Expired'], failed: ['연결 실패', 'Connection failed'], cancelled: ['연결 취소', 'Cancelled'] };
  const options = value.list.configurations.map(item => ({ value: item.id, label: `${item.label} · ${item.accountId} · ${item.roleName}` }));
  return <Container header={<Header variant="h2" description={scope.label} actions={value.identity ? <Button onClick={() => void controller.signOut()}>{t('웹 로그아웃', 'Sign out of web')}</Button> : undefined}>{t('내 조직 AWS 연결', 'My organization AWS connections')}</Header>}><SpaceBetween size="m">
    {!value.identity ? <><p>{t('조직 웹 로그인 후 본인에게 허용된 연결을 불러옵니다. AWS 로그인은 연결별로 별도 진행합니다.', 'Sign in to the organization web app to load permitted connections. AWS sign-in is separate for each connection.')}</p><Button variant="primary" onClick={() => void controller.signIn()}>{t('조직 웹 로그인', 'Sign in to organization')}</Button></>
      : <><SpaceBetween direction="horizontal" size="m"><strong>{value.identity.label}</strong><Button loading={value.loading} disabled={value.busy} onClick={() => void controller.refresh()}>{t('연결 목록 새로고침', 'Refresh connections')}</Button></SpaceBetween>
        <p>{t('웹 로그아웃은 AWS CLI 세션을 종료하지 않습니다. AWS 세션을 종료하려면 연결을 선택해 AWS 로그아웃을 사용하세요.', 'Signing out of the web app does not end the AWS CLI session. Select a connection and use AWS logout to end that session.')}</p>
        <div className="organization-connection-picker"><div><Select ariaLabel={t('허용된 AWS 연결', 'Permitted AWS connection')} options={options} selectedOption={options.find(option => option.value === configuration) ?? null} placeholder={t('계정·역할 선택', 'Select account and role')} disabled={value.busy} onChange={({ detail }) => setConfiguration(detail.selectedOption.value!)} /></div>
          <Button disabled={value.busy || !options.some(option => option.value === configuration)} onClick={() => void controller.create(configuration)}>{t('내 연결 추가', 'Add my connection')}</Button></div>
        <Table items={value.list.items} loading={value.loading} loadingText={t('허용된 연결을 확인합니다.', 'Checking permitted connections.')} trackBy="id" columnDefinitions={[
          { id: 'account', header: t('AWS 계정', 'AWS account'), width: 170, cell: item => <Button variant="inline-link" disabled={value.busy} onClick={() => void controller.select(item.id)}><span className="aws-account-id">{item.accountId}</span></Button> },
          { id: 'role', header: t('역할', 'Role'), cell: item => item.roleName }, { id: 'region', header: t('리전', 'Region'), cell: item => item.region },
        ]} empty={<p>{t('이 사용자에게 등록된 연결이 없습니다. 허용된 계정·역할을 선택하세요.', 'This user has no registered connections. Select a permitted account and role.')}</p>} />
      </>}
    {value.error ? <Alert type="error" header={t('연결 상태 확인', 'Connection status')} action={value.retryable ? <Button onClick={() => void controller.retry()}>{t('같은 요청 결과 확인', 'Check the same request')}</Button> : undefined}>{t(...(errors[value.error] ?? ['요청 결과를 확인할 수 없습니다. 연결 상태를 새로 확인하세요.', 'The request result could not be verified. Refresh the connection state.']))}</Alert> : null}
    {value.error === 'web_sign_in_required' ? <Button onClick={() => void controller.signIn()}>{t('웹 다시 로그인', 'Sign in again')}</Button> : null}
    {selected ? <Container header={<Header variant="h3">{selected.accountId} · {selected.roleName}</Header>}><SpaceBetween size="m">
      <StatusIndicator type={value.status?.status === 'connected' ? 'success' : value.busy ? 'loading' : 'info'}>{value.status ? t(...states[value.status.status]) : t('접근 상태 미확인', 'Access state unknown')}</StatusIndicator>
      <SpaceBetween direction="horizontal" size="xs">
        <Button disabled={value.busy} onClick={() => void controller.perform({ operation: 'login' })}>{t('AWS Device Code 로그인', 'AWS Device Code sign-in')}</Button>
        <Button disabled={value.busy} onClick={() => void controller.perform({ operation: 'verify' })}>{t('기존 AWS 세션 확인', 'Verify existing AWS session')}</Button>
        <Button disabled={value.busy} onClick={() => void controller.refreshStatus()}>{t('상태 새로고침', 'Refresh state')}</Button>
        <Button disabled={value.busy} onClick={() => void controller.perform({ operation: 'disconnect' })}>{t('앱 연결 해제', 'Disconnect app')}</Button>
        <Button disabled={value.busy} onClick={() => void controller.perform({ operation: 'logout' })}>{t('AWS 로그아웃', 'AWS logout')}</Button>
      </SpaceBetween>
      {value.status?.userCode && value.status.verificationUri ? <Alert type="info" header={t('AWS 화면에서 본인 코드를 확인하세요', 'Confirm your code on AWS')}><SpaceBetween size="s"><strong>{value.status.userCode}</strong><Button href={value.status.verificationUri} target="_blank" rel="noopener noreferrer">{t('AWS 인증 페이지 열기', 'Open AWS verification')}</Button><p>{t('비밀번호와 MFA는 AWS 또는 회사 로그인 화면에서 직접 입력합니다.', 'Enter your password and MFA directly on the AWS or company sign-in page.')}</p></SpaceBetween></Alert> : null}
      <p>{t('앱 연결 해제는 이 연결의 캐시를 보존합니다. AWS 로그아웃은 이 사용자 전용 환경에 적용되며 기존에 발급된 IAM 세션은 만료까지 유효할 수 있습니다.', 'Disconnect retains this connection’s cache. AWS logout applies to this isolated environment; previously issued IAM sessions may remain valid until expiry.')}</p>
      <SpaceBetween direction="horizontal" size="xs">{(['lambda', 'dynamodb', 'alarms'] as const).map(service => <Button key={service} disabled={value.busy || value.status?.status !== 'connected'} onClick={() => void controller.perform({ operation: 'inspect', service })}>{service === 'alarms' ? 'CloudWatch' : service === 'lambda' ? 'Lambda' : 'DynamoDB'} {t('목록 조회', 'inventory')}</Button>)}</SpaceBetween>
      {selected.directory ? <Button disabled={value.busy || value.status?.status !== 'connected'} onClick={() => void controller.perform({ operation: 'directory' })}>{t('지정 Root/OU 계정 상태 조회', 'Read configured root/OU account state')}</Button> : <p>{t('이 연결에는 Organizations 조회 범위가 지정되지 않았습니다.', 'No Organizations directory scope is configured for this connection.')}</p>}
      {value.directory ? <DirectoryPanel key={`${value.directory.parentId}:${value.directory.collectedAt}`} snapshot={value.directory} onNavigate={cursor => void controller.perform({ operation: 'directory', cursor })} /> : null}
      {value.inspection ? <><KeyValuePairs items={[{ label: t('수집 시각', 'Collected at'), value: new Date(value.inspection.collectedAt).toLocaleString(locale) }, { label: t('조회 범위', 'Read scope'), value: `${value.inspection.accountId} · ${value.inspection.region} · ${value.inspection.operation}` }]} />
        <Table items={value.inspection.items} columnDefinitions={[{ id: 'name', header: t('이름', 'Name'), cell: item => item.name }, { id: 'state', header: t('관측 상태', 'Observed state'), cell: item => item.state ?? item.runtime ?? t('해당 없음', 'Not applicable') }]} empty={<p>{t('현재 조회 페이지에 반환된 항목이 없습니다.', 'No items were returned on this page.')}</p>} />
        {value.inspection.hasMore ? <Alert type="info">{t('첫 페이지 결과입니다. 전체 자원 목록이 아닙니다.', 'This is the first page, not a complete resource inventory.')}</Alert> : null}</> : null}
    </SpaceBetween></Container> : null}
  </SpaceBetween></Container>;
}
