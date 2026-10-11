# 회사 웹 인증과 AWS Device Code

갱신: 2026-10-11. 이 문서는 조직 AWS 코드의 인증·격리 경계와 남은 회사 구성을 설명한다. 개인 테스트 Identity Center로 SAML 웹 로그인·Device Code·다계정 동기화를, 로컬 Docker로 사용자별 worker 격리를 확인했다. 회사 IdP·회사 Identity Center·운영 배포는 아직 검증하지 않았다.

그림으로 보려면 [인증 흐름도](auth-flow.md)를 먼저 본다. 웹 사용자와 Device Code 승인자의 동일성 검사가 아직 없다는 점도 거기에 정리했다.

## 두 인증의 역할

브라우저 → Backend → 사용자별 AWS CLI Device Code 흐름이다. 현재 Backend 구현은 TypeScript/Node이며 Flask 어댑터는 포함하지 않는다.

1. **회사 웹 로그인:** `WebIdentityClient`와 서버 `WebIdentityVerifier`를 회사 인증에 맞게 주입한다. 서버는 서명·issuer/audience·만료·회수 등을 검증한 뒤 안정된 actor를 만든다. 2026-10-10 결정: 별도 IdP 없이 IAM Identity Center SAML 2.0 앱을 쓰고 서버 SAML bridge가 검증한다([웹 adapter](../../deploy/organization-web.md#identity-center-saml-웹-로그인-선택된-방식)). 실제 Identity Center 앱 연동은 미검증이다.
2. **조직 접근:** 검증된 actor와 별도로 organization/workspace membership·역할을 검사한다. 이메일·요청 body·클라이언트 role로 권한을 만들지 않는다.
3. **AWS 로그인:** 서버가 고정한 연결 설정으로 전용 CLI worker가 Device Code를 시작한다. 사용자는 AWS의 공식 로그인 페이지에서 회사 인증/MFA를 완료한다. AWS Device Code token을 웹 로그인 token으로 사용하지 않는다.
4. **AWS 대상 확인:** worker가 STS 계정/역할을 확인한다. 계정·역할·리전·binding과 달라지면 조회 결과를 거부한다. 시작 URL이나 Payer 선택으로 하위 계정 권한이 부여되는 것은 아니다.

## 사용자별 격리

profile과 sso-session 이름뿐 아니라 실제 홈·SSO cache·임시 자격증명 cache·실행 환경을 분리한다. 공유 홈, 공용 cache, 요청마다 전역 AWS_PROFILE을 바꾸는 방식은 사용하지 않는다. 개발자의 개인 `.aws`를 복사하거나 fallback하지 않는다.

`OrganizationConnections`는 소유자·조직·계정·역할·리전을 고정한다. `OrganizationWorkerLeases`와 supervisor는 지속 lease/세대를 확인하고 사용자별 private pipe를 연결한다. 브라우저에는 pipe/CLI 명령/profile/endpoint를 공개하지 않는다. 실제 컨테이너/OS에서 두 사용자의 격리와 cache 접근 차단이 되는지는 배포 환경 검증이 필요하다.

연결 해제·웹 로그아웃·AWS 로그아웃은 서로 다른 작업이다. 미확인 생성/명령은 자동 재전송하지 않는다. 종료와 cache 접근 차단이 확인되지 않으면 해당 세대는 unknown으로 남긴다. 늦은 응답이 새 사용자의 화면이나 worker를 바꾸지 않게 한다.

## 회사에서 결정할 것

- 웹 로그인용 Identity Center SAML 앱(ACS·audience·Subject 매핑), 안정된 actor 매핑, membership 관리 경로.
- IAM Identity Center 시작 URL·SSO 리전, 회사가 할당한 AWS 계정·역할, 조회 리전과 directory 범위.
- 운영 저장소, worker 실행 호스트, private 통신, 사용자별 home/cache, 종료·보존 정책.
- TLS/Origin/Host·회사 프록시/CA·네트워크 정책. 인증/검사를 우회하도록 완화하지 않는다.

기존 CLI가 회사에서 된다는 사실은 중요한 입력이지만 이 공유 웹 서비스의 실제 인증·격리·배포 검증을 대신하지 않는다. 이 문서는 회사의 기존 절차에 연결할 조건이며 새로운 회사 승인 체계를 정의하지 않는다.

[API 구성](../../deploy/organization-api.md) · [웹 adapter](../../deploy/organization-web.md) · [private worker](../../deploy/organization-cli-worker/README.md) · [현재 검증](../history/verification.md)
