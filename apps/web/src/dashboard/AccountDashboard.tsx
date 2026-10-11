import { awsModule } from '../shell/aws-module';
import { useEffect, useState } from 'react';
import Alert from '@cloudscape-design/components/alert';
import Header from '@cloudscape-design/components/header';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import { useLanguage } from '../i18n';
import ModuleShell from '../shell/ModuleShell';
import { useOrganizationAccess } from '../identity/OrganizationAccess';
import ConnectedAccounts from './ConnectedAccounts';

export type DashboardView = 'overview' | 'report' | 'ec2' | 'eks' | 'rds' | 'elasticache' | 'msk' | 'serverless' | 'ssm' | 'lifecycle' | 'alarms' | 'metrics' | 'security' | 'tags' | 'health' | 'accounts';
const base = '#/organization/aws';
const views: DashboardView[] = ['report', 'ec2', 'eks', 'rds', 'elasticache', 'msk', 'serverless', 'ssm', 'lifecycle', 'alarms', 'metrics', 'security', 'tags', 'health', 'accounts'];
function currentView(): DashboardView { const part = window.location.hash.slice(base.length + 1); return (views as string[]).includes(part) ? part as DashboardView : 'overview'; }
/** Section routes inside the organization AWS module (hash only; no server route or new permission). */
function useDashboardView() {
  const [view, setView] = useState<DashboardView>(currentView);
  useEffect(() => { const update = () => setView(previous => { const next = currentView(); if (next !== previous) window.scrollTo({ top: 0 }); return next; }); window.addEventListener('hashchange', update); return () => window.removeEventListener('hashchange', update); }, []);
  return view;
}

export default function AccountDashboard() {
  const { t } = useLanguage();
  const webAccess = useOrganizationAccess();
  const view = useDashboardView();
  const titles: Record<DashboardView, string> = { overview: t('대시보드', 'Dashboard'), report: t('운영 리포트', 'Operations report'), ec2: 'EC2', eks: 'EKS', rds: 'RDS', elasticache: 'ElastiCache', msk: 'MSK', serverless: 'Serverless', ssm: 'Systems Manager', lifecycle: t('수명주기(EOS)', 'Lifecycle (EOS)'),
    alarms: t('CloudWatch 경보', 'CloudWatch alarms'), metrics: t('CloudWatch 표준 지표', 'CloudWatch standard metrics'), security: t('보안 태세', 'Security posture'), tags: t('태그 준수', 'Tag compliance'), health: 'AWS Health',
    accounts: t('조직 계정', 'Organization accounts') };
  const link = (value: DashboardView) => ({ type: 'link' as const, text: titles[value], href: href(value) });
  const href = (value: DashboardView) => value === 'overview' ? base : `${base}/${value}`;
  const sections = { activeHref: href(view), current: view === 'overview' ? undefined : { text: titles[view], href: href(view) }, items: [
    link('overview'),
    link('report'),
    { type: 'section' as const, text: t('컴퓨팅', 'Compute'), items: [link('ec2'), link('eks')] },
    { type: 'section' as const, text: t('데이터·스트리밍', 'Data and streaming'), items: [link('rds'), link('elasticache'), link('msk')] },
    link('serverless'),
    { type: 'section' as const, text: t('모니터링', 'Monitoring'), items: [link('alarms'), link('metrics')] },
    { type: 'section' as const, text: t('운영 관리', 'Operations'), items: [link('ssm'), link('lifecycle')] },
    { type: 'section' as const, text: t('거버넌스', 'Governance'), items: [link('security'), link('tags'), link('health')] },
    { type: 'section' as const, text: t('조직', 'Organization'), items: [link('accounts')] },
  ] };
  const ready = webAccess.state === 'ready';
  return <ModuleShell icon={awsModule.icon} name="AWS" href={base} sections={ready ? sections : undefined}><SpaceBetween size="l">
    <Header variant="h1" description={ready && view === 'report' ? t('동기화가 끝날 때마다 기록한 판정 결과로 추이와 신규·해결 항목을 비교합니다. 읽기 전용입니다.', 'Compares trends and new/resolved items from the assessment recorded at the end of each sync. Read-only.') : ready && view !== 'overview' ? t('수집한 결과의 전체 목록입니다. 읽기 전용이며 AWS 콘솔로 바로 이동할 수 있습니다.', 'Full list of collected results. Read-only, with links to the AWS console.') : t('조직과 OU에서 계정별 접근·점검·후속 확인 상태를 살펴봅니다.', 'Review account access, inspections and follow-up by organization and OU.')}>
      {ready && view !== 'overview' ? titles[view] : t('조직 AWS 계정 상태', 'Organization AWS account status')}
    </Header>
    {webAccess.state === 'ready' ? <ConnectedAccounts client={webAccess.client} scope={webAccess.scope} view={view} viewHref={href} pageTitle={value => titles[value]} />
      : webAccess.state === 'loading' ? <StatusIndicator type="loading">{t('조직 로그인 설정 확인 중', 'Checking organization sign-in configuration')}</StatusIndicator>
      : webAccess.state === 'failed' ? <Alert type="error">{t('조직 로그인 설정을 확인할 수 없습니다.', 'Organization sign-in configuration could not be verified.')}</Alert>
      : <Alert type="info" header={t('조직 로그인이 설정되지 않았습니다', 'Organization sign-in is not configured')}>{t('운영자가 회사 웹 로그인(IAM Identity Center SAML 또는 OIDC)을 설정하면, 로그인 후 본인에게 허용된 Payer에 AWS Device Code로 연결합니다. 계정 정보는 표시하지 않습니다.', 'Once an operator configures company web sign-in (IAM Identity Center SAML or OIDC), you sign in and connect to your permitted payers with AWS Device Code. No account data is shown until then.')}</Alert>}
  </SpaceBetween></ModuleShell>;
}
