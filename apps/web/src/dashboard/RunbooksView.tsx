import { useEffect, useMemo, useState } from 'react';
import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Container from '@cloudscape-design/components/container';
import FormField from '@cloudscape-design/components/form-field';
import Header from '@cloudscape-design/components/header';
import Input from '@cloudscape-design/components/input';
import Modal from '@cloudscape-design/components/modal';
import Select from '@cloudscape-design/components/select';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator, { type StatusIndicatorProps } from '@cloudscape-design/components/status-indicator';
import Table from '@cloudscape-design/components/table';
import Textarea from '@cloudscape-design/components/textarea';
import { useLanguage } from '../i18n';
import { runbookCatalog, type RunbookCommand, type RunbookId, type RunbookRequestView, type RunbookState } from '../../../../packages/contracts/aws/runbooks';

type Instance = { id: string; name: string; state?: string; accountId: string; region: string };
type Props = { state?: RunbookState; instances: Instance[]; payer: { accountId: string; region: string }; accountLabel: (id: string) => string;
  onRefresh: () => void; onCommand: (command: RunbookCommand) => Promise<string | undefined> };

/** Approved, catalog-only runbook execution: request with a reason → approval by another member → the requester runs it on their own
 * runbook permission set → status followed by the host. Documents and parameters never come from this page. */
export default function RunbooksView({ state, instances, payer, accountLabel, onRefresh, onCommand }: Props) {
  const { t, locale } = useLanguage();
  const [open, setOpen] = useState(false), [runbook, setRunbook] = useState<RunbookId>(), [instance, setInstance] = useState<string>(), [reason, setReason] = useState(''), [changeRef, setChangeRef] = useState('');
  const [pending, setPending] = useState<string>(), [error, setError] = useState<string>();
  useEffect(() => { onRefresh(); }, [onRefresh]);
  useEffect(() => {
    if (!state?.requests.some(request => request.state === 'running' || request.state === 'starting')) return;
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') onRefresh(); }, 5000);
    return () => window.clearInterval(timer);
  }, [state, onRefresh]);
  const labels: Record<RunbookId, { name: string; description: string; risk: 'low' | 'medium' | 'high' }> = {
    'connectivity-check': { name: t('연결 점검', 'Connectivity check'), description: t('실행 권한과 승인 절차를 확인하는 점검 런북입니다. 자원을 바꾸지 않습니다.', 'Checks execution permissions and the approval flow. Changes no resources.'), risk: 'low' },
    'ec2-start': { name: t('EC2 인스턴스 시작', 'Start EC2 instance'), description: t('중지된 인스턴스를 시작합니다.', 'Starts a stopped instance.'), risk: 'low' },
    'ec2-restart': { name: t('EC2 인스턴스 재시작', 'Restart EC2 instance'), description: t('인스턴스를 재부팅합니다. 서비스가 잠시 중단됩니다.', 'Reboots the instance. Service is briefly interrupted.'), risk: 'medium' },
    'ec2-stop': { name: t('EC2 인스턴스 중지', 'Stop EC2 instance'), description: t('인스턴스를 중지합니다. 다시 시작할 때까지 서비스가 멈춥니다.', 'Stops the instance. Service stays down until it is started again.'), risk: 'high' },
  };
  const risk = { low: t('낮음', 'Low'), medium: t('중간', 'Medium'), high: t('높음', 'High') };
  const states: Record<RunbookRequestView['state'], [string, StatusIndicatorProps.Type]> = {
    pending: [t('승인 대기', 'Awaiting approval'), 'pending'], approved: [t('승인됨 · 실행 가능', 'Approved · ready to run'), 'info'], rejected: [t('거절됨', 'Rejected'), 'stopped'],
    cancelled: [t('취소됨', 'Cancelled'), 'stopped'], starting: [t('시작 중', 'Starting'), 'in-progress'], running: [t('실행 중', 'Running'), 'in-progress'],
    succeeded: [t('성공', 'Succeeded'), 'success'], failed: [t('실패', 'Failed'), 'error'], unknown: [t('실행 여부 미확인', 'Start unconfirmed'), 'warning'],
  };
  const codes: Record<string, string> = {
    aws_session_required: t('AWS 세션이 없습니다. AWS Device Code로 로그인한 뒤 다시 실행하세요.', 'No AWS session. Sign in with AWS Device Code and run again.'),
    connection_busy: t('동기화 같은 다른 작업이 진행 중입니다. 끝난 뒤 다시 실행하세요.', 'Another task such as a sync is running. Run again when it finishes.'),
    self_approval_not_allowed: t('본인 요청은 다른 구성원이 승인해야 합니다.', 'Another member must approve your own request.'),
    runbook_reviewer_required: t('승인에는 reviewer 역할이 필요합니다.', 'Approving needs the reviewer role.'), runbook_operator_required: t('요청·실행에는 operator 역할이 필요합니다.', 'Requesting and running need the operator role.'),
    runbook_requester_required: t('요청자 본인만 실행하거나 취소할 수 있습니다.', 'Only the requester can run or cancel.'), runbook_target_not_synced: t('동기화된 인벤토리에 없는 인스턴스입니다. 동기화 후 다시 요청하세요.', 'The instance is not in your synced inventory. Sync and request again.'),
    runbook_start_unknown: t('실행이 시작됐는지 확인하지 못했습니다. AWS 콘솔에서 실행 기록을 확인한 뒤 필요하면 새로 요청하세요.', 'Whether it started is unknown. Check executions in the AWS console before requesting again.'),
    runbook_identity_mismatch: t('런북 권한 세트가 이 사용자에게 할당되지 않았거나 다른 사용자입니다.', 'The runbook permission set is not assigned to this user, or the identity differs.'),
    cli_invalid_request: t('AWS가 런북 요청 형식을 거부했습니다. 문서·파라미터 설정을 확인하세요.', 'AWS rejected the runbook request format. Check the document and its parameters.'),
    cli_not_found: t('런북 문서나 대상을 이 계정·리전에서 찾지 못했습니다. 설정 스크립트로 문서를 만들었는지 확인하세요.', 'The runbook document or target was not found in this account and region. Check that the setup created the document.'),
    runbook_request_not_pending: t('이미 처리된 요청입니다.', 'The request was already handled.'), runbook_request_not_approved: t('승인된 요청만 실행할 수 있습니다.', 'Only approved requests can run.'),
  };
  const message = (code: string) => codes[code] ?? (code.startsWith('aws_') || code.startsWith('cli_') || code.startsWith('read_') ? t(`AWS가 요청을 거절했습니다 (${code}).`, `AWS rejected the request (${code}).`) : t(`요청을 처리하지 못했습니다 (${code}).`, `The request could not be completed (${code}).`));
  const act = async (key: string, command: RunbookCommand) => { setPending(key); setError(undefined); const code = await onCommand(command); setPending(undefined); if (code) setError(code); return !code; };
  const selected = runbook ? runbookCatalog[runbook] : undefined;
  const instanceOptions = useMemo(() => instances.map(item => ({ value: `${item.accountId}|${item.region}|${item.id}`, label: `${item.name} (${item.id})`, description: `${accountLabel(item.accountId)} · ${item.region}${item.state ? ` · ${item.state}` : ''}` })), [instances, accountLabel]);
  const target = () => {
    if (selected?.target !== 'ec2-instance') return { accountId: payer.accountId, region: payer.region };
    const [accountId, region, instanceId] = (instance ?? '').split('|');
    return { accountId: accountId!, region: region!, instanceId: instanceId! };
  };
  const ready = Boolean(runbook && reason.trim().length >= 5 && (selected?.target !== 'ec2-instance' || instance));
  const submit = async () => {
    if (!runbook) return;
    if (await act('request', { operation: 'request', runbook, target: target(), reason: reason.trim(), ...(changeRef.trim() ? { changeRef: changeRef.trim() } : {}) })) { setOpen(false); setRunbook(undefined); setInstance(undefined); setReason(''); setChangeRef(''); }
  };
  const who = (person: { self: boolean; label: string }) => person.self ? t('나', 'Me') : t(`구성원 ${person.label}`, `Member ${person.label}`);
  const time = (value?: string) => value ? new Date(value).toLocaleString(locale) : '—';
  if (!state) return <StatusIndicator type="loading">{t('런북 정보를 불러오는 중', 'Loading runbooks')}</StatusIndicator>;
  if (!state.enabled) return <Alert type="info" header={t('이 Payer에는 런북 실행이 설정되지 않았습니다', 'Runbooks are not configured for this payer')}>{t('운영자가 서버 설정의 연결 항목에 runbooks(런북 전용 권한 세트와 허용 런북)를 지정하면 사용할 수 있습니다.', 'An operator can enable them by adding runbooks (a runbook permission set and the allowed runbooks) to the connection in the server settings.')}</Alert>;
  return <SpaceBetween size="l">
    {error ? <Alert type="error" dismissible onDismiss={() => setError(undefined)}>{message(error)}</Alert> : null}
    <Table variant="container" items={state.allowed} trackBy={id => id} header={<Header variant="h2" description={state.canRequest ? t('요청 → 다른 구성원 승인 → 요청자 실행 순서입니다. 실행은 요청자 본인의 AWS 세션과 런북 전용 권한으로 진행됩니다.', 'Request → approval by another member → the requester runs it on their own AWS session and runbook permission set.') : t('요청하려면 operator 역할이 필요합니다.', 'Requesting needs the operator role.')}
      actions={<Button variant="primary" disabled={!state.canRequest} onClick={() => setOpen(true)}>{t('실행 요청', 'Request a run')}</Button>}>{t('허용된 런북', 'Allowed runbooks')}</Header>}
      columnDefinitions={[
        { id: 'name', header: t('런북', 'Runbook'), cell: id => <div><Box fontWeight="bold">{labels[id].name}</Box><Box color="text-body-secondary" fontSize="body-s">{labels[id].description}</Box></div> },
        { id: 'document', header: t('SSM 문서', 'SSM document'), cell: id => runbookCatalog[id].document },
        { id: 'target', header: t('대상', 'Target'), cell: id => runbookCatalog[id].target === 'ec2-instance' ? t('동기화된 EC2 인스턴스', 'A synced EC2 instance') : t('Payer 계정·리전', 'Payer account and region') },
        { id: 'risk', header: t('위험도', 'Risk'), cell: id => <StatusIndicator type={labels[id].risk === 'high' ? 'warning' : labels[id].risk === 'medium' ? 'info' : 'success'}>{risk[labels[id].risk]}</StatusIndicator> },
      ]} />
    <Table variant="container" items={state.requests} trackBy="id" wrapLines empty={<Box textAlign="center" color="text-body-secondary">{t('요청이 없습니다.', 'No requests.')}</Box>}
      header={<Header variant="h2" counter={`(${state.requests.length})`} description={t('이 Payer 설정을 쓰는 팀의 요청 기록입니다. 감사용 불변 저장소는 아닙니다.', 'Requests of the team using this payer configuration. Not an immutable audit store.')}
        actions={<Button iconName="refresh" ariaLabel={t('새로 고침', 'Refresh')} onClick={onRefresh} />}>{t('실행 요청', 'Run requests')}</Header>}
      columnDefinitions={[
        { id: 'created', header: t('요청', 'Requested'), cell: item => <div>{time(item.createdAt)}<Box color="text-body-secondary" fontSize="body-s">{who(item.requester)}</Box></div> },
        { id: 'runbook', header: t('런북 · 대상', 'Runbook · target'), cell: item => <div><Box fontWeight="bold">{labels[item.runbook].name}</Box><Box color="text-body-secondary" fontSize="body-s">{item.target.instanceId ? `${item.target.name ?? item.target.instanceId} (${item.target.instanceId}) · ` : ''}{accountLabel(item.target.accountId)} · {item.target.region}</Box></div> },
        { id: 'reason', header: t('사유', 'Reason'), cell: item => <div>{item.reason}{item.changeRef ? <Box color="text-body-secondary" fontSize="body-s">{t(`변경 번호 ${item.changeRef}`, `Change ${item.changeRef}`)}</Box> : null}</div> },
        { id: 'state', header: t('상태', 'State'), cell: item => <div><StatusIndicator type={states[item.state][1]}>{states[item.state][0]}</StatusIndicator>
          {item.decision ? <Box color="text-body-secondary" fontSize="body-s">{item.decision.approved ? t('승인', 'Approved') : t('거절', 'Rejected')} · {who(item.decision.by)} · {time(item.decision.at)}{item.decision.note ? ` · ${item.decision.note}` : ''}</Box> : null}
          {item.execution?.executionId ? <Box color="text-body-secondary" fontSize="body-s">{`${item.execution.status ?? ''} · ${item.execution.executionId.slice(0, 8)}`}{item.execution.failure ? ` · ${item.execution.failure}` : ''}</Box> : item.execution?.failure ? <Box color="text-status-error" fontSize="body-s">{message(item.execution.failure)}</Box> : null}</div> },
        { id: 'actions', header: t('작업', 'Actions'), cell: item => <SpaceBetween direction="horizontal" size="xs">
          {item.state === 'pending' && state.canApprove && (!item.requester.self || state.selfApproval) ? <>
            <Button variant="inline-link" loading={pending === `approve:${item.id}`} onClick={() => void act(`approve:${item.id}`, { operation: 'approve', requestId: item.id })}>{t('승인', 'Approve')}</Button>
            <Button variant="inline-link" loading={pending === `reject:${item.id}`} onClick={() => void act(`reject:${item.id}`, { operation: 'reject', requestId: item.id })}>{t('거절', 'Reject')}</Button></> : null}
          {item.state === 'approved' && item.requester.self ? <Button variant="inline-link" loading={pending === `execute:${item.id}`} onClick={() => void act(`execute:${item.id}`, { operation: 'execute', requestId: item.id })}>{t('실행', 'Run')}</Button> : null}
          {(item.state === 'pending' || item.state === 'approved') && item.requester.self ? <Button variant="inline-link" loading={pending === `cancel:${item.id}`} onClick={() => void act(`cancel:${item.id}`, { operation: 'cancel', requestId: item.id })}>{t('취소', 'Cancel')}</Button> : null}
          {item.state === 'running' ? <Button variant="inline-link" loading={pending === `refresh:${item.id}`} onClick={() => void act(`refresh:${item.id}`, { operation: 'refresh', requestId: item.id })}>{t('상태 확인', 'Check status')}</Button> : null}
        </SpaceBetween> },
      ]} />
    <Modal visible={open} onDismiss={() => setOpen(false)} header={t('런북 실행 요청', 'Request a runbook run')} footer={<Box float="right"><SpaceBetween direction="horizontal" size="xs">
      <Button variant="link" onClick={() => setOpen(false)}>{t('취소', 'Cancel')}</Button>
      <Button variant="primary" disabled={!ready} loading={pending === 'request'} onClick={() => void submit()}>{t('요청', 'Request')}</Button></SpaceBetween></Box>}>
      <SpaceBetween size="m">
        <FormField label={t('런북', 'Runbook')}><Select selectedOption={runbook ? { value: runbook, label: labels[runbook].name } : null} placeholder={t('런북 선택', 'Choose a runbook')}
          options={state.allowed.map(id => ({ value: id, label: labels[id].name, description: `${runbookCatalog[id].document} · ${t('위험도', 'Risk')} ${risk[labels[id].risk]}` }))} onChange={({ detail }) => { setRunbook(detail.selectedOption.value as RunbookId); setInstance(undefined); }} /></FormField>
        {selected?.target === 'ec2-instance' ? <FormField label={t('대상 인스턴스', 'Target instance')} description={t('내 동기화 결과에 있는 인스턴스만 고를 수 있습니다.', 'Only instances in your synced inventory can be chosen.')}>
          <Select selectedOption={instanceOptions.find(option => option.value === instance) ?? null} placeholder={instanceOptions.length ? t('인스턴스 선택', 'Choose an instance') : t('동기화된 EC2 인스턴스가 없습니다', 'No synced EC2 instances')}
            options={instanceOptions} filteringType="auto" onChange={({ detail }) => setInstance(detail.selectedOption.value)} disabled={!instanceOptions.length} /></FormField>
          : selected ? <Box color="text-body-secondary">{t(`대상: Payer 계정 ${accountLabel(payer.accountId)} · ${payer.region}`, `Target: payer account ${accountLabel(payer.accountId)} · ${payer.region}`)}</Box> : null}
        <FormField label={t('사유', 'Reason')} constraintText={t('5자 이상. 승인자와 기록에 남습니다.', 'At least 5 characters. Shown to approvers and kept in the record.')}>
          <Textarea value={reason} onChange={({ detail }) => setReason(detail.value)} ariaLabel={t('사유', 'Reason')} rows={3} /></FormField>
        <FormField label={t('변경 번호 (선택)', 'Change reference (optional)')}><Input value={changeRef} onChange={({ detail }) => setChangeRef(detail.value)} ariaLabel={t('변경 번호', 'Change reference')} /></FormField>
      </SpaceBetween>
    </Modal>
    {state.canApprove && state.selfApproval ? <Container><Box color="text-body-secondary" fontSize="body-s">{t('서버 정책상 본인 요청도 승인할 수 있습니다(단일 운영자 검증용). 운영 환경에서는 다른 구성원의 승인을 권장합니다.', 'The server policy allows approving your own requests (single-operator verification). Production should require another member.')}</Box></Container> : null}
  </SpaceBetween>;
}
