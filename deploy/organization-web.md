# 회사 웹 로그인과 AWS 연결

회사 전용 웹은 `apps/web/src/company-main.tsx`에서 시작한다. 실제 회사 인증 adapter는 미설정이며 Firebase 구현이나 개인 CLI fallback이 없다.

## 화면 연결

`apps/web/src/identity/web-identity.ts`의 `WebIdentityClient`를 구현하고 `WebIdentityFactoryProvider`를 통해 `OrganizationAccess` 위에 주입한다. 서버는 `GET /api/organizations/config`에서 `configured: true`, 조직/workspace scope, `identity: {method: "company"}`를 제공한다. `configured:false` 또는 factory 부재이면 미설정 상태로 남는다.

현재 `make dev`는 loopback 5175의 웹 개발 서버만 연다. API proxy와 회사 인증을 자동 구성하지 않는다. 같은 Origin의 웹/API는 빌드 후 loopback 전용 `npm run start:local`로 확인할 수 있다([API 문서](organization-api.md#로컬-loopback-host)). [JSON 예시](organization-web.example.json)는 `organizationDeploymentSchema`가 검증하는 trusted deployment 형식이며 회사 값을 자동으로 찾거나 만들지 않는다.

## Identity Center SAML 웹 로그인 (선택된 방식)

회사 웹 로그인은 별도 IdP 없이 **IAM Identity Center customer managed SAML 2.0 앱**으로 한다. AWS 접근은 연결별 Device Code로 따로 한다. 같은 Identity Center 디렉터리라 두 인증의 사용자가 일치하지만, Device Code 결과를 웹 신원으로 쓰지 않는다(AGENTS.md). 이유는 Device Code 피싱 때문이다. 공격자가 만든 코드를 피해자가 승인하면 공격자 브라우저가 피해자 신원을 얻게 된다.

- 배포 JSON에 `samlBridge`(server-only)를 둔다: `issuer`(https 식별자), `clientId`, `idp.entityId`/`idp.ssoUrl`/`idp.certificates`(Identity Center 앱 메타데이터), `sp.entityId`(앱의 SAML audience), `sessionSeconds`(기본 3600). 이때 `web.identity`는 `{method:"company"}`만 둔다.
- 흐름: 로그인 popup이 `/api/organizations/saml/authorize`(PKCE·state·nonce)로 간다. bridge가 AuthnRequest를 만들어 Identity Center로 보낸다. 서명된 assertion이 `/api/organizations/saml/acs`로 POST되면 bridge가 인증서·issuer·audience·InResponseTo·시간 조건을 검증하고 60초 일회용 code로 `/oidc-callback.html`에 돌려보낸다. 앱은 `/api/organizations/saml/token`에서 PKCE로 교환해 bridge가 ES256으로 서명한 id_token(최대 1시간)을 메모리에 둔다. 서버 verifier는 bridge 공개키만 신뢰한다.
- IdP-initiated(포털에서 바로 연 앱) 응답은 거부한다. 앱에서 로그인을 시작해야 한다. actor는 `identityActor(samlBridge.issuer, NameID)`이며 membership은 `local.mjs actor`로 계산해 등록한다. 로그인 성공만으로는 권한이 없다.
- 제약: 진행 중 요청/code와 서명 키는 프로세스 메모리에 있다. 여러 인스턴스로 운영하려면 sticky session과 공유 서명 키가 필요하다. 재시작하면 다시 로그인한다.
- 검증: `tests/unit/host/saml-bridge.test.ts`(정상 흐름, membership 없는 403, 일회용 code/relay, 다른 서명자·무서명·변조·audience·만료·다른 요청·issuer·signature wrapping 거부, PKCE/Origin 규칙)와 `tests/browser/company-artifacts.mjs`의 합성 SAML IdP Chromium e2e. 실제 Identity Center SAML 앱 연동은 미검증이다.

## 브라우저 OIDC client

`apps/web/src/company-main.tsx`는 서버 config가 `identity: {method: "company", oidc: {...}}`일 때만 `OidcWebIdentityClient`를 만든다. `oidc`가 없으면 화면은 미설정 상태로 남는다.

- `oidc`: `issuer`(https 식별자), `clientId`, `authorizationEndpoint`, `tokenEndpoint`, 선택 `endSessionEndpoint`, `scope`(openid 포함, 기본 `openid`), `bearer`(`id_token` 기본 또는 `access_token`). endpoint는 https이며 로컬 검증만 http loopback을 허용한다.
- 흐름: 로그인 클릭에서 popup을 동기적으로 열고 Authorization Code + PKCE(S256)·state·nonce로 이동한다. IdP는 같은 Origin의 `/oidc-callback.html`로 돌아오고, callback은 URL을 지운 뒤 BroadcastChannel로 state/code만 전달한다. 앱은 state가 맞는 응답만 받아 token endpoint에서 교환하고 id_token의 issuer/audience/nonce/만료를 확인한다. 서명은 서버 verifier가 검사한다.
- token·verifier·state·nonce는 메모리에만 있고 브라우저 저장소에 넣지 않는다. refresh token은 쓰지 않으며 만료 30초 전부터 신원을 지우고 다시 로그인하게 한다. 새 로그인은 이전 시도를 취소하고, 다른 탭의 callback은 무시한다. 로그아웃은 메모리를 비우고 `endSessionEndpoint`가 있으면 popup으로 IdP 세션 종료를 요청한다.
- IdP 요구: public client(PKCE), redirect/post-logout URI `<origin>/oidc-callback.html`, token endpoint CORS에 앱 Origin 허용. local host CSP `connect-src`는 token endpoint origin만 추가한다.

검증: `tests/unit/web/oidc-client.test.ts`(PKCE·state/nonce/issuer/audience/만료·IdP 오류·popup 차단·timeout·이전 시도 취소·로그아웃·access_token 수명)와 `tests/browser/company-artifacts.mjs`의 빌드 산출물 브라우저 검증(합성 IdP popup 로그인 → 연결 목록·추가 → 로그아웃, 저장소에 token 없음, CSP 위반 0). 실제 회사 IdP의 동의 화면·MFA·CORS·세션 정책은 검증하지 않았다.

## Payer 운영 대시보드

- **Payer 선택**: 서버가 허용한 연결 설정(계정·역할·리전, 선택 Organizations 범위)을 Payer SelectBox로 보여 준다. 하나뿐이면 미리 선택된다. 선택과 로그인 성공은 하위 계정 권한을 부여하지 않는다.
- **원클릭 Device Code**: 'AWS Device Code 로그인' 한 번으로 본인 연결 등록 또는 재사용, 명시적 login(worker 생성), 상태 polling이 이어진다. 클릭 순간 빈 창을 열어(opener 제거) 코드가 담긴 AWS 페이지(`verificationUriComplete`)로 이동하므로 사용자가 코드를 입력할 필요가 없다. 코드는 화면에 크게 남겨 AWS 페이지의 코드와 대조하게 한다. 허용 클릭은 사용자가 한다.
- **코드 링크 검증**: 서버·브라우저 모두 code-free URL과, 같은 user code만 담은 URL(`<start>/#/device?user_code=…` 또는 `device.sso…/?user_code=…`)만 받는다.
- **조직 프로필(상단 바)**: 언어 선택 바로 왼쪽에 현재 Payer와 계정·AWS 접근 상태가 보인다. 누르면 웹 사용자·조직, Payer 선택, Payer/역할/리전/AWS 접근 상태, 'AWS Device Code 로그인'·세션 확인·AWS 로그아웃·앱 연결 해제·Payer 목록 새로고침·웹 로그아웃이 팝업으로 열린다. 본문에는 연결 패널을 두지 않는다.
- **동기화(다계정·다리전)**: 상단 '동기화' 버튼(첫 연결에 캐시가 없을 때만 자동 1회)으로 사용자 전용 worker가 Organizations 범위의 계정을 확인한다. 태그된 VPC가 있는 리전(사용 리전)에서만 자원을 읽어 호스트 디스크 캐시에 저장한다. 진행률과 상태(완료·일부 실패 포함·실패·세션 만료)를 모든 화면 상단에 보여 주고, 화면은 항상 캐시를 읽는다. 자세한 계약은 [API 문서](organization-api.md#다계정다리전-동기화)에 있다.
- **범위 필터와 검색 조건**: 모든 화면에 계정·리전 범위(다중 선택)가 있다. 모든 표에는 계정·리전 열이 있고, PropertyFilter 검색 조건(계정·리전·이름·상태·유형·버전 등에 같음/같지 않음/포함/제외, 그리고/또는)과 페이지 이동, CSV 내보내기(현재 조건에 맞는 행, 수식 주입 방지)를 제공한다.
- **좌측 메뉴**: 대시보드 / 운영 리포트 / 컴퓨팅(EC2, EKS) / 데이터·스트리밍(RDS, ElastiCache, MSK) / Serverless(탭: Lambda·DynamoDB·API Gateway) / 모니터링(CloudWatch 경보, 표준 지표) / 운영 관리(Systems Manager: 관리 노드·패치 준수·Automation 기록, 수명주기 EOS) / 거버넌스(보안 태세, 태그 준수, AWS Health) / 조직(계정별 사용 리전·Root/OU 탐색).
- **대시보드**: 요약 카드, 조치·주의 항목(계정·리전·권장 다음 단계·콘솔 링크), 위젯으로 구성한다. 위젯은 CPU 상위, 경보 상태, 리전별·계정별 자원, EC2 상태, EKS 버전 지원, DB·캐시, MSK, Serverless, Systems Manager, EOS 일정, 보안 태세, 태그 준수, AWS Health, 리전 사용 현황이다. 조치·주의 항목은 상위 10개를 보여 주고 '모두 보기'로 전체를 펼친다.
- **운영 리포트**: 동기화마다 호스트가 기록한 판정 결과로 7일/30일 추이, 신규·해결 항목, EOS 일정을 보여 주고 Markdown/HTML로 내보낸다. 최근 동기화에서 읽지 못한 곳에서 사라진 항목은 '확인 불가'다.
- **이메일 알림**: 운영 리포트 아래에서 가린 수신자, 보내는 기준, 최근 발송 결과를 보고 '테스트 메일 보내기'(고정 문구, 1분에 1회)를 누를 수 있다. 수신자와 기준은 서버 설정이다.
- **동기화 중 화면 이동**: 동기화를 시작하면 결과 수집은 호스트가 이어서 하므로 다른 페이지로 가거나 탭을 닫아도 된다. 화면은 보이는 동안 3초마다 진행률을 다시 읽는다.
- **저장된 보기**: 범위 필터 옆 메뉴에서 현재 페이지·탭·범위·검색 조건을 이름으로 저장하고 다시 연다. 서버 저장소의 사용자 설정이며 조회 결과는 저장하지 않는다. 콘솔 링크는 Identity Center shortcut(`<start>/#/console?account_id&role_name&destination`)으로 그 자원의 계정에서 사용자 자신의 permission set으로 열린다.
- **판정 기준**: 수집한 근거로만 판정한다.
  - 경보: ALARM=조치, INSUFFICIENT_DATA=주의
  - 상태: RDS·ElastiCache·MSK 실패 상태=조치, 전환 상태=참고
  - 표준 지표: 지난 1시간. EC2 상태 검사 실패=조치, CPU ≥90%=주의, RDS 여유 저장공간 <10/2GiB, MSK 디스크 ≥85/95%
  - Systems Manager: 실행 중이지만 SSM 미관리인 EC2=참고(그 계정·리전의 SSM 조회가 성공한 경우만), ConnectionLost=주의, 패치 비준수=주의(CRITICAL=조치), 실패·시간 초과 Automation=주의
  - 보안: Security Hub CRITICAL=조치, HIGH=주의(계정·리전별 묶음). GuardDuty 심각도 7.0 이상=조치. 사용 리전에서 Security Hub/GuardDuty가 꺼져 있으면 주의.
  - AWS Health: 진행 중 이슈·예정 변경=주의, 계정 알림=참고. 지원 플랜이 없어 읽지 못한 계정은 '확인 불가'로 안내하고 조회 실패로 세지 않는다.
  - 필수 태그(`inventory.requiredTags`가 있을 때): 누락=참고(계정·리전·서비스별 묶음). 태그를 수집하지 못한 자원은 '미수집'이다.
  - 수명주기(EOS): 지원 종료=조치, 확장 지원·지원 중단=주의, 30일 내 종료=주의, 90일 내 종료=참고. 근거가 없으면 '확인 불가'이며 정상으로 보지 않는다.
  - 조회 실패한 계정·리전·서비스는 참고 항목과 해당 화면 경고로 남는다.
- **수명주기(EOS) 근거**: EKS·RDS·MSK 상태는 AWS API다. Lambda 런타임·ElastiCache(Redis OSS)·MSK 종료일·운영체제(SSM 플랫폼)는 AWS/벤더 문서이며, 캡처일 2026-10-11로 화면에 표시한다.
- **조회 캐시(로컬 디스크)**: `CLOUDOPS_OBSERVATION_CACHE`(기본 `.data/observations`)에 사용자·연결별로 동기화 요약과 단위 파일을 저장한다(0700/0600, 원자적 교체). 브라우저 저장소에는 넣지 않는다. 감사 저장소가 아니며 보존 기간은 호스트가 정한다.
- 설정이 바뀐 같은 `configurationId`의 이전 연결은 등록 시 비활성화된다. 그 worker 권한 확인은 실패해 회수되고, 새 연결이 만들어진다.

## 운영 흐름

1. 회사 웹 로그인 후 서버 membership에 등록된 사용자가 본인의 허용된 연결을 조회/추가한다.
2. 명시적 **AWS Device Code 로그인**을 누르고 공식 AWS 페이지에서 로그인/MFA를 완료한다.
3. 동기화로 범위의 계정을 확인하고, 사용 리전(태그된 VPC)마다 경보·표준 지표·EC2·EKS·RDS·ElastiCache·MSK·Lambda·DynamoDB·API Gateway·Systems Manager·Security Hub·GuardDuty의 제한된 첫 페이지를, 계정마다 AWS Health를 한 번 읽는다.
4. 지정된 directory가 있으면 Root/OU의 직접 자식 페이지를 탐색한다. 조직 전체 집계와 계정 서비스 정상 여부를 추정하지 않는다.
5. 앱 연결 해제, AWS 로그아웃, 웹 로그아웃의 차이를 표시한다.

사용자 전환·401/403/404·웹 로그아웃은 이전 연결/코드/관측을 비우고 늦은 응답을 버린다. 연결/결과/token은 브라우저 저장소에 보관하지 않으며 언어 선택만 저장한다. 응답 유실 시 같은 요청 키를 사용하고, 상태/새로고침으로 로그인이나 worker 생성이 시작되지 않는다.

`test:organization-web`는 별도 합성 identity/HTTP fixture로 실제 브라우저를 검증한다. fixture는 제품 빌드에 포함되지 않는다. 이 검증은 회사 IdP·AWS SSO 네트워크나 물리 worker 격리의 증거가 아니다.
