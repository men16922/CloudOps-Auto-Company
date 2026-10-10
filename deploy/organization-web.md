# 회사 웹 로그인과 AWS 연결

회사 전용 웹은 `src/company-main.tsx`에서 시작한다. 실제 회사 인증 adapter는 미설정이며 Firebase 구현이나 개인 CLI fallback이 없다.

## 화면 연결

`src/platform/web-identity.ts`의 `WebIdentityClient`를 구현하고 `WebIdentityFactoryProvider`를 통해 `OrganizationAccess` 위에 주입한다. 서버는 `GET /api/organizations/config`에서 `configured: true`, 조직/workspace scope, `identity: {method: "company"}`를 제공한다. `configured:false` 또는 factory 부재이면 미설정 상태로 남는다.

현재 `make dev`는 loopback 5175의 웹 개발 서버만 연다. API proxy와 회사 인증을 자동 구성하지 않는다. 같은 Origin의 웹/API는 빌드 후 loopback 전용 `npm run start:local`로 확인할 수 있다([API 문서](organization-api.md#로컬-loopback-host)). [JSON 예시](organization-web.example.json)는 `organizationDeploymentSchema`가 검증하는 trusted deployment 형식이며 회사 값을 자동으로 찾거나 만들지 않는다.

## Identity Center SAML 웹 로그인 (선택된 방식)

회사 웹 로그인은 별도 IdP 없이 **IAM Identity Center customer managed SAML 2.0 앱**으로 한다. AWS 접근은 연결별 Device Code로 따로 한다. 같은 Identity Center 디렉터리라 두 인증의 사용자가 일치하지만, Device Code 결과를 웹 신원으로 쓰지 않는다(AGENTS.md). 이유는 Device Code 피싱 때문이다. 공격자가 만든 코드를 피해자가 승인하면 공격자 브라우저가 피해자 신원을 얻게 된다.

- 배포 JSON에 `samlBridge`(server-only)를 둔다: `issuer`(https 식별자), `clientId`, `idp.entityId`/`idp.ssoUrl`/`idp.certificates`(Identity Center 앱 메타데이터), `sp.entityId`(앱의 SAML audience), `sessionSeconds`(기본 3600). 이때 `web.identity`는 `{method:"company"}`만 둔다.
- 흐름: 로그인 popup이 `/api/organizations/saml/authorize`(PKCE·state·nonce)로 간다. bridge가 AuthnRequest를 만들어 Identity Center로 보낸다. 서명된 assertion이 `/api/organizations/saml/acs`로 POST되면 bridge가 인증서·issuer·audience·InResponseTo·시간 조건을 검증하고 60초 일회용 code로 `/oidc-callback.html`에 돌려보낸다. 앱은 `/api/organizations/saml/token`에서 PKCE로 교환해 bridge가 ES256으로 서명한 id_token(최대 1시간)을 메모리에 둔다. 서버 verifier는 bridge 공개키만 신뢰한다.
- IdP-initiated(포털에서 바로 연 앱) 응답은 거부한다. 앱에서 로그인을 시작해야 한다. actor는 `identityActor(samlBridge.issuer, NameID)`이며 membership은 `local.mjs actor`로 계산해 등록한다. 로그인 성공만으로는 권한이 없다.
- 제약: 진행 중 요청/code와 서명 키는 프로세스 메모리에 있다. 여러 인스턴스로 운영하려면 sticky session과 공유 서명 키가 필요하다. 재시작하면 다시 로그인한다.
- 검증: `server/organization-saml-bridge.test.ts`(정상 흐름, membership 없는 403, 일회용 code/relay, 다른 서명자·무서명·변조·audience·만료·다른 요청·issuer·signature wrapping 거부, PKCE/Origin 규칙)와 `check-company.mjs`의 합성 SAML IdP Chromium e2e. 실제 Identity Center SAML 앱 연동은 미검증이다.

## 브라우저 OIDC client

`src/company-main.tsx`는 서버 config가 `identity: {method: "company", oidc: {...}}`일 때만 `OidcWebIdentityClient`를 만든다. `oidc`가 없으면 화면은 미설정 상태로 남는다.

- `oidc`: `issuer`(https 식별자), `clientId`, `authorizationEndpoint`, `tokenEndpoint`, 선택 `endSessionEndpoint`, `scope`(openid 포함, 기본 `openid`), `bearer`(`id_token` 기본 또는 `access_token`). endpoint는 https이며 로컬 검증만 http loopback을 허용한다.
- 흐름: 로그인 클릭에서 popup을 동기적으로 열고 Authorization Code + PKCE(S256)·state·nonce로 이동한다. IdP는 같은 Origin의 `/oidc-callback.html`로 돌아오고, callback은 URL을 지운 뒤 BroadcastChannel로 state/code만 전달한다. 앱은 state가 맞는 응답만 받아 token endpoint에서 교환하고 id_token의 issuer/audience/nonce/만료를 확인한다. 서명은 서버 verifier가 검사한다.
- token·verifier·state·nonce는 메모리에만 있고 브라우저 저장소에 넣지 않는다. refresh token은 쓰지 않으며 만료 30초 전부터 신원을 지우고 다시 로그인하게 한다. 새 로그인은 이전 시도를 취소하고, 다른 탭의 callback은 무시한다. 로그아웃은 메모리를 비우고 `endSessionEndpoint`가 있으면 popup으로 IdP 세션 종료를 요청한다.
- IdP 요구: public client(PKCE), redirect/post-logout URI `<origin>/oidc-callback.html`, token endpoint CORS에 앱 Origin 허용. local host CSP `connect-src`는 token endpoint origin만 추가한다.

검증: `server/oidc-web-client.test.ts`(PKCE·state/nonce/issuer/audience/만료·IdP 오류·popup 차단·timeout·이전 시도 취소·로그아웃·access_token 수명)와 `check-company.mjs`의 빌드 산출물 브라우저 검증(합성 IdP popup 로그인 → 연결 목록·추가 → 로그아웃, 저장소에 token 없음, CSP 위반 0). 실제 회사 IdP의 동의 화면·MFA·CORS·세션 정책은 검증하지 않았다.

## 운영 흐름

1. 회사 웹 로그인 후 서버 membership에 등록된 사용자가 본인의 허용된 연결을 조회/추가한다.
2. 명시적 **AWS Device Code 로그인**을 누르고 공식 AWS 페이지에서 로그인/MFA를 완료한다.
3. STS 확인 뒤 Lambda/DynamoDB/CloudWatch 경보의 제한된 첫 페이지를 읽는다.
4. 지정된 directory가 있으면 Root/OU의 직접 자식 페이지를 탐색한다. 조직 전체 집계와 계정 서비스 정상 여부를 추정하지 않는다.
5. 앱 연결 해제, AWS 로그아웃, 웹 로그아웃의 차이를 표시한다.

사용자 전환·401/403·웹 로그아웃은 이전 연결/코드/관측을 비우고 늦은 응답을 버린다. 연결/결과/token은 브라우저 저장소에 보관하지 않으며 언어 선택만 저장한다. 응답 유실 시 같은 요청 키를 사용하고, 상태/새로고침으로 로그인이나 worker 생성이 시작되지 않는다.

`test:organization-web`는 별도 합성 identity/HTTP fixture로 실제 브라우저를 검증한다. fixture는 제품 빌드에 포함되지 않는다. 이 검증은 회사 IdP·AWS SSO 네트워크나 물리 worker 격리의 증거가 아니다.
