# 현재 상태

갱신: 2026-10-10. 독립 CloudOps-Auto-Company 로컬 저장소 분리를 마쳤다. 회사 입력 없이 만들 수 있는 인증·구성·저장소·격리 기반을 추가했다. 사용자 승인으로 로컬 Docker 검증까지 수행했다.

조직 AWS 웹/API/private CLI worker, 공통 계약·신원/저장 port와 관련 테스트를 이전했다. 독립 main Git 저장소이며 사용자 승인으로 초기 로컬 commit을 만들었다(remote·push 없음). 원본 CloudOps-Automation과 ai-builder-cup은 별도로 보존한다.

구현과 근거:
- 웹 인증: 사용자 결정으로 별도 IdP 없이 **Identity Center SAML 2.0 앱**으로 통일했다. 서버 SAML bridge(`@node-saml/node-saml` 5.1.0, xml-crypto 6.3.3)가 assertion을 검증하고, 기존 popup PKCE client와 ES256 verifier를 재사용한다. 합성 SAML IdP로 단위 테스트와 Chromium e2e를 통과했다. OIDC 경로는 후보로 남긴다.
- 구성: 배포 스키마·`composeOrganizationApi`·`check-deployment`, loopback `npm run start:local`, opt-in Docker provisioner.
- 저장소: `cloudStoreConformance`와 회사 선택인 DynamoDB adapter `DynamoDbCloudStore`(SDK 없이 SigV4). SigV4 벡터는 AWS 문서·botocore와 일치했다. DynamoDB Local 9/9를 통과했고, 승인을 받아 **실제 AWS DynamoDB 임시 테이블에서도 9/9**를 통과한 뒤 테이블을 삭제했다.
- worker 격리: 실제 Docker driver로 합성 사용자 2명 30/30을 통과했다(internal 네트워크, AWS 미접속). [결과](../deploy/organization-cli-worker/isolation-verification.md#로컬-실행-결과-2026-10-10-docker-desktop-2833-linux-arm64)
- AWS 인증: 회사는 Identity Center start URL + Device Code 방식이다. 개인 계정을 읽기 전용으로 확인한 결과 Organizations management account이고 Identity Center instance는 없다. 무료로 같은 셋업이 가능하다. [절차](../deploy/identity-center-test-setup.md)

게이트: `make check` 종료 0, 서버 174/174, 회사 smoke·조직 웹 계약 통과. [검증 기록](verification.md).

개인 테스트 계정에서 **실제 Identity Center SAML 웹 로그인 → 연결 → Device Code 승인 → STS 확인 → Lambda 조회 → AWS 로그아웃 → 정상 종료 회수**까지 end-to-end 통과(CLI 2.30 `#/device` URL 결함 발견·수정). 미검증: 운영 DynamoDB 테이블·IAM role과 TLS/proxy, 회사 Linux 호스트 격리·장애 주입, 회사 배포, 운영자 요구.

대상은 조직 AWS뿐이며 개인 CLI/계정 데이터, GCP/On-Prem/Azure 구현, Firebase/Google SDK, Android를 포함하지 않는다. 공통 web 스키마에 `firebase-google` 식별자가 남아 있으나 배포 스키마가 company 방식만 허용한다.
