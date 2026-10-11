import { useState } from 'react';
import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Container from '@cloudscape-design/components/container';
import Header from '@cloudscape-design/components/header';
import KeyValuePairs from '@cloudscape-design/components/key-value-pairs';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import { useLanguage } from '../i18n';
import type { AlertEvent, AlertStatus } from '../../../../packages/contracts/aws/alerts';

type Props = { status?: AlertStatus; onTest: () => Promise<string | undefined>; onRefresh: () => void };

/** E-mail alert status for this payer. Recipients and rules are server settings; the only action is the fixed test message. */
export default function AlertPanel({ status, onTest, onRefresh }: Props) {
  const { t, locale } = useLanguage();
  const [pending, setPending] = useState(false), [result, setResult] = useState<{ ok: boolean; code?: string }>();
  const codes: Record<string, string> = {
    smtp_credentials_missing: t('메일 서버 비밀번호 파일이 없거나 권한이 넓습니다(0600 필요).', 'The mail password file is missing or too permissive (0600 required).'),
    smtp_connect_failed: t('메일 서버에 연결하지 못했습니다.', 'Could not connect to the mail server.'), smtp_tls_failed: t('메일 서버와 TLS 연결을 맺지 못했습니다.', 'TLS with the mail server failed.'),
    smtp_auth_failed: t('메일 서버가 사용자 이름이나 비밀번호를 거부했습니다. Gmail이면 앱 비밀번호(공백 없이 16자)를 다시 저장하세요.', 'The mail server rejected the user name or password. For Gmail, save the app password again (16 characters, no spaces).'),
    smtp_app_password_required: t('메일 서버가 앱 비밀번호를 요구합니다. Gmail은 2단계 인증을 켠 뒤 만든 앱 비밀번호를 저장해야 합니다.', 'The mail server requires an app password. For Gmail, turn on 2-step verification and save an app password.'),
    smtp_rejected: t('메일 서버가 메시지를 거절했습니다.', 'The mail server rejected the message.'), smtp_timeout: t('메일 서버 응답 시간이 초과됐습니다.', 'The mail server timed out.'),
    alert_rate_limited: t('테스트 메일은 1분에 한 번 보낼 수 있습니다.', 'A test message can be sent once a minute.'),
    alerts_not_configured: t('이 Payer에는 이메일 알림이 설정되지 않았습니다.', 'E-mail alerts are not configured for this payer.'),
  };
  const reason = (code?: string) => code ? codes[code] ?? t('보내지 못했습니다.', 'Could not send.') : '';
  const kind = (event: AlertEvent) => event.kind === 'test' ? t('테스트', 'Test') : event.kind === 'baseline' ? t('알림 시작(현재 항목)', 'Start (current items)') : t(`신규 항목 ${event.count}개`, `${event.count} new items`);
  const outcome = (event: AlertEvent) => event.outcome === 'sent' ? <StatusIndicator type="success">{t('보냄', 'Sent')}</StatusIndicator>
    : event.outcome === 'deferred' ? <StatusIndicator type="pending">{t('발송 간격 대기', 'Waiting for the send interval')}</StatusIndicator>
    : <StatusIndicator type="error">{reason(event.code)}</StatusIndicator>;
  const test = async () => { setPending(true); setResult(undefined); const code = await onTest(); setPending(false); setResult(code ? { ok: false, code } : { ok: true }); };
  const last = status?.history[0];
  return <Container header={<Header variant="h2" description={t('동기화가 끝날 때 새로 나타난 조치·주의 항목을 서버 설정의 수신자에게 메일로 보냅니다.', 'When a sync ends, new action/attention items are mailed to the recipients in the server settings.')}
    actions={<SpaceBetween direction="horizontal" size="xs"><Button iconName="refresh" variant="icon" ariaLabel={t('알림 상태 새로 고침', 'Refresh alert status')} onClick={onRefresh} />
      {status?.configured ? <Button loading={pending} onClick={() => void test()}>{t('테스트 메일 보내기', 'Send test message')}</Button> : null}</SpaceBetween>}>{t('이메일 알림', 'E-mail alerts')}</Header>}>
    {!status ? <StatusIndicator type="loading">{t('확인 중', 'Checking')}</StatusIndicator> : !status.configured
      ? <Box color="text-body-secondary">{t('이 Payer에는 이메일 알림이 설정되지 않았습니다. 운영자가 서버 설정(notifications.email)에 수신자를 지정하면 사용할 수 있습니다.', 'E-mail alerts are not configured for this payer. An operator can add recipients in the server settings (notifications.email).')}</Box>
      : <SpaceBetween size="m">
        <KeyValuePairs columns={3} items={[
          { label: t('수신자', 'Recipients'), value: status.recipients.join(', ') },
          { label: t('보내는 항목', 'Sends'), value: `${status.minSeverity === 'critical' ? t('새 조치 항목', 'New action items') : t('새 조치·주의 항목', 'New action and attention items')} · ${status.detail === 'summary' ? t('종류별 개수만', 'counts per kind only') : t('자원·계정·리전 포함', 'with resource, account and region')}` },
          { label: t('최근 발송', 'Last delivery'), value: last ? <SpaceBetween size="xxxs"><span>{new Date(last.at).toLocaleString(locale)} · {kind(last)}</span>{outcome(last)}</SpaceBetween> : t('아직 없음 — 첫 동기화가 끝나면 현재 항목으로 알림을 시작합니다.', 'None yet — the first finished sync starts alerts with the current items.') },
        ]} />
        {result && (result.ok || result.code !== last?.code) ? <Alert type={result.ok ? 'success' : 'error'} dismissible onDismiss={() => setResult(undefined)}>{result.ok ? t('테스트 메일을 보냈습니다. 받은편지함(또는 스팸함)을 확인하세요.', 'The test message was sent. Check the inbox (or spam folder).') : reason(result.code)}</Alert> : null}
        {status.history.length > 1 ? <Box color="text-body-secondary" fontSize="body-s">{status.history.slice(1, 6).map(event => <div key={`${event.at}-${event.kind}`}>{`${new Date(event.at).toLocaleString(locale)} · ${kind(event)} · ${event.outcome === 'sent' ? t('보냄', 'sent') : event.outcome === 'deferred' ? t('대기', 'deferred') : reason(event.code)}`}</div>)}</Box> : null}
      </SpaceBetween>}
  </Container>;
}
