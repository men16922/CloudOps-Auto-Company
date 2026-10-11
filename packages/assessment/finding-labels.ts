import type { Finding, MetricId } from './operations-assessment';

/** `t(korean, english)` of the viewer (dashboard) or of the configured recipient language (host e-mail). */
export type Translate = (ko: string, en: string) => string;
type Labelled = Pick<Finding, 'kind'> & Partial<Pick<Finding, 'metric' | 'eos'>>;

/** Display names shared by the dashboard, the report exports and e-mail alerts. */
export const metricLabel = (id: MetricId, t: Translate) => ({ ec2_cpu: t('EC2 CPU 사용률', 'EC2 CPU utilization'), ec2_status: t('EC2 상태 검사 실패', 'EC2 status check failed'), rds_cpu: t('RDS CPU 사용률', 'RDS CPU utilization'),
    rds_storage: t('RDS 여유 저장공간', 'RDS free storage'), cache_cpu: t('ElastiCache CPU 사용률', 'ElastiCache CPU utilization'), cache_memory: t('ElastiCache 메모리 사용률', 'ElastiCache memory usage'),
    msk_cpu: t('MSK 브로커 CPU(User)', 'MSK broker CPU (user)'), msk_disk: t('MSK 데이터 디스크 사용률', 'MSK data disk usage'), lambda_errors: t('Lambda 오류 수', 'Lambda errors') })[id];
export const findingKindLabel = (finding: Labelled, t: Translate) => finding.kind === 'metric' && finding.metric ? metricLabel(finding.metric, t) : ({ alarm: t('경보 발생', 'Alarm firing'), 'alarm-data': t('경보 데이터 부족', 'Alarm missing data'),
    eos: finding.eos ? `EOS · ${finding.eos.component}` : 'EOS', account: t('계정 상태 확인', 'Account state'), instance: t('중지된 인스턴스', 'Stopped instance'), coverage: t('수집 범위 제한', 'Limited coverage'),
    'resource-state': t('자원 상태', 'Resource state'), metric: t('표준 지표', 'Standard metric'), 'ssm-unmanaged': t('SSM 미관리 인스턴스', 'Instance not managed by SSM'),
    'ssm-lost': t('SSM 연결 끊김', 'SSM connection lost'), patch: t('패치 비준수', 'Patch non-compliant'), automation: t('Automation 실행 실패', 'Automation execution failed'), 'read-failed': t('조회 실패', 'Read failed'),
    'security-hub': t('Security Hub 결과', 'Security Hub findings'), guardduty: t('GuardDuty 위협 탐지', 'GuardDuty threat findings'), 'security-off': t('보안 서비스 미사용', 'Security service not enabled'), tags: t('필수 태그 누락', 'Missing required tags'), health: 'AWS Health' } as Record<Finding['kind'], string>)[finding.kind];
