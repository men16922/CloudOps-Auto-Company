import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import Alert from '@cloudscape-design/components/alert';
import Button from '@cloudscape-design/components/button';
import Container from '@cloudscape-design/components/container';
import KeyValuePairs from '@cloudscape-design/components/key-value-pairs';
import Select from '@cloudscape-design/components/select';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Box from '@cloudscape-design/components/box';
import Popover from '@cloudscape-design/components/popover';
import { useLanguage } from '../i18n';
import type { WebIdentityClient } from '../identity/web-identity';
import type { WebScope } from '../../../../packages/contracts/web-config';
import { OrganizationConnectionClient } from '../api/connection-client';
import OperationsDashboard from './OperationsDashboard';
import { withDirectReads } from '../../../../packages/assessment/operations-assessment';
import type { DashboardView } from './AccountDashboard';

export default function ConnectedAccounts({ client, scope, view = 'overview', viewHref = () => '#/organization/aws', pageTitle = value => value }: { client: WebIdentityClient; scope: WebScope; view?: DashboardView; viewHref?: (view: DashboardView) => string; pageTitle?: (view: DashboardView) => string }) {
  const [controller, setController] = useState<OrganizationConnectionClient>();
  useEffect(() => { const value = new OrganizationConnectionClient(client, scope); setController(value); return () => value.close(); }, [client, scope]);
  return controller ? <ConnectionView controller={controller} scope={scope} view={view} viewHref={viewHref} pageTitle={pageTitle} /> : null;
}
function ConnectionView({ controller, scope, view, viewHref, pageTitle }: { controller: OrganizationConnectionClient; scope: WebScope; view: DashboardView; viewHref: (view: DashboardView) => string; pageTitle: (view: DashboardView) => string }) {
  const { t } = useLanguage();
  const value = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const [configuration, setConfiguration] = useState('');
  const popup = useRef<Window | null>(null);
  const [connectedId, setConnectedId] = useState<string>();
  const refreshedFor = useRef<string | undefined>(undefined);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => { setSlot(document.getElementById('console-context-slot')); }, []);
  const selected = value.list.items.find(item => item.id === value.selectedId);
  useEffect(() => { setConfiguration(''); }, [value.identity?.key]);
  useEffect(() => {
    if (!value.status || !['starting', 'awaiting-user', 'verifying'].includes(value.status.status)) return;
    // While the opened device window waits for its code link, keep polling even if this tab is in the background.
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible' || popup.current) void controller.refreshStatus(); }, 2500);
    const onVisible = () => { if (document.visibilityState === 'visible') void controller.refreshStatus(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [controller, value.selectedId, value.status?.status]);
  const readProblem = Boolean(value.error?.startsWith('read_'));
  const errors: Record<string, [string, string]> = {
    web_sign_in_required: ['웹 로그인이 만료됐습니다. 다시 로그인하세요.', 'Web sign-in has expired. Sign in again.'],
    organization_access_denied: ['조직 접근 권한을 확인할 수 없어 계정 정보를 지웠습니다.', 'Organization access could not be verified. Account data has been cleared.'],
    worker_unavailable: ['전용 AWS 연결 환경을 시작하지 못했습니다. 잠시 후 다시 로그인하고, 계속되면 운영자에게 worker 상태 확인을 요청하세요.', 'The isolated AWS connection worker could not be started. Sign in again shortly; if it persists, ask an operator to check the worker.'],
    aws_session_required: ['AWS 세션이 없습니다. 호스트가 다시 시작됐거나 세션이 끝났을 수 있습니다. AWS Device Code 로그인으로 다시 연결하세요. 저장된 결과는 그대로 표시됩니다.', 'There is no AWS session. The host may have restarted or the session ended. Connect again with AWS Device Code sign-in; saved results stay visible.'],
    connection_busy: ['동기화 또는 다른 요청이 진행 중입니다. 끝난 뒤 다시 시도하세요.', 'A sync or another request is in progress. Try again when it finishes.'],
    directory_not_configured: ['이 Payer에는 Organizations 조회 범위가 없습니다.', 'No Organizations scope is configured for this payer.'],
    read_access_denied: ['이 조회에 필요한 IAM 권한이 연결된 역할에 없습니다. AWS 세션은 유지됩니다.', 'The connected role lacks the IAM permission for this read. The AWS session is kept.'],
    read_throttled: ['AWS 요청 제한으로 조회하지 못했습니다. 잠시 후 다시 조회하세요.', 'AWS throttled this read. Try again shortly.'],
    read_timeout: ['조회 시간이 초과됐습니다. AWS 세션은 유지됩니다.', 'The read timed out. The AWS session is kept.'],
    read_invalid_result: ['AWS 응답을 확인하지 못해 결과를 표시하지 않았습니다.', 'The AWS response could not be verified and was not shown.'],
    read_failed: ['조회를 완료하지 못했습니다. AWS 세션은 유지됩니다.', 'The read could not be completed. The AWS session is kept.'],
    connection_unavailable: ['이 Payer 연결을 사용할 수 없습니다. Payer 목록을 새로고침한 뒤 다시 시도하세요.', 'This payer connection is unavailable. Refresh payers and try again.'],
    directory_cursor_invalid: ['이 탐색 정보를 사용할 수 없습니다. 지정 Root/OU부터 새로 조회하세요.', 'This navigation reference is no longer available. Read the configured root/OU again.'],
    directory_cursor_expired: ['탐색 시간이 만료됐습니다. 지정 Root/OU부터 새로 조회하세요.', 'Navigation has expired. Read the configured root/OU again.'],
    directory_scope_unverified: ['OU의 현재 위치를 확인하지 못해 결과를 지웠습니다. 지정 범위부터 다시 조회하세요.', 'The current OU path could not be verified. Results were cleared; start from the configured scope again.'],
    worker_request_uncertain: ['요청 결과가 미확인입니다. 연결 상태를 새로 확인하세요.', 'The request result is unknown. Refresh the connection state.'],
    logout_unknown: ['AWS 로그아웃 결과가 미확인입니다. 연결은 해제됐습니다.', 'AWS logout is unconfirmed. The connection is disconnected.'],
    sign_in_failed: ['웹 로그인을 완료하지 못했습니다.', 'Web sign-in could not be completed.'],
    sign_out_failed: ['웹 로그아웃 결과를 확인하지 못했습니다. 화면의 계정 정보는 지웠습니다.', 'Web logout could not be confirmed. Account data has been cleared from this screen.'],
  };
  const states: Record<string, [string, string]> = { disconnected: ['미연결', 'Disconnected'], starting: ['로그인 시작 중', 'Starting sign-in'], 'awaiting-user': ['AWS 사용자 확인 대기', 'Waiting for AWS sign-in'], verifying: ['계정·역할 확인 중', 'Verifying account and role'], connected: ['접근 확인', 'Access verified'], denied: ['접근 거절', 'Access denied'], expired: ['만료', 'Expired'], failed: ['연결 실패', 'Connection failed'], cancelled: ['연결 취소', 'Cancelled'] };
  const payers = value.list.configurations.map(item => ({ value: item.id, label: `${item.label} · ${item.accountId}`, description: `${item.roleName} · ${item.region}${item.directory ? ` · ${t('Organizations 조회 범위 있음', 'Organizations scope')}` : ''}` }));
  const payer = selected?.configurationId ?? (configuration || (payers.length === 1 ? payers[0]!.value : ''));
  const payerConfig = value.list.configurations.find(item => item.id === payer);
  const status = value.status?.status;
  // A request briefly clears the status; keep the dashboard mounted for the connection last seen connected.
  useEffect(() => {
    if (status === 'connected' && selected) setConnectedId(selected.id);
    else if (status !== undefined || !selected) setConnectedId(undefined);
  }, [status, selected?.id]);
  const connected = status === 'connected' || (status === undefined && Boolean(selected) && connectedId === selected?.id);
  const deviceLink = value.status?.verificationUriComplete ?? value.status?.verificationUri;
  const units = useMemo(() => withDirectReads(value.units, value.inventories), [value.units, value.inventories]);
  const hasObservations = Boolean(value.directory || Object.keys(value.inventories).length || Object.keys(value.units).length || value.sync);
  // One click opens a blank window synchronously (no popup blocker) and later points it at the code-carrying AWS page.
  const startLogin = () => {
    if (!payer || value.busy) return;
    const opened = window.open('about:blank', 'cloudops-aws-device');
    if (opened) { opened.opener = null; popup.current = opened; }
    void controller.loginPayer(payer);
  };
  useEffect(() => {
    if (deviceLink && popup.current && !popup.current.closed) { popup.current.location.href = deviceLink; popup.current = null; }
  }, [deviceLink]);
  useEffect(() => {
    if (popup.current && (value.error || connected || status === 'failed' || status === 'denied')) { popup.current.close(); popup.current = null; }
  }, [value.error, connected, status]);
  // A payer that already has this user's connection is shown with its state and cached observations (no worker is started).
  useEffect(() => {
    if (!selected && payer && !value.busy && value.list.items.some(item => item.configurationId === payer)) void controller.choosePayer(payer);
  }, [selected, payer, value.busy, value.list.items, controller]);
  // The first connection without any cached sync starts one sync; afterwards syncing is the user's explicit action.
  useEffect(() => {
    if (status !== 'connected' || !selected || value.busy || value.error || value.sync || refreshedFor.current === selected.id) return;
    refreshedFor.current = selected.id; void controller.perform({ operation: 'sync' });
  }, [status, selected?.id, value.busy, value.error, value.sync, controller]);
  // The Root/OU directory page is read once per connection after a sync has finished (the worker serves one request at a time).
  const directoryFor = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (status !== 'connected' || !selected?.directory || value.directory || value.busy || value.error || !value.sync || value.sync.state === 'running' && value.sync.live || directoryFor.current === selected.id) return;
    directoryFor.current = selected.id; void controller.perform({ operation: 'directory' });
  }, [status, selected?.id, selected?.directory, value.directory, value.busy, value.error, value.sync?.state, value.sync?.live, controller]);
  // Progress polling only while this page's sync runs (polling never starts a sync, worker or login).
  const running = value.sync?.state === 'running' && value.sync.live || value.syncDraining;
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void controller.pollSync(); }, 3000);
    return () => window.clearInterval(timer);
  }, [running, controller]);
  const accessLabel = connected ? t(...states.connected) : status ? t(...states[status]) : t('접근 상태 미확인', 'Access state unknown');
  const accessType = connected ? 'success' as const : value.busy ? 'loading' as const : status === 'failed' || status === 'denied' ? 'error' as const : 'info' as const;
  const profile = value.identity ? <Popover triggerType="custom" position="bottom" size="large" fixedWidth dismissButton header={t('조직 프로필', 'Organization profile')} renderWithPortal content={<SpaceBetween size="m">
      <KeyValuePairs columns={2} items={[{ label: t('웹 사용자', 'Web user'), value: value.identity.label }, { label: t('조직', 'Organization'), value: scope.label }]} />
      <Select ariaLabel={t('Payer 선택', 'Choose payer')} options={payers} selectedOption={payers.find(option => option.value === payer) ?? null} disabled={value.busy}
        placeholder={payers.length ? t('Payer를 선택하세요', 'Choose a payer') : t('허용된 Payer가 없습니다', 'No permitted payer')} empty={t('허용된 Payer가 없습니다', 'No permitted payer')}
        onChange={({ detail }) => { const id = detail.selectedOption.value!; setConfiguration(id); refreshedFor.current = undefined; if (value.list.items.some(item => item.configurationId === id)) void controller.choosePayer(id); }} />
      {payerConfig ? <KeyValuePairs columns={2} items={[{ label: 'Payer', value: <span className="aws-account-id">{payerConfig.accountId}</span> }, { label: t('역할', 'Role'), value: payerConfig.roleName },
        { label: t('리전', 'Region'), value: payerConfig.region }, { label: t('AWS 접근', 'AWS access'), value: <StatusIndicator type={accessType}>{accessLabel}</StatusIndicator> }]} /> : null}
      <SpaceBetween direction="horizontal" size="xs">
        {!connected ? <Button variant="primary" disabled={!payer || value.busy} onClick={startLogin}>{t('AWS Device Code 로그인', 'AWS Device Code sign-in')}</Button> : null}
        {selected ? <Button disabled={value.busy} onClick={() => void controller.perform({ operation: 'verify' })}>{t('세션 확인', 'Verify session')}</Button> : null}
        {selected ? <Button disabled={value.busy} onClick={() => void controller.perform({ operation: 'logout' })}>{t('AWS 로그아웃', 'AWS logout')}</Button> : null}
        {selected ? <Button disabled={value.busy} onClick={() => void controller.perform({ operation: 'disconnect' })}>{t('앱 연결 해제', 'Disconnect app')}</Button> : null}
        <Button loading={value.loading} disabled={value.busy} onClick={() => void controller.refresh()}>{t('Payer 목록 새로고침', 'Refresh payers')}</Button>
        <Button onClick={() => void controller.signOut()}>{t('웹 로그아웃', 'Sign out of web')}</Button>
      </SpaceBetween>
      <Box color="text-body-secondary" fontSize="body-s">{t('Payer 선택과 로그인 성공은 하위 계정 권한을 부여하지 않습니다. 앱 연결 해제는 캐시를 보존하고, AWS 로그아웃은 이 사용자 전용 환경의 SSO 세션을 지웁니다.', 'Choosing a payer or signing in grants no member-account access. Disconnect keeps the cache; AWS logout clears this user’s isolated SSO session.')}</Box>
    </SpaceBetween>}><button type="button" className="console-context-button" aria-label={t('조직 프로필 열기', 'Open organization profile')} title={payerConfig ? `${payerConfig.label} · ${payerConfig.accountId}` : value.identity.label}>
      <span className={`console-context-dot ${connected ? 'is-connected' : ''}`} aria-hidden="true" />
      <span className="console-context-text"><strong>{payerConfig?.label ?? t('Payer 미선택', 'No payer')}</strong><small>{payerConfig ? `${payerConfig.accountId} · ${connected ? t('접근 확인', 'Access verified') : t('AWS 로그인 필요', 'AWS sign-in needed')}` : value.identity.label}</small></span>
    </button></Popover> : null;
  return <SpaceBetween size="l">
    {slot && profile ? createPortal(profile, slot) : null}
    {value.error ? <Alert type={readProblem ? 'warning' : 'error'} header={readProblem ? t('일부 조회 실패', 'Some reads failed') : t('연결 상태 확인', 'Connection status')} action={value.retryable ? <Button onClick={() => void controller.retry()}>{t('같은 요청 결과 확인', 'Check the same request')}</Button> : value.error === 'web_sign_in_required' ? <Button onClick={() => void controller.signIn()}>{t('웹 다시 로그인', 'Sign in again')}</Button> : value.error === 'aws_session_required' && payer ? <Button onClick={startLogin}>{t('AWS Device Code 로그인', 'AWS Device Code sign-in')}</Button> : undefined}>{t(...(errors[value.error] ?? ['요청 결과를 확인할 수 없습니다. 연결 상태를 새로 확인하세요.', 'The request result could not be verified. Refresh the connection state.']))}</Alert> : null}
    {!value.identity ? <Container><SpaceBetween size="s"><Box variant="h3">{t('조직 웹 로그인이 필요합니다', 'Organization sign-in required')}</Box>
      <p>{t('조직 웹 로그인 후 본인에게 허용된 Payer를 불러옵니다. AWS 로그인은 Payer별로 별도 진행합니다.', 'Sign in to the organization web app to load permitted payers. AWS sign-in is separate for each payer.')}</p>
      <Box><Button variant="primary" onClick={() => void controller.signIn()}>{t('조직 웹 로그인', 'Sign in to organization')}</Button></Box></SpaceBetween></Container> : null}
    {value.identity && !slot ? <Box float="right">{profile}</Box> : null}
    {value.identity && !connected && !(value.status?.userCode && deviceLink) && value.error !== 'aws_session_required' ? payer
      ? <Alert type="info" header={t('AWS 로그인이 필요합니다', 'AWS sign-in required')} action={<Button variant="primary" loading={value.busy} onClick={startLogin}>{t('AWS Device Code 로그인', 'AWS Device Code sign-in')}</Button>}>
        {hasObservations ? t('지금은 마지막으로 저장된 결과만 표시합니다. ', 'Only the last saved results are shown. ') : t('아직 수집한 결과가 없습니다. ', 'Nothing has been collected yet. ')}
        {value.sync ? t("로그인한 뒤 '동기화'로 새로 수집하세요.", 'After signing in, use Sync to collect again.') : t('로그인하면 첫 동기화가 자동으로 시작되고 결과는 호스트 디스크에 저장됩니다.', 'The first sync starts automatically after sign-in and results are saved on the host disk.')}</Alert>
      : <Container><SpaceBetween size="xs">
      <Box variant="h3">{t('연결된 Payer가 없습니다', 'No payer connected')}</Box>
      <Box color="text-body-secondary">{t('우측 상단 Payer 메뉴에서 Payer를 고르고 AWS Device Code로 로그인하세요. 연결되면 경보·자원·조직 상태를 읽어 옵니다.', 'Open the payer menu at the top right, choose a payer and sign in with AWS Device Code. Alarms, resources and organization state are read once connected.')}</Box>
    </SpaceBetween></Container> : null}
    {value.status?.userCode && deviceLink ? <Alert type="info" header={t('AWS 화면에서 코드를 확인하고 허용하세요', 'Confirm the code on AWS and allow access')}><SpaceBetween size="s">
      <span className="sso-user-code">{value.status.userCode}</span>
      <Button variant="primary" href={deviceLink} target="_blank" rel="noopener noreferrer">{value.status.verificationUriComplete ? t('AWS 인증 페이지 열기 (코드 자동 입력)', 'Open AWS verification (code filled in)') : t('AWS 인증 페이지 열기', 'Open AWS verification')}</Button>
      <p>{t('열린 AWS 페이지의 코드가 위 코드와 같은지 확인한 뒤 허용을 누르세요. 비밀번호와 MFA는 AWS 또는 회사 로그인 화면에서 직접 입력합니다.', 'Check that the code on the AWS page matches the code above, then allow access. Enter your password and MFA only on the AWS or company sign-in page.')}</p></SpaceBetween></Alert> : null}
    {selected && (connected || hasObservations) ? <OperationsDashboard view={view} viewHref={viewHref} pageTitle={pageTitle} connected={connected} busy={value.busy}
      report={value.report} views={value.views} onSaveView={view => controller.saveView(view)} onDeleteView={id => controller.deleteView(id)}
      alerts={value.alerts} onTestAlert={() => controller.testAlert()} onRefreshAlerts={() => void controller.loadAlerts()}
      portal={selected.startUrl ? { startUrl: selected.startUrl, roleName: selected.roleName } : undefined} requiredTags={selected.requiredTags} sync={value.sync} units={units}
      directory={value.directory} hasDirectoryScope={Boolean(selected.directory)} onSync={() => void controller.perform({ operation: 'sync' })}
      onReadDirectory={() => void controller.perform({ operation: 'directory' })} onNavigate={cursor => void controller.perform({ operation: 'directory', cursor })} /> : null}
  </SpaceBetween>;
}
