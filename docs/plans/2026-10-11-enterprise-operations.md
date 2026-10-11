# 엔터프라이즈 운영 기능 계획 (2026-10-11)

사용자 요청: 실제 대기업 조직이 쓰는 수준으로 검색 조건, EOS(지원 종료), SSM Automation 등 운영 기능을 기획하고 만든다. 조직 계정 화면에서는 계정별 사용 리전을 **VPC 태그 유무**로 판단한다. 리전이 활성화돼 있어도 태그된 VPC가 없으면 사용하지 않는 리전으로 본다.

## 원칙 (바뀌지 않음)

- **읽기 전용이 기본이다.** 서버에 고정된 계정·역할·리전과 고정된 CLI 명령만 실행한다. 쓰기 기능(런북 실행)은 5단계에서 별도로 승인받은 뒤 추가한다.
- **범위는 서버 설정이 정한다.**
  - 계정은 설정된 Organizations 범위(Root/OU) 아래 ACTIVE 계정이며 상한(`maxAccounts`, 기본 50)이 있다.
  - 리전은 계정마다 활성화된 리전이고, 설정한 리전 목록이 있으면 그것을 쓴다.
  - 실제 접근 권한은 계정마다 STS로 확인한다. 같은 Identity Center 사용자인지(role session name 일치)도 함께 확인한다.
  - 로그인 성공이나 Payer 선택은 권한이 아니다.
- **수집하지 않은 영역은 정상으로 간주하지 않는다.** 조회 실패, 권한 없음, 일부 결과는 각각 그대로 표시한다.
- **사용자별로 격리하고 캐시는 디스크에 둔다.**
  - 수집은 사용자 전용 worker(Device Code 세션) 안에서만 한다.
  - 결과는 호스트의 사용자·연결별 디스크 캐시(0700/0600)에 저장하고 브라우저 저장소에는 넣지 않는다.
  - 화면은 캐시를 읽고, 동기화 버튼으로 갱신한다.

## 1단계 — 다계정·다리전 동기화 (완료)

| 항목 | 내용 |
|---|---|
| 동기화 작업 | worker 백그라운드 작업. 진행률은 polling한다. 끝난 단위(계정·리전·서비스)는 호스트가 가져와 검증한 뒤 디스크에 저장한다. 완전한 동기화가 끝나면 더 이상 생성되지 않는 단위를 정리한다. |
| 직접 조회 모드 | 계정마다 활성 리전을 확인하고 리전별 `describe-vpcs`로 태그된 VPC를 센다. 사용 리전에서만 13개 서비스(경보, 표준 지표, EC2, EKS, RDS, ElastiCache, MSK, Lambda, DynamoDB, API Gateway, SSM 관리 노드, 패치 준수, Automation 기록)를 읽는다. Payer는 연결 기본 리전도 읽는다. |
| AWS Config 집계자 모드 | `inventory.config` 설정 시 사용한다. 인벤토리와 VPC 태그는 고정 SELECT로 조직 전체를 한 번에 읽고, 범위 밖 계정의 행은 버린다. ElastiCache는 Config가 지원하지 않아 직접 읽는다. 경보, 지표, SSM은 사용 리전에서 직접 읽는다. |
| 계정별 접근 | 같은 SSO 세션에 계정별 프로필을 둔다. 계정마다 별도의 불변 config 파일을 쓴다. 할당되지 않은 계정은 '권한 없음'으로 표시하고 읽지 않는다. |
| 화면 | 동기화 상태·진행률과 계정·리전 범위 필터를 모든 화면에 둔다. 모든 표에 계정·리전 열, 검색 조건(PropertyFilter: 계정·리전·이름·상태·유형·버전 등, 같음/포함/제외), 페이지 이동이 있다. Serverless(Lambda·DynamoDB·API Gateway) 탭, Systems Manager(관리 노드·패치 준수·Automation) 탭, 계정별 사용 리전 표를 추가했다. 콘솔 링크는 Identity Center shortcut으로 해당 계정에서 열린다. |
| 실패 처리 | 서비스 하나의 IAM 거부나 시간 초과는 그 단위만 실패로 남는다. 계정 접근 실패는 그 계정만 제외한다. 세션 수준 실패(신원 변경, 만료)일 때만 작업과 세션을 끝낸다. |

## 2단계 — 수명주기(EOS) 센터 (진행)

| 구성 요소 | 근거 | 판정 |
|---|---|---|
| EKS | `describe-cluster-versions --include-all` (API, 지원 상태·종료일) | 지원 종료=조치, 확장 지원(추가 요금)=주의 |
| RDS(MySQL·PostgreSQL·Aurora·MariaDB) | `describe-db-major-engine-versions` (API, 표준·확장 지원 기간) | 종료=조치, 확장 지원=주의 |
| MSK(Kafka) | `list-kafka-versions` (API, ACTIVE/DEPRECATED) + 문서의 지원 종료일 | 종료=조치, DEPRECATED=주의 |
| Lambda 런타임 | Lambda 런타임 문서(캡처일 2026-10-11): 지원 중단일·생성 차단일·업데이트 차단일 | 업데이트 차단 이후=조치, 지원 중단=주의 |
| ElastiCache(Redis OSS) | ElastiCache 문서: v4/v5 확장 지원 2026-02-01~2029-01-31, v6 표준 지원 2027-01-31까지 | 확장 지원=주의 |
| 운영체제(SSM 관리 노드) | 벤더 문서: Amazon Linux 2 2026-06-30, Windows Server 2016 2027-01-12 등 | 종료=조치 |

- 90일 안에 종료되는 항목은 '예정'이다. 30일 안이면 주의, 그 밖에는 참고다.
- 문서 기반 날짜는 캡처일과 출처를 함께 보여 주고, 변경 가능하다고 표시한다.
- 화면에는 요약 카드와 표(검색 조건·CSV 내보내기)를 둔다.

## 3단계 — 거버넌스 (구현, 실제 계정 검증 전)

| 구성 요소 | 읽는 방법 | 판정 |
|---|---|---|
| Security Hub | 사용 리전마다 `get-findings`. 대상 계정·리전, ACTIVE, 워크플로 NEW/NOTIFIED, CRITICAL·HIGH로 필터한다(최대 100개). | 계정·리전별 CRITICAL=조치, HIGH=주의. `InvalidAccessException`은 '사용 안 함'(주의) |
| GuardDuty | `list-detectors` → `list-findings`(심각도 7.0 이상, 보관 안 됨, 대상 계정) → `get-findings`(최대 50개) | 결과가 있으면 조치. detector가 없으면 '사용 안 함'(주의) |
| AWS Health | 계정마다 한 번 `describe-events`(us-east-1, open·upcoming, issue·scheduledChange·accountNotification) | 이슈·예정 변경=주의, 계정 알림=참고. 지원 플랜이 없으면 '확인 불가'(상태이며 실패가 아님) |
| 필수 태그 | EC2·RDS·MSK·API Gateway·EKS는 기존 응답의 태그 키, Lambda·DynamoDB·ElastiCache는 Resource Groups Tagging API. Config 모드는 Config `tags` | 서버 설정 `inventory.requiredTags`(최대 10개, `aws:` 제외, 대소문자 구분). 누락=참고(계정·리전·서비스별 묶음). 태그 미수집 자원은 준수도 누락도 아님 |

- 화면: '거버넌스' 메뉴(보안 태세: Security Hub·GuardDuty·적용 범위 탭 / 태그 준수: 요약·자원별 표·CSV / AWS Health: 이벤트 표와 지원 플랜 안내), 개요 카드와 위젯.
- 비용: 위 API는 조회 요금이 없다. Security Hub·GuardDuty 자체 사용료는 서비스를 켠 계정에서 발생한다(이 기능이 켜지는 않음).
- 조직 단위 Health(`describe-events-for-organization`)와 Security Hub 위임 관리자 일괄 조회는 조직 설정 변경이 필요해 남겼다.

## 4단계 — 리포트와 연동 (리포트·저장된 보기·이메일 알림 구현)

| 구성 요소 | 내용 |
|---|---|
| 판정 기록(스냅샷) | 동기화가 끝나고(완료·일부 실패) 그 작업의 단위를 모두 가져오면, 호스트가 **그 작업의 단위만으로** 대시보드와 같은 규칙(`assessOperations`)으로 판정해 한 번 기록한다. 콘솔 링크는 저장하지 않는다. 항목은 최대 1,500개(조치→주의→참고 순이라 잘리면 참고부터 빠짐). 저장 위치는 디스크 캐시의 `report.json`(0600)이며 최근 48시간은 모두(최대 24개), 그 이전은 하루 1개씩 35일, 6MB 안에서 보관한다. 바인딩이 바뀌면 캐시 범위가 바뀌어 기록도 새로 시작한다. |
| 운영 리포트 화면 | 기간 7일/30일. 비교 기준은 기간 시작 시점 이전의 마지막 기록이고, 기록이 짧으면 가장 오래된 기록과 비교한다고 표시한다. 요약(조치·주의와 이전 대비, 신규, 해결, 동기화 횟수), 조치·주의 추이 선 차트, 신규 항목·해결된 항목 표(CSV), 수명주기(EOS) 일정(종료·확장·중단·90일 내 종료, 날짜순). 계정·리전 범위를 적용한다(범위 적용 시 수치는 저장된 항목 기준). |
| 해결 판정 | 신규·해결은 조치·주의 항목만 비교한다. 사라진 항목은 최근 동기화가 그 계정에 접근 확인됐고 그 서비스·계정·리전에 조회 실패가 없을 때만 '해결'이다. 아니면 '확인 불가'로 두고 해결 수에 넣지 않는다. |
| 내보내기 | Markdown(위키·이슈용)과 HTML(인쇄·PDF용). 브라우저에서 만들어 내려받는다. 모든 값은 이스케이프하고 HTML은 스크립트·외부 리소스를 쓰지 않는다(CSP `default-src 'none'`). |
| 저장된 보기 | 페이지(와 탭), 계정·리전 범위, 그 페이지 표들의 검색 조건을 이름으로 저장한다. 서버 저장소의 사용자 설정(조직·워크스페이스·사용자·연결 설정별, 최대 30개, 보기당 6KB)이며 관측 결과는 저장하지 않는다. 같은 이름은 덮어쓴다. 요청 키로 재시도를 같은 결과로 돌려준다. 브라우저 저장소는 쓰지 않는다. |

| 이메일 알림 (2026-10-11 사용자 결정: Slack 없음, 이메일만) | 동기화가 끝나 판정이 기록되면 서버 설정의 수신자에게 새로 나타난 조치·주의 항목을 SMTP(TLS)로 보낸다. 첫 기록은 '알림 시작' 메일. 사라진 항목은 볼 수 있었던 경우에만 해제하고, 실패·대기 항목은 다음 동기화에 다시 보낸다. 화면은 가린 수신자·최근 결과·고정 문구 테스트 메일만. [설정](../../deploy/organization-api.md#이메일-알림-notificationsemail) |
| 호스트 측 결과 수집 | 동기화를 시작하면 호스트가 끝난 단위를 직접 가져온다(3초 간격, 매 단계 권한 재확인, worker 생성·로그인 없음). 브라우저가 떠나도 리포트 기록과 알림이 이어진다. |

- 남음: 실제 메일 발송 확인(SMTP 비밀번호 파일 준비와 호스트 재시작 후). 무인 주간 발송은 6단계 예약 동기화(서비스 역할 수집기)가 있어야 한다.

## 5단계 — 운영 실행(쓰기): SSM Automation 런북

현재 저장소 규칙(AGENTS.md: 서버 고정 조회 API만)을 바꾸는 일이라 **사용자·보안 승인 후에만** 진행한다. 설계안:

1. 허용 런북 목록을 서버에 고정한다(예: AWS-RestartEC2Instance, AWS-StopEC2Instance, 패치 실행). 파라미터 스키마도 고정하고, 대상은 동기화로 확인한 자원만 허용한다.
2. 요청(사유·변경 번호) → 승인자 검토(요청자와 다른 사람, 2인 승인 선택) → 실행 순서로 진행한다. Change Calendar와 유지 관리 기간을 확인한다.
3. 실행에는 runbook 실행 전용 permission set을 쓴다(조회용과 분리). 실행 결과는 Automation 실행 ID로 추적한다.
4. 감사 기록(누가·언제·무엇을·결과)은 불변 저장소 선택과 함께 설계한다. 현재 해시 연결은 불변 감사 저장소가 아니다.

## 6단계 — 플랫폼

- **예약 동기화:** Device Code 세션은 사용자가 없으면 쓸 수 없다. 무인 수집에는 별도 서비스 역할 기반 수집기와 그 권한 검토가 필요하다.
- **성능:** worker는 `--cpus=0.25`라 CLI 실행 1회에 약 2초가 걸린다.
  - 직접 모드는 계정 1개 기준 '활성 리전 수 × 2초 + 사용 리전 수 × 약 30초'가 걸린다.
  - 대규모 조직(수십~수백 계정)에는 Config 집계자 모드를 권장한다.
  - worker CPU 상향은 격리 계약 변경이라 별도로 검토한다.
- **운영 저장소:** DynamoDB adapter, 다중 인스턴스(공유 서명 키·sticky), TLS.

## 비용 (2026-10-11 확인, 서울/버지니아 기준 추정)

| 기능 | 비용 |
|---|---|
| Describe/List 조회(EC2·EKS·RDS·ElastiCache·MSK·Lambda·DynamoDB·API Gateway·SSM·Organizations) | 무료 |
| CloudWatch 표준 지표 `GetMetricData`(SEARCH) | 조회 지표 수 기준. 서드파티 자료상 1,000개당 $0.01이며, AWS 요금 페이지에서 직접 확인하지는 못했다. 소규모는 사실상 0 |
| AWS Config 기록 | 연속 기록 $0.003/항목, 일 단위 기록 $0.012/항목. 자원 약 100개 계정·리전 기준 첫 달 약 $0.3+변경분, 대략 **월 $1 수준/계정·리전**. 집계자와 고급 쿼리는 추가 요금 없음. 규칙(Rules)은 평가당 별도 과금 |
| AWS Health API | Business 이상 지원 플랜 필요 |
| Cost Explorer API(향후) | 요청당 $0.01 |

출처: AWS Config pricing, Config advanced query/aggregator 문서, RDS DescribeDBMajorEngineVersions, MSK supported versions, ElastiCache extended support, Lambda runtimes, EKS describe-cluster-versions, SSM/API Gateway CLI reference, AWS Health 문서, 각 OS 벤더 수명주기 페이지.
