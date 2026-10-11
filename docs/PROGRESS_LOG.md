# Progress log

## 2026-10-11 — Config 모드 실제 확인, 동기화는 버튼으로만, 결과는 Payer 설정 단위로 보관
- worker 이미지가 런북 이전 빌드라 새 binding을 거부해 로그인 직후 연결이 끊겼다. 이미지를 다시 빌드해 `imageId`를 갱신했다(LESSONS·운영 문서에 기록).
- Config 집계자 모드 동기화 실제 확인: 53초, 서비스 16종 저장(직접 조회 1분 45초와 같은 결과).
- 사용자 결정: 동기화는 로그인마다 하지 않고 버튼으로만. 화면의 자동 첫 동기화를 없애고, 결과 캐시 위치를 연결 단위에서 사용자+Payer 설정 단위로 바꿔 재로그인·재등록·설정 변경 뒤에도 마지막 결과와 리포트가 남게 했다. 로컬 자동 동기화(`schedule`)는 끄고 기능은 서버 옵션으로 둔다. 기존 직접·Config 결과를 새 위치로 옮겨 리포트 기록 2개를 합쳤다. 219/219, 회사 smoke·조직 웹 합성 검증 통과.

## 2026-10-11 — 런북 실행·예약 동기화·Config 모드 준비
- 사용자 결정: 남은 세 가지(Config 모드 실제 확인, 런북 실행, 예약 동기화)를 모두 수행. AGENTS.md 규칙을 런북 승인 흐름과 사용자 세션 기반 예약 동기화로 바꿨다.
- 런북: 고정 카탈로그(연결 점검, EC2 시작·재시작·중지)와 연결별 `runbooks`(런북 전용 permission set·허용 목록). 요청(사유, EC2는 요청자 동기화 결과의 인스턴스만) → reviewer 승인(본인 승인은 서버 정책으로만) → 요청자 본인 세션의 런북 프로필로 실행 → 호스트가 상태를 끝까지 읽음. worker가 바쁘거나 세션이 없으면 시작하지 않고, 시작 응답 유실은 재시도하지 않고 unknown. worker는 실행 전 조회·런북 세션이 같은 사람인지 STS로 확인한다. '런북 실행' 화면 추가.
- 예약 동기화: `schedule.syncEveryMinutes`. 이 프로세스에서 연결이 확인된 사용자 세션에 대해서만 호스트가 주기적으로 동기화를 시작한다(worker 생성·로그인 없음). 동기화 영역에 다음 자동 동기화 시각 표시.
- 테스트 계정: 꺼져 있던 기존 Config 기록기를 동기화에 쓰는 9가지 자원 종류만 기록하도록 바꿔 켜고(원래 설정은 `.data/aws-rollback`에 보관) 계정 집계자를 만들었다. 직접 조회와 같은 자원 45개가 집계됐다. `scripts/ops/runbook-test-setup.sh`로 점검 문서·런북 permission set·할당을 만들었다.
- 218/218, 회사 smoke·조직 웹 합성 검증(런북 요청·승인·실행 흐름 포함) 통과.

## 2026-10-11 — 메일 기능 제거와 남은 코드 정리
- 사용자 결정: 메일 알림은 두지 않는다. SMTP 클라이언트·알림 규칙·`/alerts` 경로·알림 패널·배포 설정 항목·테스트를 지우고, 로컬 설정의 `notifications`, 비밀번호 파일, 캐시의 알림 상태를 삭제했다. 호스트 측 결과 수집은 유지한다.
- 화면에서 쓰지 않는 코드 제거: 개인용 화면 경로(`company`/edition 분기, 모듈 선택 링크), 미설정 상태의 합성 계정 예시, 화면이 보내지 않는 단일 조회(`inspect`) 결과 처리와 예전 단일 조회 캐시 보정(`withDirectReads`), 읽지 않던 `readErrors` 상태. 단일 조회 API는 worker 격리 검증 도구가 쓰므로 호스트/worker에 남겼다.
- Firebase 로그인 설정 형식을 웹 설정 스키마에서 제거하고 중복된 방식 검사를 지웠다. 현재 구조와 맞지 않는 분리 매니페스트 2개를 지우고 출처 요약을 `docs/provenance/assets.md`에 남겼다(이력은 Git에 있음).
- 모듈 밖에서 쓰지 않던 export를 내부 선언으로 바꾸고 쓰지 않는 타입 별칭을 지웠다. import되지 않는 소스 파일은 없다. 212/212, 회사 smoke·조직 웹 합성 검증 통과.

## 2026-10-11 — 실제 계정 확인: 호스트 측 수집·거버넌스·리포트, 메일 로그인 실패
- 새 빌드로 호스트를 재시작(이전 worker는 정상 종료로 retired)한 뒤 개인 테스트 계정에서 동기화: 계정 1개 접근 확인, 리전 17곳 확인 중 태그된 VPC 리전 1곳, 서비스 16종 수집. 탭을 떠나도 호스트가 끝까지 가져왔다.
- 거버넌스: Security Hub·GuardDuty `read_not_enabled`, AWS Health `read_not_subscribed`(지원 플랜). 보안 서비스 미사용이 주의 2건으로 판정됐다. 첫 판정 기록 저장(추이는 다음 동기화부터).
- 이메일: SMTP TLS 접속은 됐으나 Gmail이 로그인을 거부(`smtp_auth_failed`). 저장된 비밀번호 파일이 앱 비밀번호 길이(16자)와 달라 다시 저장이 필요하다. '알림 시작' 메일은 다음 동기화에서 다시 보낸다. 534(앱 비밀번호 필요)와 535(자격 거부)를 구분하는 코드를 추가했다(다음 재시작 때 반영).

## 2026-10-11 — 새로고침·재로그인 뒤 동기화가 멈춰 보이던 문제
- 실제 계정에서 확인: 페이지를 다시 열거나 웹 로그인을 다시 하면 화면이 디스크의 마지막 요약('동기화 중', live 아님)을 불러오고 진행률을 다시 묻지 않아, 다른 버튼을 눌러야만 이어지는 것처럼 보였다(동기화 버튼은 worker가 바쁘다고 거절).
- AWS 연결이 확인되면 캐시의 '진행 중' 요약에 대해 호스트에 한 번 진행률을 묻는다(기존 worker만 읽고 worker 생성·로그인·동기화는 하지 않음). worker가 없으면 '이전 동기화가 끝나지 않음'으로 표시하고 다시 동기화를 안내한다. 220/220, 회사 smoke·조직 웹 합성 검증 통과.

## 2026-10-11 — 레포 구조 정리 (apps/packages)
- 사용자 요청: 구조를 명시적으로 이해되게 정리. 결정: apps/packages 구조, 정리 전 로컬 commit.
- `apps/web`(화면), `apps/host`(API·로그인·저장소·연결·worker 관리·알림), `apps/worker`(Docker 수집기), `packages/contracts`·`packages/assessment`·`packages/worker-protocol`(공유). 테스트는 `tests/unit/{web,assessment,host,worker}`·`tests/contract`·`tests/browser`·`tests/opt-in`, 빌드 스크립트는 `scripts/build`. `git mv`로 이력을 보존하고 상대 import를 기계적으로 다시 계산했다.
- 함께 쓰던 파일을 층별로 나눴다: worker 명령 형식·lease 식별자·제한된 서브프로세스는 `packages/worker-protocol`, worker의 pipe 서버는 `apps/worker/src/serve.ts`, 브라우저 다운로드는 `apps/web/src/dashboard/download.ts`.
- 빌드마다 포함 가능한 폴더(`artifactSources`)를 검사해 화면이 호스트 코드를, worker가 호스트 코드를 넣으면 빌드가 실패한다(일부러 어겨 실패를 확인). tsconfig는 폴더 단위 include. worker Dockerfile은 worker와 공유 패키지만 복사하며 새 레시피로 이미지 빌드를 확인했다(확인용 태그는 삭제, 실행 중 설정의 이미지는 그대로).
- 문서: `docs/architecture/overview.md`(레포 지도) 신설, `Identity.md`→`docs/architecture/identity.md`, 분리 출처→`docs/provenance`, 지난 검증 기록→`docs/history`, 끝난 계획→`docs/plans/archive`. README·AGENTS·deploy 문서 경로 갱신, 모든 상대 링크 확인.
- 멀티 클라우드 시절의 쓰지 않는 계약(계획/실행/검토 타입, gcp·azure 대상, 모듈 manifest)을 제거했다. 동작은 바꾸지 않았다. 219/219, 회사 smoke·조직 웹 합성 검증 통과.

## 2026-10-11 — 이메일 알림과 호스트 측 결과 수집
- 사용자 결정: Slack 없이 이메일만, 수신자는 로컬 서버 설정에만 둔다(AGENTS.md에 기록). 호스트의 SMTP 클라이언트(의존성 추가 없음)가 항상 TLS로 보내고, 비밀번호는 0600 파일에서 보낼 때 읽는다.
- 동기화가 끝나 판정이 기록되면 첫 번째는 '알림 시작'(현재 조치·주의), 이후는 알리지 않은 항목만 보낸다. 볼 수 없었던 위치에서 사라진 항목은 해제하지 않고, 실패·대기 항목은 다음 동기화에 다시 보낸다. 운영 리포트 화면에 가린 수신자·최근 결과·고정 문구 테스트 메일(1분 1회)을 둔다. `check-deployment`가 비밀번호 파일 유무·권한을 보여 준다.
- 동기화 결과를 브라우저 polling으로만 가져와서 화면을 떠나면 수집·리포트·알림이 멈췄다. 동기화를 시작하면 호스트가 3초 간격으로 직접 가져온다(매 단계 권한 재확인, worker 생성·로그인 없음, 6시간·종료 시 중단).
- 대시보드의 항목 이름표를 `finding-labels.ts`로, 해결 판정 규칙을 `resolvedVisibility`로 분리해 리포트와 메일이 같은 규칙을 쓴다. tsconfig에서 빠져 타입 검사되지 않던 서버 테스트 6개를 넣고 드러난 오류를 고쳤다. worker Docker 허용 목록에 빠진 소스 4개를 넣었다(이미지 재빌드는 하지 않음). 219/219, 회사 smoke·조직 웹 합성 검증 통과.

## 2026-10-11 — worker 없는 요청의 안내 정리
- 증상: 호스트 재시작 전에 열어 둔 탭(이전 빌드)에서 '전용 AWS 연결 환경을 사용할 수 없습니다'와 '같은 요청 결과 확인' 버튼이 표시됐다. 재시작하면 worker가 정리되므로 worker가 필요한 요청은 거절된다(설계대로). 진단 결과 연결·구성원·설정 digest와 lease 할당은 정상이었고, 새로고침하면 새 빌드와 웹 로그인 화면이 나온다.
- 새 화면에서도 '세션 확인'·'AWS 로그아웃'이나 재시작 뒤의 '동기화'로 같은 상태가 될 수 있었다. 호스트가 그 요청을 이미 '미확인'으로 기록해 같은 키 재확인은 결과를 줄 수 없으므로, 로그인 외 작업의 `worker_unavailable`은 'AWS 세션 없음' 안내와 'AWS Device Code 로그인' 버튼으로 바꾸고 저장된 결과는 유지한다. 로그인 시 worker를 시작하지 못하면 그 사실을 알리고 재확인 버튼은 두지 않는다.
- 웹 로그인 직후 AWS 세션이 없으면 화면이 비어 보이기만 하고 안내가 없었다. Payer가 정해져 있고 미연결이면 화면 안에 'AWS 로그인이 필요합니다' 안내와 로그인 버튼을 둔다(저장된 결과만 표시 중인지, 로그인 뒤 자동 첫 동기화인지 구분).
- 다계정 인벤토리 이전 형식의 단일 조회 캐시(연결 자체 계정·리전)는 카드에 나타나지 않았다. 같은 위치의 동기화 단위가 없을 때만 그 조회를 단위로 보여 준다. 211/211, 회사 smoke·조직 웹 합성 검증 통과.

## 2026-10-11 — 엔터프라이즈 운영 4단계(운영 리포트·저장된 보기)
- 동기화가 끝나고 그 작업의 단위를 모두 가져오면 호스트가 그 단위만으로 대시보드와 같은 규칙으로 판정해 디스크 캐시(`report.json`)에 한 번 기록한다. 최근 48시간은 모두, 그 이전은 하루 1개씩 35일 보관한다.
- '운영 리포트' 화면: 7일/30일 비교, 조치·주의 추이 차트, 신규·해결 표(CSV), EOS 일정, Markdown/HTML 내보내기(값 이스케이프, HTML은 스크립트·외부 리소스 없음). 최근 동기화에서 읽지 못한 곳(접근 미확인 계정, 조회 실패)에서 사라진 항목은 '확인 불가'로 두고 해결로 세지 않는다.
- '저장된 보기': 페이지·탭·계정/리전 범위·그 페이지의 검색 조건을 서버 저장소의 사용자 설정으로 저장한다(연결 설정별, 최대 30개, 같은 이름 덮어쓰기, 요청 키 재시도). 표의 검색 조건을 대시보드가 관리하도록 바꿨다.
- 기존 결함 보완: 작업이 끝난 뒤 호출당 40개 상한을 넘어 남은 단위가 있으면 polling이 멈춰 캐시되지 않을 수 있었다. 요약에 `remaining`을 두고 진전이 있는 동안 계속 가져온다(진전 없는 10회 후 중지). 209/209, 조직 웹 합성 검증 통과. 알림(외부 전송)은 승인 전이라 넣지 않았다.

## 2026-10-11 — 엔터프라이즈 운영 3단계(거버넌스: 보안 태세·태그 준수·AWS Health)
- 계획 3단계를 읽기 전용으로 구현했다. 사용 리전마다 Security Hub의 활성·미해결 CRITICAL/HIGH 결과와 GuardDuty의 심각도 7.0 이상 결과를 읽는다. 대상 계정·리전으로 필터해 관리자 계정이나 집계 리전의 중복을 막는다. AWS Health는 계정마다 한 번(us-east-1) 읽는다.
- '사용 안 함'(Security Hub `InvalidAccessException`, GuardDuty detector 없음)과 '지원 플랜 필요'(Health `SubscriptionRequiredException`)는 조회 실패가 아니라 상태 코드(`read_not_enabled`, `read_not_subscribed`)로 둔다. 동기화를 '일부 실패'로 만들지 않고, 보안 서비스 미사용은 '주의' 항목으로 표시한다.
- 태그: EC2·RDS·MSK·API Gateway·EKS는 기존 응답에서 태그 키를 읽고, Lambda·DynamoDB·ElastiCache는 Resource Groups Tagging API로 읽는다. 완전한 페이지에 없는 자원은 '태그 없음'이고, 페이지가 불완전하거나 조회가 실패하면 '미수집'이다. 필수 태그 키는 서버 설정 `inventory.requiredTags`에 둔다.
- 화면: 좌측 '거버넌스'(보안 태세 탭·적용 범위, 태그 준수 CSV, AWS Health), 개요 카드 2개와 위젯 3개, 조치·주의 항목 '모두 보기'. 개요 상태 카드는 전체 폭 배너로 바꿔 카드 12개가 행을 채운다. 204/204, 조직 웹 합성 검증 통과. 실제 계정 검증 전.

## 2026-10-11 — 엔터프라이즈 운영 1·2단계(다계정 동기화·검색 조건·SSM·EOS)
- 사용자 결정: 직접 조회와 Config 집계자 둘 다 지원하고 디스크 캐시와 동기화 버튼을 둔다. 범위는 Organizations 범위와 지정/활성 리전이다. 사용 리전은 VPC 태그 유무로 판단한다. Serverless는 메뉴 하나에 탭으로 나누고 API Gateway를 추가한다. 계정·리전 구분과 필터를 둔다.
- 구현:
  - worker 백그라운드 동기화. 계정별 불변 config와 STS(같은 사용자) 확인, 단위별 실패 격리를 한다.
  - 호스트는 단위를 가져와 검증한 뒤 디스크에 저장하고, 완전한 동기화가 끝나면 남은 키를 정리한다.
  - 화면: 범위 필터, PropertyFilter, CSV, Serverless·SSM 탭, 계정별 사용 리전, EOS 센터.
  - EOS 근거: EKS·RDS·MSK는 API, Lambda·ElastiCache·OS는 문서(캡처일 표시).
- 결함 수정: worker 요청 응답 1,000개 상한에서 오류를 내던 것을 오래된 응답을 버리도록 바꿨다. 첫 동기화와 같은 렌더에서 디렉터리 자동 조회가 busy로 버려지던 문제를 고쳤다. 200/200.

## 2026-10-11 — 조직 인프라 중심 메뉴(EC2·EKS·RDS·ElastiCache·MSK·표준 지표)
- 사용자 요청: 실제 조직은 EC2/EKS/ElastiCache/RDS/MSK와 CloudWatch 표준 지표를 본다, Serverless는 메뉴 하나로. 고정 읽기 명령을 추가하고(EKS 버전 지원은 AWS에서 읽음, 표준 지표는 SEARCH 9개를 GetMetricData 한 번으로), 좌측 메뉴·위젯·상세 화면·판정 규칙을 재구성했다.
- 기존 결함 수정: 서비스 하나의 IAM 거부/시간 초과가 AWS 세션 전체를 'failed/denied'로 끊었다. 앞뒤 STS가 같으면 `read_*`로 그 조회만 실패시킨다. 지표 라벨이 해석되지 않으면 '데이터 없음'이 아니라 응답 확인 실패로 닫는다. 189/189, 개인 계정 실검증.

## 2026-10-11 — 운영 대시보드·조직 프로필·좌측 메뉴·조회 캐시
- 연결 패널을 상단 바 조직 프로필 팝업으로 옮겼다. 본문은 운영 현황(요약 카드, 조치·주의 항목, 경보/Lambda/EC2/계정 차트 위젯)이다. 좌측 메뉴는 영역별 상세 화면으로 간다. EC2 조회를 추가했다(`--no-paginate`+`--max-items` 충돌을 `--cli-input-json MaxResults`로 수정). 사용자별 로컬 디스크 조회 캐시를 추가했다.
- 결함 수정: 앱 탭이 가려지면 polling이 멈춰 팝업이 코드 URL로 가지 않던 문제, 재시작 후 `worker_unavailable`이 오류로 보이던 문제, 연결된 상태에서 자동 새로고침이 캐시 로드를 막던 순서 문제(회귀 테스트). 개인 계정 실검증, 180/180.

## 2026-10-11 — Payer 대시보드·원클릭 Device Code
- Payer SelectBox, 원클릭 로그인(빈 창 → 코드 URL), `verificationUriComplete` 전달·검증, 조직 계정 자동 로드·탭. 설정 변경 시 stale 연결 회수 결함 수정. 개인 계정 실검증, 175/175.

## 2026-10-10 — daemon 지연·DynamoDB local host
- `verify-worker-daemon-delay.mjs` 실제 Docker 7/7(늦은 create fail-closed, 조사한 ID만 전체 검증 후 회수). `adoptInvestigatedContainer` + `reconcile-worker --investigated-container`.
- local host `CLOUDOPS_DYNAMODB_STORE`, DynamoDB Local에서 host smoke 통과.

## 2026-10-10 — worker 장애 주입
- `scripts/verify-worker-recovery.mjs`(npm `verify:worker-recovery`): SIGKILL→재배정 없음→만료 후에도 없음→reconcile 후 2세대, 실제 Docker 8/8.

## 2026-10-10 — 실제 Identity Center end-to-end
- 실제 SAML 웹 로그인, Device Code 승인, STS, Lambda 조회, AWS 로그아웃 통과. CLI 2.30 `<start>/#/device` 거부 결함을 parser·서버·브라우저에서 수정하고 회귀 테스트 추가. `reconcile-worker`, SIGHUP 처리 추가. 173/173.

## 2026-10-10 — 개인 테스트 계정 Identity Center 실구성
- 단일 리전 organization instance 활성화, 테스트 사용자·CloudOpsReadOnly 할당, SAML 앱(http loopback ACS 수락) 생성·할당, local host(SAML+Docker) 기동. 사용자 비밀번호·MFA 대기.

## 2026-10-10 — Identity Center SAML 웹 로그인·실제 DynamoDB
- 웹 로그인을 Identity Center SAML로 통일(사용자 결정): `organization-saml-bridge.ts`, 배포 `samlBridge`, composition 연결, 단위 4 + Chromium e2e.
- 실제 AWS DynamoDB 임시 테이블 9/9 후 삭제. 테스트 171/171.
- Identity Center 활성화는 콘솔 클릭이 필요하나 자동 클릭이 권한 분류기에 거부되어 사용자 조치 대기. 대비로 local host 선택형 TLS와 `scripts/identity-center-test-setup.sh`(미실행) 추가.

## 2026-10-10 — 로컬 Docker 검증·DynamoDB adapter (사용자 승인)
- worker 이미지 빌드, `scripts/verify-worker-isolation.mjs` 실제 Docker 30/30(internal 네트워크).
- `server/cloud-dynamodb-store.ts`(SigV4 직접 서명, TransactWriteItems 낙관적 동시성, 같은 token 재전송) + 테스트 13, DynamoDB Local 9/9(`scripts/verify-dynamodb-local.mjs`).
- 개인 계정 Identity Center 가능·무료 확인(읽기 전용), `deploy/identity-center-test-setup.md`. 테스트 167/167.

## 2026-10-10 — 브라우저 OIDC·점검·저장소 적합성·격리 절차
- 브라우저 `OidcWebIdentityClient`(popup PKCE, 메모리 전용 token) + `public/oidc-callback.*`, web config `company.oidc`, company-main factory. 합성 IdP Chromium e2e를 check-company에 추가.
- `local.mjs check-deployment`(브라우저/서버 OIDC 짝, 마스킹 요약), opt-in Docker provisioner 연결(`CLOUDOPS_DOCKER_WORKER_CONFIG`).
- `server/cloud-store-conformance.ts` + SQLite 실행. worker 격리 실검증 절차 문서(미실행). 테스트 154/154.

## 2026-10-10 — 로컬 구성·인증 기반
- 배포 JSON 검증(`organizationDeploymentSchema`)과 명시적 `composeOrganizationApi` 추가. company 방식만 허용, scope 일치·중복 거부, verifier 없으면 503.
- 표준 OIDC 서버 verifier 후보 `server/oidc-web-identity.ts`(node:crypto, RS256/PS256/ES256, JWKS 고정/원격 1분 간격).
- loopback host `server/organization-local-host.ts` + `dist-company-api/local.mjs`(`serve`/`actor`/`provision-membership`), `npm run start:local`.
- 테스트 +10(132/132), check-company에 빌드 산출물 local host smoke 추가. 문서: deploy/organization-api.md, organization-web.md, README, STATUS, NEXT_PLAN, verification.

## 2026-10-10 — 독립 repo 분리
- 원본 CloudOps-Automation에서 회사용 조직 AWS 모듈 분리, make check 122/122. 상세는 docs/verification.md.
