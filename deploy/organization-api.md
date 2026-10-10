# 회사 조직 AWS API 구성

`server/modules/aws/organization/index.ts`는 `createOrganizationApiServer`, `composeOrganizationApi`, `organizationDeploymentSchema`, `OrganizationWebAccess`, `OidcJwtVerifier`, 연결/worker runtime과 identity/store/provisioner port를 export한다. 회사가 명시적인 composition에서 이 port들을 연결해야 한다. 외부에 공개하는 운영 server entry와 자동 membership 등록은 없다.

## Composition

```ts
const composition = composeOrganizationApi({
  deployment: trustedDeploymentJson,          // organizationDeploymentSchema로 검증
  store: durableStore,                        // 회사 운영 저장소
  verifier: companyVerifier,                  // 예: new OidcJwtVerifier(oidcConfig)
  provisioner: companyInfrastructureDriver,   // 없으면 worker 호출은 worker_unavailable
});
// The company host owns the listener/TLS and must await composition.close() at shutdown.
```

`organizationDeploymentSchema`는 [JSON 예시](organization-web.example.json)의 `publicOrigin`/`web`/`connections`와 선택 `samlBridge`([Identity Center SAML 웹 로그인](organization-web.md#identity-center-saml-웹-로그인-선택된-방식))를 strict하게 검증한다. `samlBridge`가 있으면 composition이 bridge endpoint·브라우저 OIDC 설정·verifier를 직접 구성하므로 verifier를 따로 주입하면 거부한다. publicOrigin은 https origin(로컬은 http loopback)만 받는다. 회사 edition은 `identity.method: "company"`만 받고, 모든 연결은 web scope의 조직/workspace와 같아야 한다. 중복 configurationId와 미설정 web의 연결 등록은 거부한다. verifier가 없거나 web이 미설정이면 composition은 unconfigured(503)로 남는다.

이 예시는 구성 경계이며 구체적인 verifier/store/driver의 운영 배포가 완료됐다는 뜻이 아니다. `SqliteCloudStore`는 합성 테스트·로컬 host용이고 운영용 저장소를 자동 선택하지 않는다. 신뢰된 관리 코드가 `OrganizationWebAccess.provision`으로 versioned membership을 준비한다. 웹 로그인 성공은 membership/계정 권한 부여가 아니다.

## 표준 OIDC verifier 후보

`OidcJwtVerifier`는 회사가 OIDC IdP를 선택할 때 주입할 수 있는 서버 adapter 후보다. 새 의존성 없이 `node:crypto`로 RS256(기본)/PS256/ES256 서명, 정확한 issuer, audience(다중 audience는 azp 일치), exp/iat/nbf(허용 skew 최대 300초), 최대 수명, 선택형 tenant allow-list와 revocation hook을 검사한다. actor는 `identityActor(iss, sub, tenant)`이며 email/role claim은 권한이 아니다. JWKS는 설정에 고정하거나 https URI에서 가져온다. 원격 JWKS는 redirect를 따르지 않고 5초 timeout·64KiB 제한이 있으며, 알 수 없는 kid나 장애가 있어도 provider 호출은 최소 1분 간격이다. 지원하지 않는 키는 하나씩 건너뛴다. [설정 예시](organization-oidc.example.json)

ID token과 access token 중 무엇을 API Bearer로 쓸지, audience 값, tenant claim, revocation/세션 종료 확인 방식은 회사 IdP 결정이다. 브라우저 쪽 짝은 [웹 문서](organization-web.md#브라우저-oidc-client)의 `OidcWebIdentityClient`다. 둘 다 합성 키·합성 IdP로만 검증했으며 실제 회사 IdP와의 연동 검증이 아니다.

## 로컬 loopback host

`npm run build` 후 `npm run start:local`(`dist-company-api/local.mjs serve`)은 `dist-company/`와 조직 API를 같은 loopback origin에서 제공한다. 127.0.0.1/localhost 외 bind와 publicOrigin 불일치를 거부한다. TLS·proxy·운영 저장소·worker provisioner가 없으므로 AWS 로그인/조회는 `worker_unavailable`이다. 운영 server로 사용하지 않는다.

| 환경 변수 | 의미 |
|---|---|
| `CLOUDOPS_DEPLOYMENT` | 배포 JSON. 없으면 미설정 |
| `CLOUDOPS_WEB_IDENTITY` | OIDC verifier JSON. 없으면 API 503 |
| `CLOUDOPS_LOCAL_STORE` | SQLite 경로. 기본 `.data/organization-local.sqlite`(Git 제외) |
| `CLOUDOPS_LOCAL_HOST`/`PORT` | 기본 127.0.0.1:5176 |
| `CLOUDOPS_TLS_CERT_FILE`/`KEY_FILE` | 선택 TLS(PEM). 설정하면 https로 서비스하며 publicOrigin도 `https://host:port`여야 한다. IdP가 http ACS를 거부할 때 쓴다 |
| `CLOUDOPS_DOCKER_WORKER_CONFIG` | 승인된 격리 검증용 Docker driver 설정. `CLOUDOPS_ORGANIZATION_DOCKER_ENABLED=1`도 필요하며 오프라인 테스트에서는 시작을 거부한다. [격리 검증 절차](organization-cli-worker/isolation-verification.md) |

membership은 `local.mjs actor --issuer <url> --subject <sub> [--tenant <id>]`로 actorId를 계산한 뒤 `local.mjs provision-membership <file.json>`으로 로컬 store에 넣는다. HTTP로 노출하지 않는 신뢰된 관리 경로이며 version은 증가만 허용한다. 실제 회사 설정·사용자 식별자를 담은 파일은 Git에 넣지 않는다.

`local.mjs reconcile-worker <connectionId>`는 비정상 종료 뒤 운영자 회수용이다. 만료된(`unknown`) lease만 대상으로 하고, Docker driver로 기록된 container를 fence·제거해 stop/cache 회수 receipt를 받은 뒤에만 retire한다. 살아 있는 lease는 거부한다. 그 worker를 만든 설정(imageId 등)으로 실행해야 driver의 무결성 검사를 통과한다. `serve`는 SIGINT/SIGTERM/SIGHUP에서 worker를 회수한 뒤 종료한다.

`local.mjs check-deployment <deployment.json> [oidc-verifier.json]`은 두 파일을 함께 검증한다. 브라우저 OIDC issuer/clientId와 서버 verifier issuer/audience(id_token Bearer일 때)가 다르면 실패한다. 출력은 계정 ID·host를 가린 요약과 경고(미설정, http loopback 등)라 검토 자료로 붙일 수 있다.

## DynamoDB 운영 저장소

회사 선택 저장소는 DynamoDB다. `DynamoDbCloudStore`(`server/cloud-dynamodb-store.ts`, 라이브러리 export)는 SDK 없이 `node:crypto` SigV4로 DynamoDB JSON API를 호출한다. 경계 정책의 `@aws-sdk` 거부를 유지한다.

- 테이블: 파티션 키 `pk`(String) 하나. 항목은 `version`(Number)과 `payload`(JSON String)다. 삭제 보호와 PITR 같은 운영 정책은 회사가 정한다.
- 일관성: 읽기는 `ConsistentRead`이고 key별 version을 기록한다. 커밋은 `TransactWriteItems` 한 번이며, 쓴 key는 조건부 Put이고 읽기만 한 key는 ConditionCheck다. 조건이 실패하거나 트랜잭션이 충돌하면 callback을 다시 실행한다(최대 10회 후 409). 단일 key 읽기는 커밋 호출을 생략하고, 여러 key를 읽기만 한 트랜잭션도 ConditionCheck로 검증한다(쓰기 용량 소모).
- 응답 유실: 같은 `ClientRequestToken`으로 최대 3회 재전송해 한 번만 반영한다. 계속 실패하면 `store_unavailable`(503)이며, 결과는 미확인으로 다룬다.
- 한도: payload 350KB 초과는 413 `record_too_large`, 100 key 초과 트랜잭션은 413이다.
- IAM 최소 권한(테이블 ARN 한정): `dynamodb:GetItem`, `dynamodb:PutItem`, `dynamodb:ConditionCheckItem`. 자격은 `environmentCredentials()`(환경 변수) 또는 회사가 주입하는 role 기반 provider를 쓴다. 개발자 개인 CLI 프로필은 읽지 않는다.

```ts
const store = new DynamoDbCloudStore({ tableName, region }, { credentials: companyCredentialProvider });
```

검증: 서버 테스트에서 SigV4가 AWS 문서 예시·botocore 벡터와 일치하고, in-process fake로 적합성·토큰 재전송·장애를 확인한다. opt-in `npm run verify:dynamodb-local`은 Docker DynamoDB Local(digest 고정, loopback, 더미 자격)에서 적합성 8항목과 membership·연결 registry를 확인한다. 실제 AWS DynamoDB 테이블에서는 아직 실행하지 않았다.

## 운영 저장소 적합성

`server/cloud-store-conformance.ts`의 `cloudStoreConformance(name, open)`는 회사 운영 저장소 adapter가 통과해야 할 `CloudStore` 계약 테스트다. 미존재 key, 값 복사, 예외 시 무커밋, read-before-write, 동시 read-modify-write 무손실과 callback 재실행, 동시 생성 충돌, 1MiB 초과 거부(413 `record_too_large`), 재오픈 후 유지(선택)를 검사한다. 로컬 `SqliteCloudStore`는 `server/cloud-store.test.ts`로 이 묶음을 통과한다. 충돌 감지가 없는 고의로 잘못된 adapter는 5개 항목에서 실패하는 것을 확인했다. 일회용 합성 DB에서만 실행하며 백업·복구·감사 불변성의 증거가 아니다.

## HTTP

기본 경로는 `/api/organizations/v1/:organizationId/workspaces/:workspaceId/aws/connections`다.

| 요청 | 동작 |
|---|---|
| GET base | 본인 연결과 서버가 허용한 구성 목록 |
| POST base | configurationId로 본인 연결 등록 |
| GET /:connectionId/status | fresh worker 상태와 필요한 Device Code 안내 |
| POST /:connectionId/actions | login/verify/inspect/directory/disconnect/logout |

매 요청에 현재 Bearer 신원·membership·소유권을 검사한다. POST는 UUID Idempotency-Key와 strict JSON을 받는다. 웹 Host/Origin을 고정하고 Origin 없는 GET은 same-origin Fetch Metadata를 요구한다. 개인/demo cookie·forwarded-user header·body의 actor/role은 권한이 아니다.

inspect는 등록된 lambda/dynamodb/alarms만 받는다. directory는 worker 발급 cursor만 받으며 raw parent/profile/NextToken을 받지 않는다. [directory 범위](organization-directory.md)를 따른다. 알 수 없는 개인/GCP/데모 경로는 404이고, 미설정 회사 API는 503이다.

외부 호출은 재시도 가능한 저장 transaction 밖에 둔다. 응답 유실/도중 권한 회수/만료는 unknown을 보존하고 같은 요청을 자동 재실행하지 않는다. 실제 물리 driver·회사 웹/SSO와 재시작·두 사용자 격리를 확인해야 한다. [인증 경계](../Identity.md) · [worker 계약](organization-cli-worker/README.md)
