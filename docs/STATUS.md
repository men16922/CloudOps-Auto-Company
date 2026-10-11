# 현재 상태

갱신: 2026-10-11. 독립 CloudOps-Auto-Company 로컬 저장소 분리를 마쳤다. 회사 입력 없이 만들 수 있는 인증·구성·저장소·격리 기반을 추가했다. 사용자 승인으로 로컬 Docker 검증까지 수행했다.

조직 AWS 웹/API/private CLI worker, 공통 계약·신원/저장 port와 관련 테스트를 이전했다. 독립 main Git 저장소이며 사용자 승인으로 초기 로컬 commit을 만들었다(remote·push 없음). 원본 CloudOps-Automation과 ai-builder-cup은 별도로 보존한다.

구조: `apps/web`(화면)·`apps/host`(API·연결·worker 관리·리포트 기록)·`apps/worker`(Docker 수집기)와 공유 `packages/`(contracts·assessment·worker-protocol). 빌드별 허용 폴더를 검사한다. [레포 구조](architecture/overview.md).

구현과 근거:
- 대시보드: 상단 바 조직 프로필(Payer·Device Code·세션), 다계정·다리전 **동기화**. 동기화는 사용자 전용 worker가 Organizations 범위의 계정을 STS로 확인하고 태그된 VPC가 있는 리전만 읽어 디스크 캐시에 저장한다. 직접 조회 모드와 AWS Config 집계자 모드가 있다. 모든 표에 계정·리전 열·범위 필터·검색 조건·CSV 내보내기가 있다. 메뉴는 운영 리포트(동기화별 판정 기록으로 추이·신규/해결·EOS 일정, Markdown/HTML 내보내기)·EC2·EKS·RDS·ElastiCache·MSK·Serverless(Lambda·DynamoDB·API Gateway 탭)·경보·표준 지표·Systems Manager(관리 노드·패치·Automation 기록)·수명주기(EOS)·거버넌스(보안 태세: Security Hub·GuardDuty와 적용 범위, 태그 준수, AWS Health)·조직 계정(계정별 사용 리전)이다. 범위 필터 옆 '저장된 보기'로 페이지·범위·검색 조건을 서버 측 사용자 설정에 저장한다. [계획](plans/2026-10-11-enterprise-operations.md)
- 웹 인증: 사용자 결정으로 별도 IdP 없이 **Identity Center SAML 2.0 앱**으로 통일했다. 서버 SAML bridge(`@node-saml/node-saml` 5.1.0, xml-crypto 6.3.3)가 assertion을 검증하고, 기존 popup PKCE client와 ES256 verifier를 재사용한다. 합성 SAML IdP로 단위 테스트와 Chromium e2e를 통과했다. OIDC 경로는 후보로 남긴다.
- 구성: 배포 스키마·`composeOrganizationApi`·`check-deployment`, loopback `npm run start:local`, opt-in Docker provisioner.
- 저장소: `cloudStoreConformance`와 회사 선택인 DynamoDB adapter `DynamoDbCloudStore`(SDK 없이 SigV4). SigV4 벡터는 AWS 문서·botocore와 일치했다. DynamoDB Local 9/9를 통과했고, 승인을 받아 **실제 AWS DynamoDB 임시 테이블에서도 9/9**를 통과한 뒤 테이블을 삭제했다.
- worker 격리: 실제 Docker driver로 합성 사용자 2명 30/30을 통과했다(internal 네트워크, AWS 미접속). [결과](../deploy/organization-cli-worker/isolation-verification.md#로컬-실행-결과-2026-10-10-docker-desktop-2833-linux-arm64)
- AWS 인증: 회사는 Identity Center start URL + Device Code 방식이다. 개인 계정을 읽기 전용으로 확인한 결과 Organizations management account이고 Identity Center instance는 없다. 무료로 같은 셋업이 가능하다. [절차](../deploy/identity-center-test-setup.md)

게이트: `make check` 종료 0, 단위·계약 212/212, 회사 smoke·조직 웹 계약 통과. [검증 기록](history/verification.md).

개인 테스트 계정에서 **실제 Identity Center SAML 웹 로그인 → 연결 → Device Code 승인 → STS 확인 → Lambda 조회 → AWS 로그아웃 → 정상 종료 회수**까지 end-to-end 통과(CLI 2.30 `#/device` URL 결함 발견·수정). 미검증: 운영 DynamoDB 테이블·IAM role과 TLS/proxy, 회사 Linux 호스트 격리·장애 주입, 회사 배포, 운영자 요구.

대상은 조직 AWS뿐이며 개인 CLI/계정 데이터, GCP/On-Prem/Azure 구현, Firebase/Google SDK, Android를 포함하지 않는다. 웹 설정 스키마도 회사 신원 방식(IAM Identity Center SAML·OIDC)만 둔다.
