# 테스트용 IAM Identity Center 셋업

2026-10-10. 회사 환경 없이 Device Code 실로그인(NEXT_PLAN 2·4의 1·5번)을 확인할 때 사용하는 개인/테스트 계정 절차다. **아직 실행하지 않았다.** Organizations와 Identity Center 활성화는 계정 전역 설정 변경이라 계정 소유자가 직접 하거나 명시적으로 승인해야 한다. 실제 start URL·계정 ID·사용자 정보는 Git과 보고서에 넣지 않는다.

## 사전 확인 (읽기 전용)

- `aws organizations describe-organization`: 계정이 AWS Organizations management account인지 확인한다. 2026-10-10 기준 대상 개인 계정은 management account(FeatureSet ALL)였다.
- `aws sso-admin list-instances --region <리전>`: 기존 Identity Center instance 여부. 2026-10-10 기준 us-east-1·ap-northeast-2 모두 instance가 없었다.

## 비용

IAM Identity Center와 AWS Organizations는 추가 요금이 없다. 앱이 하는 STS 확인과 EC2/EKS/RDS/ElastiCache/MSK/Lambda/DynamoDB 목록, CloudWatch 경보 조회는 Describe/List 호출로 무료다. CloudWatch 표준 지표는 `GetMetricData`(SEARCH) 한 번이며 조회한 지표 수에 비례해 과금되지만(서드파티 자료 기준 1,000개당 $0.01, AWS 요금 페이지에서 확인 필요) 개인 시험 규모에서는 사실상 0이다. DynamoDB 운영 저장소를 실제 계정에서 시험하려면 provisioned 소용량(always-free 범위)으로 만들고, 시험 후 테이블을 삭제한다.

## 절차

1. Identity Center 콘솔에서 **organization instance**를 활성화한다. account instance는 permission set과 계정 접근을 지원하지 않는다. 리전은 하나만 고를 수 있고 나중에 바꾸려면 삭제 후 다시 만들어야 한다.
2~4. 활성화 후 `bash scripts/identity-center-test-setup.sh <email> [region]`이 사용자, `CloudOpsReadOnly`(ReadOnlyAccess) permission set, 계정 할당을 멱등으로 만든다. connection 값은 Git 제외 `.data/identity-center-test.json`에 쓴다. 콘솔로 할 때는 아래 2~4를 따른다.
2. Identity Center 디렉터리에 테스트 사용자 A(필요하면 B)를 만든다. 이메일 인증을 하고 MFA를 등록한다.
3. AWS 관리형 정책 `ReadOnlyAccess`로 permission set을 만들고, 대상 계정에 사용자와 함께 할당한다. 거버넌스 화면은 Security Hub·GuardDuty·AWS Health·Resource Groups Tagging API 조회 권한을 쓴다. 더 좁은 권한이면 해당 영역은 '권한 없음'으로 표시된다. AWS Health API는 Business 이상 지원 플랜이 필요하며, 없으면 '확인 불가'로 표시된다.
4. 설정에서 start URL(`https://d-xxxxxxxxxx.awsapps.com/start`)과 Identity Center 리전을 확인한다. Git 밖의 배포 JSON `connections[]`에 `startUrl`, `ssoRegion`, `accountId`, `roleName: "ReadOnlyAccess"`, `region`을 넣고 `local.mjs check-deployment`로 검증한다.
5. 웹 로그인용 SAML 앱: Applications → 애플리케이션 추가 → 직접 설정 → SAML 2.0을 고른다. ACS URL은 `<publicOrigin>/api/organizations/saml/acs`, SAML audience는 `samlBridge.sp.entityId`로 한다. 속성 매핑 Subject는 `${user:email}`(emailAddress) 또는 `${user:subject}`(persistent)로 한다. 앱 메타데이터의 sign-in URL·issuer·인증서를 `samlBridge.idp`에 넣고 사용자를 앱에 할당한다. Identity Center가 http loopback ACS를 받는지는 미확인이다. 거부되면 local host에 TLS가 필요하다.
6. worker 네트워크를 AWS SSO/OIDC·STS·조회 API에 나갈 수 있는 테스트 네트워크로 바꾼다. 그다음 [격리 절차](organization-cli-worker/isolation-verification.md)의 1·5번(Device Code 로그인, 세션 확인, 로그아웃)을 사용자별 브라우저 프로필로 수행한다.

worker는 `aws sso login --use-device-code --no-browser`를 실행한다. 사용자는 AWS 공식 페이지에서 코드를 확인하고 로그인/MFA를 완료한다. 이 성공은 해당 테스트 계정 구성의 근거이며 회사 Identity Center·외부 IdP 연동의 검증을 대신하지 않는다.
