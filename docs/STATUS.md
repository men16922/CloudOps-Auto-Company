# 현재 상태

갱신: 2026-10-11. 조직 AWS 계정 운영용 독립 로컬 저장소다(main, 로컬 commit만, remote·push 없음). 원본 CloudOps-Automation과 ai-builder-cup은 별도로 보존한다.

구조: `apps/web`(화면)·`apps/host`(API·연결·worker 관리·리포트 기록)·`apps/worker`(Docker 수집기)와 공유 `packages/`(contracts·assessment·worker-protocol). 빌드별 허용 폴더를 검사한다. [레포 구조](architecture/overview.md)

## 구현

- **대시보드:** 상단 바 조직 프로필(Payer·Device Code·세션)과 다계정·다리전 **동기화**. 사용자 전용 worker가 Organizations 범위의 계정을 STS로 확인하고 태그된 VPC가 있는 리전만 읽는다(직접 조회 또는 AWS Config 집계자 모드). 동기화를 시작하면 호스트가 결과를 끝까지 디스크 캐시로 가져오므로 화면을 떠나도 된다. 모든 표에 계정·리전 열·범위 필터·검색 조건·CSV가 있다.
- **메뉴:** 대시보드, 운영 리포트(동기화별 판정 기록의 추이·신규/해결·EOS 일정, Markdown/HTML 내보내기), EC2·EKS·RDS·ElastiCache·MSK·Serverless(Lambda·DynamoDB·API Gateway), CloudWatch 경보·표준 지표, Systems Manager(관리 노드·패치·Automation 기록), 수명주기(EOS), 거버넌스(Security Hub·GuardDuty와 적용 범위, 태그 준수, AWS Health), 조직 계정(계정별 사용 리전, Root/OU 탐색). '저장된 보기'로 페이지·범위·검색 조건을 서버 측 사용자 설정에 저장한다. 알림 기능은 두지 않는다(사용자 결정). [계획](plans/2026-10-11-enterprise-operations.md)
- **웹 인증:** 별도 IdP 없이 IAM Identity Center SAML 2.0 앱(서버 SAML bridge, popup PKCE, ES256 verifier). 표준 OIDC 경로는 회사 선택지로 남긴다.
- **구성·저장소:** 배포 스키마·`composeOrganizationApi`·`check-deployment`, loopback `npm run start:local`. 회사 선택 저장소 `DynamoDbCloudStore`(SDK 없는 SigV4)는 DynamoDB Local과 실제 AWS 임시 테이블에서 적합성 9/9(테이블 삭제함).
- **worker 격리:** 실제 Docker driver로 합성 사용자 2명 30/30, SIGKILL 복구 8/8, daemon 지연·운영자 회수 확인. [결과](../deploy/organization-cli-worker/isolation-verification.md#로컬-실행-결과-2026-10-10-docker-desktop-2833-linux-arm64)

## 개인 테스트 계정에서 실제로 확인한 것

- Identity Center SAML 웹 로그인 → Payer 연결 → Device Code 승인 → STS 확인 → 조회 → AWS 로그아웃 → 정상 종료 회수(2026-10-10).
- 다계정 동기화(2026-10-11): 계정 1개 접근 확인, 리전 17곳 중 태그된 VPC 리전 1곳에서 서비스 16종 수집. 탭을 떠나도 호스트가 끝까지 수집. Security Hub·GuardDuty '사용 안 함', AWS Health '지원 플랜 필요' 상태 판정과 첫 리포트 기록.
- 새로고침·재로그인 뒤 진행 중인 동기화가 멈춰 보이던 결함을 실사용에서 찾아 고쳤다.
- AWS Config 집계자 모드 동기화 53초(직접 1분 45초와 같은 결과). 동기화는 버튼으로만, 결과 캐시는 사용자+Payer 설정 단위(재로그인·재등록에도 유지). 런북 실행·예약 동기화(서버 옵션, 로컬은 꺼 둠)는 구현했고 합성 검증만 했다.

게이트: `make check` 종료 0, 단위·계약 226/226, 회사 smoke·조직 웹 합성 검증 통과. [지난 검증 기록](history/verification.md)

## 미검증·남음

- 실제 계정: 런북 '연결 점검'은 빈 `Parameters` 결함을 고친 뒤 요청→승인→실행이 성공했다(2026-10-11). EC2 시작·재시작·중지 런북도 테스트 인스턴스로 실행해 성공을 확인했다(인스턴스는 삭제함). 리포트 추이·저장된 보기를 확인했다. 웹 사용자와 Device Code 승인자의 동일성 검사는 서버 설정(`identityPolicy`, 기본 꺼짐)으로 구현해 실계정의 정상 경로(이름 일치)를 확인했다. 불일치 거부는 합성 테스트로만 확인했다. 로컬 Config 기록기·집계자는 켜 둔 상태(월 $1 미만, 원복 정보는 .data/aws-rollback).
- 회사 측: 회사 Identity Center SAML 앱·실제 값, 운영 DynamoDB 테이블·IAM role·TLS/proxy, 회사 Linux 호스트 격리 재실행·장애 주입, 운영자 요구.

대상은 조직 AWS뿐이며 개인 CLI/계정 데이터, GCP/On-Prem/Azure 구현, Firebase/Google SDK, Android를 포함하지 않는다.
