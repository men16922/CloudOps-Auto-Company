# 회사 조직 AWS API 구성

`apps/host/src/index.ts`는 `createOrganizationApiServer`, `composeOrganizationApi`, `organizationDeploymentSchema`, `OrganizationWebAccess`, `OidcJwtVerifier`, 연결/worker runtime과 identity/store/provisioner port를 export한다. 회사가 명시적인 composition에서 이 port들을 연결해야 한다. 외부에 공개하는 운영 server entry와 자동 membership 등록은 없다.

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
| `CLOUDOPS_DYNAMODB_STORE` | 선택 DynamoDB store JSON(`tableName`/`region`/`endpoint?`). 자격은 환경 변수 `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`만 쓰고 CLI 프로필은 읽지 않는다 |
| `CLOUDOPS_TLS_CERT_FILE`/`KEY_FILE` | 선택 TLS(PEM). 설정하면 https로 서비스하며 publicOrigin도 `https://host:port`여야 한다. IdP가 http ACS를 거부할 때 쓴다 |
| `CLOUDOPS_DOCKER_WORKER_CONFIG` | 승인된 격리 검증용 Docker driver 설정. `CLOUDOPS_ORGANIZATION_DOCKER_ENABLED=1`도 필요하며 오프라인 테스트에서는 시작을 거부한다. [격리 검증 절차](organization-cli-worker/isolation-verification.md) |

membership은 `local.mjs actor --issuer <url> --subject <sub> [--tenant <id>]`로 actorId를 계산한 뒤 `local.mjs provision-membership <file.json>`으로 로컬 store에 넣는다. HTTP로 노출하지 않는 신뢰된 관리 경로이며 version은 증가만 허용한다. 실제 회사 설정·사용자 식별자를 담은 파일은 Git에 넣지 않는다.

`local.mjs reconcile-worker <connectionId>`는 비정상 종료 뒤 운영자 회수용이다. 만료된(`unknown`) lease만 대상으로 하고, Docker driver로 기록된 container를 fence·제거해 stop/cache 회수 receipt를 받은 뒤에만 retire한다. 살아 있는 lease는 거부한다. 그 worker를 만든 설정(imageId 등)으로 실행해야 driver의 무결성 검사를 통과한다. 생성 확인이 유실된 경우(daemon 지연 등)에는 receipt를 만들지 않는다. 운영자가 조사해 `--investigated-container <id>`를 주면, fence됐고 create가 `unknown`이며 start가 없는 record에 한해 driver가 이름·label·이미지·설정·제한·mount를 전부 검증한다. 그 뒤에만 제거·부재 확인·retire를 진행하며, 이름으로 찾아 지우지는 않는다. `serve`는 SIGINT/SIGTERM/SIGHUP에서 worker를 회수한 뒤 종료한다.

`local.mjs check-deployment <deployment.json> [oidc-verifier.json]`은 두 파일을 함께 검증한다. 브라우저 OIDC issuer/clientId와 서버 verifier issuer/audience(id_token Bearer일 때)가 다르면 실패한다. 출력은 계정 ID·host를 가린 요약과 경고(미설정, http loopback 등)라 검토 자료로 붙일 수 있다.

## DynamoDB 운영 저장소

회사 선택 저장소는 DynamoDB다. `DynamoDbCloudStore`(`apps/host/src/storage/dynamodb-store.ts`, 라이브러리 export)는 SDK 없이 `node:crypto` SigV4로 DynamoDB JSON API를 호출한다. 경계 정책의 `@aws-sdk` 거부를 유지한다.

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

`tests/contract/storage/store-conformance.ts`의 `cloudStoreConformance(name, open)`는 회사 운영 저장소 adapter가 통과해야 할 `CloudStore` 계약 테스트다. 미존재 key, 값 복사, 예외 시 무커밋, read-before-write, 동시 read-modify-write 무손실과 callback 재실행, 동시 생성 충돌, 1MiB 초과 거부(413 `record_too_large`), 재오픈 후 유지(선택)를 검사한다. 로컬 `SqliteCloudStore`는 `tests/contract/storage/store.test.ts`로 이 묶음을 통과한다. 충돌 감지가 없는 고의로 잘못된 adapter는 5개 항목에서 실패하는 것을 확인했다. 일회용 합성 DB에서만 실행하며 백업·복구·감사 불변성의 증거가 아니다.

## HTTP

기본 경로는 `/api/organizations/v1/:organizationId/workspaces/:workspaceId/aws/connections`다.

| 요청 | 동작 |
|---|---|
| GET base | 본인 연결과 서버가 허용한 구성 목록 |
| POST base | configurationId로 본인 연결 등록 |
| GET /:connectionId/status | fresh worker 상태와 필요한 Device Code 안내 |
| GET /:connectionId/observations | 디스크 캐시의 마지막 결과와 동기화 요약(worker 호출 없음) |
| GET /:connectionId/sync | 동기화 진행률. 끝난 단위를 worker에서 가져와 검증 후 디스크에 저장(호출당 최대 40개). worker가 없으면 캐시된 요약 |
| GET /:connectionId/inventory/:service | 캐시된 단위(계정·리전·서비스) 목록. `all`은 전체 서비스(worker 호출 없음) |
| GET /:connectionId/report | 동기화별 판정 기록(추이·비교용, 디스크 캐시, worker 호출 없음) |
| GET /:connectionId/views | 이 사용자의 저장된 보기(서버 저장소, 연결 설정별) |
| POST /:connectionId/views | `{operation:'save', view}`(같은 이름 덮어쓰기) 또는 `{operation:'delete', id}`. `Idempotency-Key` 필요 |
| GET /:connectionId/alerts | 이메일 알림 상태: 설정 여부, 가린 수신자, 기준, 최근 발송 결과(worker 호출 없음) |
| POST /:connectionId/alerts | `{operation:'test'}`만 받는다. 서버 설정의 수신자에게 고정 문구 테스트 메일(연결당 1분에 1회). 수신자·내용은 받지 않는다 |
| POST /:connectionId/actions | login/verify/inspect/directory/disconnect/logout/sync |

매 요청에 현재 Bearer 신원·membership·소유권을 검사한다. POST는 UUID Idempotency-Key와 strict JSON을 받는다. 웹 Host/Origin을 고정하고 Origin 없는 GET은 same-origin Fetch Metadata를 요구한다. 개인/demo cookie·forwarded-user header·body의 actor/role은 권한이 아니다.

inspect는 등록된 서비스(`alarms`·`metrics`·`ec2`·`eks`·`rds`·`elasticache`·`msk`·`lambda`·`dynamodb`·`apigateway`·`ssm`·`automation`·`patch`)만 받고 각 서비스는 worker의 고정 CLI 명령 하나로 대응한다(EKS는 버전 지원 목록과 클러스터 상세를 시간 예산 안에서 추가로 읽는다). 서비스 하나의 IAM 거부·요청 제한·시간 초과는 앞뒤 STS 확인을 통과하면 `read_*` 코드(409)로 그 조회만 실패시키고 세션을 유지한다. directory는 worker 발급 cursor만 받으며 raw parent/profile/NextToken을 받지 않는다. [directory 범위](organization-directory.md)를 따른다. 알 수 없는 개인/GCP/데모 경로는 404이고, 미설정 회사 API는 503이다.

외부 호출은 재시도 가능한 저장 transaction 밖에 둔다. 응답 유실/도중 권한 회수/만료는 unknown을 보존하고 같은 요청을 자동 재실행하지 않는다. 실제 물리 driver·회사 웹/SSO와 재시작·두 사용자 격리를 확인해야 한다. [인증 경계](../docs/architecture/identity.md) · [worker 계약](organization-cli-worker/README.md)

## 다계정·다리전 동기화

`sync`는 명시적 사용자 동작이다(첫 연결에서 캐시된 동기화가 없을 때만 화면이 한 번 자동 시작). worker가 백그라운드로 실행하는 동안 그 worker의 다른 요청은 `connection_busy`다.

- **범위(서버 설정 `inventory`):**
  - `regions`(후보 리전 목록, 없으면 계정별 활성 리전)
  - `maxAccounts`(기본 50, 최대 200)
  - `config`(`aggregator`, `accountId`, `region`. 있으면 AWS Config 집계자 모드)
  - 계정은 `directory` 범위(Root면 `list-accounts`, OU면 그 아래 OU만 너비 우선)에서 고른다. 범위가 없으면 Payer만 대상이다.
- **사용 리전:** 태그가 하나라도 있는 VPC가 있는 리전이다(`describe-vpcs`, Config 모드는 `AWS::EC2::VPC` tags). 활성 리전이어도 태그된 VPC가 없으면 읽지 않는다. Payer의 연결 기본 리전은 서버 고정이라 항상 읽는다.
- **계정별 확인:** 같은 SSO 세션에 계정별 프로필(계정마다 불변 config 파일)을 쓴다. STS로 계정·permission set(`AWSReservedSSO_<role>_`)·role session name(같은 사용자)을 앞뒤로 확인한다. 할당이 없으면 `denied`이고 읽지 않는다.
- **실패 범위:** 단위 하나(`read_*`), 계정 하나(`denied`/`failed`), 세션 수준(신원 변경·만료 → 작업과 세션 종료)으로 나뉜다.
- **캐시:** 호스트는 단위마다 `observations/<scope digest>.units/u-<key digest>.json`(0600, 디렉터리 0700)에 저장한다. 완전한 동기화가 끝나면 더 이상 생성되지 않는 키를 지운다. 끝난 작업(완료·일부 실패)은 그 작업의 단위만으로 판정해 `report.json`에 한 번 기록한다(최근 48시간 전부, 이후 하루 1개·35일). 동기화 요약의 `remaining`은 아직 가져오지 않은 단위 수다. 동기화를 시작하면 호스트가 3초 간격으로 끝난 단위를 직접 가져온다(브라우저가 떠나도 계속). 매 단계 연결·구성원·설정을 다시 확인하고, 작업이 끝나거나 worker가 없거나 권한이 회수되거나 6시간이 지나거나 호스트가 종료되면 멈춘다. worker 생성·로그인·동기화 시작은 하지 않는다. 단위는 호스트가 job의 참조(id·계정·리전·서비스·항목 수)와 범위 계정 목록에 대조한 뒤에만 저장한다.
- **수명주기 근거:** EKS `describe-cluster-versions --include-all`(종료일 포함), RDS `describe-db-major-engine-versions`, MSK `list-kafka-versions`를 동기화마다 한 번씩(해당 자원이 있을 때만) 읽어 항목에 `support`/`eos`를 붙인다.

## 이메일 알림 (notifications.email)

서버 설정(배포 JSON)에만 둔다. 브라우저에는 가린 수신자와 발송 결과만 보인다. Slack 등 다른 채널은 없다.

```json
"notifications": { "email": {
  "from": "alerts@example.invalid",
  "smtp": { "host": "smtp.example.invalid", "port": 465, "security": "tls", "username": "alerts@example.invalid", "passwordFile": "/absolute/path/smtp-password" },
  "routes": [{ "configurationId": "aws-read", "to": ["ops@example.invalid"], "minSeverity": "warning", "detail": "full", "language": "ko", "timeZone": "Asia/Seoul" }],
  "minIntervalMinutes": 0 } }
```

- **전송:** 호스트의 SMTP 클라이언트가 항상 TLS로 보낸다(`tls`=465 암묵적 TLS, `starttls`=587). 인증서 검증을 끄지 않고 평문 AUTH는 하지 않는다. 비밀번호는 `passwordFile`(호스트 사용자만 읽는 0600 파일)에서 보낼 때 읽는다. Gmail은 2단계 인증 후 만든 앱 비밀번호(공백 없이)를 쓴다. `check-deployment`가 파일 유무·권한만 확인해 보여 준다(내용은 읽지 않음).
- **보내는 때:** 동기화가 끝나 판정이 기록될 때다. 첫 기록은 '알림 시작' 메일(현재 조치·주의 항목)이고, 이후에는 이전에 알리지 않은 항목만 보낸다. 새 항목이 없으면 보내지 않는다. 조회 실패·수집 범위 제한은 항목으로 알리지 않고 본문에 개수만 적는다.
- **중복 방지:** 알린 항목 id를 사용자 캐시의 `alerts.json`에 둔다. 사라진 항목은 그 동기화가 그 위치를 볼 수 있었을 때(접근 확인, 조회 실패 없음)만 목록에서 지운다. 실패하거나 `minIntervalMinutes` 때문에 미룬 항목은 다음 동기화에 다시 보낸다.
- **내용:** `detail: full`은 수준·종류·대상·계정/리전·내용(최대 50행), `summary`는 종류별 개수만 보낸다. 링크는 `publicOrigin`의 운영 리포트다. 값은 HTML 이스케이프하고 주소는 CR/LF·표시 이름이 없는 addr-spec만 받는다.

