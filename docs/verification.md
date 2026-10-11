# 회사용 저장소 분리 검증

검증일: 2026-10-10. 아래 명령은 CloudOps-Auto-Company에서 별도 의존성으로 실행했다.

- 독립 로컬 Git: main, 커밋 0개, remote 없음. 원본 .git이나 remote를 복사하지 않았다.
- 정확 lock 144개 중 현재 플랫폼 76개를 `npm ci --offline --ignore-scripts --no-audit --no-fund`로 설치했다. `npm ls --all --offline` 통과. 새 버전을 탐색하거나 lifecycle script를 실행하지 않았다.
- **make check 종료 0**: 타입·runtime/type-only 소스 경계, 웹/API/private CLI worker 빌드, **서버 122/122**, 회사 산출물/API/browser smoke, 조직 웹 계약 검증 통과.
- 서버 검증은 조직 신원/membership·연결 소유권·동시성/재시작·Device Code parser·고정 CLI·STS·directory/cursor·lease·supervisor·Docker driver의 주입 transport와 실제 로컬 Node 자식 프로세스를 포함한다. 실제 Docker나 AWS CLI는 호출하지 않았다.
- 브라우저는 한영/새로고침·390px 메뉴, 합성 로그인/본인 연결/Device Code/제한된 조회, directory 페이지/OU/만료/부분 거절, 사용자 전환·권한 회수·로그아웃을 검증했다. 기본 회사 API 미설정과 개인/trial/demo 경로 제외도 확인했다.
- 분리한 9개 서버 테스트 파일에서 Firebase adapter 전용 테스트 2개는 해당 구현과 함께 제외했다. 조직 API fixture는 회사 WebIdentityVerifier의 합성 port로 바꿨고 나머지 만료/권한/연결 검증은 유지했다. 실제 회사 서명 검증으로 표현하지 않는다.
- 유효한 GCP type-only import가 TypeScript를 통과해도 경계 검사는 거부했다. runtime GCP import도 Vite 경계에서 실패했다. 임시 파일을 제거하고 원래 entry 바이트를 복원했다.
- 의존성 symlink 10개는 모두 새 repo node_modules 내부다. Firebase/Admin, Google auth/Firestore, AWS SSO SDK 두 패키지의 resolution이 모두 실패해 제외를 확인했다. 원본 소스/의존성으로 향하는 link·절대 경로 의존성이 없다.
- 최초 추출 manifest 71개 파일 해시 일치, 현재 Git 대상 파일 81개. 실제 개인 AWS 식별자와 일치하는 문자열 0건, 로컬 문서 링크 26개 모두 유효. 실제 데이터/.env/.data·개인 프로필은 옮기지 않았다.
- 원본 private auditor가 2026-10-10T10:06:25.965Z에 기존 계획 2·실행 2·근거 5·수집 3과 설정 보존을 확인했다. 기존 Node 24 도구만 새 repo의 ignored .tools에 복사했고 별도 인프라/전역 설정을 바꾸지 않았다.

로그: `/tmp/cloudops-company-repository-check.log`, `/tmp/cloudops-company-repository-install.log`, `/tmp/cloudops-company-repository-dependencies.log`. 브라우저 캡처는 이 repo의 Git 제외 test-results/screenshots에 합성 데이터만 저장했다.

실제 회사 IdP/SSO·물리 home/cache/worker 격리·운영 저장소·Docker 이미지·TLS·회사 배포는 미검증이다. commit/push·GitHub 생성·공개·IAM/자원 변경은 수행하지 않았다. 이 결과는 독립 로컬 저장소 분리 완료의 근거다.

## 2026-10-10 추가: 구성·OIDC verifier·loopback host

- **make check 종료 0**, 서버 **132/132**(신규 10). 시스템 Homebrew node가 libsimdutf 누락으로 실행되지 않아 Makefile의 repo `.tools/node`(v24.19.0)를 사용했다.
- `oidc-web-identity.test.ts`: 로컬 생성 RSA/EC 합성 키로 RS256/PS256/ES256, alg none·HS256·키 타입 혼동, issuer/audience/azp, exp/iat/nbf/수명, crit/typ, 약한 RSA·변조 서명, tenant allow-list, revocation hook(true/예외), 원격 JWKS 캐시·회전·1분 간격·장애 시 이전 키 유지·크기 제한·미지원 키 skip, 설정 검증.
- `organization-deployment.test.ts`: 예시 JSON 검증과 http/경로 origin·firebase 방식·scope 불일치·중복·미설정+연결·알 수 없는 key 거부, verifier 없는 fail-closed 503, OIDC composition의 인증·membership 없는 403·잘못된 audience 401·외부 Origin 403·연결 생성·provisioner 없는 worker_unavailable·membership 회수 재검사, loopback host의 정적 경로 격리(symlink·상위 경로)·비loopback bind와 origin 불일치 거부.
- `check-company.mjs`: 빌드된 `dist-company-api/local.mjs`를 임시 디렉터리 설정으로 실행해 actor 계산·membership bootstrap·OIDC Bearer 연결 목록·CSP 아래 웹 로드(page error/CSP 위반 0)를 확인했다.
- 실제 IdP·JWKS endpoint·AWS CLI·Docker는 호출하지 않았고 repo `.data`도 생성하지 않았다. 회사 IdP 연동 검증이 아니다.

## 2026-10-10 추가: 브라우저 OIDC·점검 명령·저장소 적합성·Docker 연결

- **make check 종료 0**, 서버 **154/154**.
- `oidc-web-client.test.ts`(4): PKCE S256·state/nonce, 다른 탭 callback 무시, issuer/audience/nonce/만료·IdP 오류·token endpoint 실패, popup 차단·timeout·이전 시도 취소, 만료 시 신원 해제, end-session, access_token 수명.
- `cloud-store.test.ts`(16): SQLite file/memory가 `cloudStoreConformance` 8항목 통과. 충돌 감지·read-before-write·값 복사·크기 제한이 없는 임시 결함 adapter는 5항목 실패(scratch 파일, 삭제함).
- `organization-deployment.test.ts` 추가: 브라우저/서버 OIDC 짝 불일치 거부, 마스킹 요약에 계정 ID·host 미포함, Docker driver가 오프라인에서 enable 플래그가 있어도 시작 거부.
- `check-company.mjs`: 합성 IdP(즉시 동의, PKCE 검사 token endpoint, 앱 Origin CORS)와 빌드된 local host로 실제 Chromium popup 로그인 → 신원 표시 → 연결 추가 → 로그아웃. IdP 호출 `GET /authorize`, `POST /token` 각 1회, local/sessionStorage에 JWT·verifier·code 없음, CSP 위반·page error 0.
- 실제 IdP·AWS CLI·Docker는 호출하지 않았다. worker 격리 절차는 문서만 작성했고 실행하지 않았다.

## 2026-10-10 추가: 사용자 승인 로컬 Docker 검증·DynamoDB adapter

- 사용자 승인: 이 Mac에서 Docker 이미지 빌드·컨테이너 실행. 계정 전역 설정·AWS 리소스 변경은 하지 않았다.
- **make check 종료 0**, 서버 **167/167**(DynamoDB adapter 13 포함: SigV4가 AWS 문서 예시 `5d672d79…`·botocore DynamoDB/인코딩 벡터와 일치, fake 적합성, 응답 유실 시 같은 token 재전송 1회 반영, 5xx 3회 시 503, 단일 읽기 커밋 생략).
- worker 이미지 `cloudops-organization-cli:local` 빌드 성공(AWS CLI 2.30.1, Node 24.19.0). `npm run verify:worker-isolation`: internal 네트워크에서 합성 사용자 2명 **30/30**(2회 연속). 남은 container 0, 임시 metadata 삭제.
- `npm run verify:dynamodb-local`: `amazon/dynamodb-local@sha256:d89f8fcc…`(loopback, 더미 자격)에서 적합성 8항목과 membership·연결 registry 흐름 **9/9**.
- 개인 계정 읽기 전용 확인(STS·Organizations describe·sso-admin list-instances): management account, Identity Center instance 없음. 출력의 계정 식별자는 기록하지 않았다.
- 미실행: 실제 Identity Center Device Code 로그인, 실제 AWS DynamoDB 테이블, 생성 중 장애 주입, 회사 호스트.

## 2026-10-10 추가: 실제 DynamoDB·Identity Center SAML bridge

- 승인을 받아 개인 계정 us-east-1에 임시 provisioned 5/5 테이블(`cloudops-conformance-<uuid>`)을 만들었다. 기존 테이블은 모두 on-demand라 provisioned 무료 용량은 비어 있었다. `tests/opt-in/dynamodb-aws.conformance.ts` **9/9** 통과 후 삭제했고, 남은 테이블이 없음을 확인했다. 자격은 q-user를 검증 프로세스 환경 변수로만 전달했다.
- 의존성 추가(사용자 결정): `@node-saml/node-saml` 5.1.0(+20 패키지, `npm audit` 0), dev `xml-crypto` 6.3.3. API 번들에 `createRequire` banner를 추가했다(CJS의 Node 내장 require).
- **make check 종료 0**, 서버 **171/171**(SAML bridge 4 포함). check-company에 합성 SAML IdP(로컬 openssl 인증서, 자동 POST) + 빌드 산출물 local host Chromium e2e 추가: popup 로그인 → 신원 → 연결 목록 → 로그아웃, 저장소에 token/SAMLResponse 없음, CSP 위반 0.
- Identity Center: `sso-admin create-instance`는 management account에서 거부되므로 콘솔 활성화가 필요하다. Chrome 자동화로 '활성화' 클릭을 시도했으나 권한 분류기가 거부해 누르지 않았다. 확인 시점에 instance는 0개였다.
- 추가: local host 선택형 TLS 테스트(openssl 자체 서명 P-256, publicOrigin scheme 불일치 거부)로 **make check 172/172**. `scripts/identity-center-test-setup.sh`는 `bash -n`만 확인했고 실행하지 않았다.

## 2026-10-10 추가: 개인 테스트 계정 Identity Center 실구성

- 사용자 승인(권한 규칙 `.claude/settings.local.json` 추가 후 Chrome 조작): us-east-1 **단일 리전 organization instance**를 AWS 소유 키로 활성화했다. 추가 리전과 고객 관리형 KMS 키는 쓰지 않아 무료다.
- `scripts/identity-center-test-setup.sh` 실행: 테스트 사용자, `CloudOpsReadOnly`(ReadOnlyAccess) permission set, 계정 할당(SUCCEEDED). 비밀번호 재설정 메일을 사용자 본인 주소로 발송했고, 비밀번호와 MFA는 사용자가 직접 설정한다(에이전트는 비밀번호를 입력·보관하지 않음).
- Customer managed SAML 2.0 앱 "CloudOps Auto (local test)": ACS `http://127.0.0.1:5176/api/organizations/saml/acs`(Identity Center가 http loopback을 수락함), audience `urn:cloudops-auto:local-test`, Subject `${user:email}`(emailAddress), 사용자 할당, 상태 활성.
- `.data/`(Git 제외)에 공개 SAML 메타데이터의 인증서·배포 JSON·membership·Docker 설정을 두었다. `check-deployment` 통과. local host가 `identity-center-saml`과 Docker provisioner(외부 통신 가능 테스트 네트워크)로 기동했고, `/saml/authorize`가 실제 Identity Center sign-in URL로 AuthnRequest를 리다이렉트함을 확인했다.
- 대기: 사용자 비밀번호·MFA 설정 후 실제 SAML 웹 로그인과 Device Code 로그인·STS·조회.

## 2026-10-10 추가: 실제 Identity Center SAML 웹 로그인 + Device Code end-to-end (개인 테스트 계정)

- **SAML 웹 로그인 성공**: local host(http://127.0.0.1:5176)에서 popup → 실제 Identity Center 로그인(사용자가 비밀번호·MFA 직접 입력) → bridge ACS 검증 → token 교환 → 신원 표시·membership 확인 후 연결 목록 200. 재로그인 시 Identity Center 세션으로 자동 완료.
- **Device Code 실로그인에서 결함 발견·수정**: AWS CLI 2.30(이미지 내 2.30.0)의 Identity Center 출력은 `<start>/#/device`(fragment)였다. parser·서버·브라우저 검증이 fragment를 모두 거부해 `연결 실패`가 났다. 정확히 `#/device`인 포털 형식만 허용하도록 세 곳을 수정했고(그 밖의 fragment는 계속 거부), 실제 출력 형식 회귀 테스트를 추가했다. worker 이미지를 다시 빌드했다.
- 수정 후 **실제 흐름 통과**: 연결 추가 → Docker worker 생성(명시적 login에서만) → 코드 표시 → 사용자가 AWS 페이지에서 승인 → `접근 확인`(STS 계정·역할 검증) → Lambda 첫 페이지 조회 성공(실제 자원 이름은 기록하지 않음) → AWS 로그아웃 → `미연결`, 조회 결과 제거.
- 실제 worker 점검: UID 10001, read-only root, CapDrop ALL, log-driver none(`docker logs` 불가), 호스트 `.aws` 없음, SSO cache는 tmpfs(0700/10001). 로그아웃 후 access token·역할 자격 cache는 제거됐다. OIDC 클라이언트 등록 파일과 CLI `session.db`는 남았지만 자격 증명이 아니고, container 회수 시 tmpfs와 함께 사라진다.
- **종료/회수**: 첫 재기동 때 래퍼 셸에 신호가 가서 node가 고아 프로세스로 남아 lease를 계속 갱신했다(유실 아님). 새로 만든 `local.mjs reconcile-worker`는 살아 있는 lease를 실제로 거부했다. node에 직접 SIGTERM을 보내자 2초 안에 worker 제거, lease `retired(shutdown)`, Docker 기록 `retired`. 2세대에서도 동일하게 재현했다. `serve`에 SIGHUP 처리를 추가했다.
- **make check 종료 0**, 서버 **173/173**.
- 장애 주입(절차 8): `scripts/verify-worker-recovery.mjs`가 실제 Docker·빌드 산출물 host·합성 OIDC·internal 네트워크로 **8/8**을 통과했다. SIGKILL 후 worker는 남지만 재시작해도 503이고, 살아 있는 lease는 reconcile이 거부한다. 65초 만료 후에도 재배정이 없고, reconcile 뒤에만 2세대가 배정되며, 정상 종료하면 회수된다. 남은 container 0. daemon 지연과 생성 도중 종료는 합성 테스트로만 확인했다.
- daemon 지연 주입: `scripts/verify-worker-daemon-delay.mjs`(실제 Docker, CLI wrapper가 create를 client 포기 뒤 40초에 daemon에 전달) **5/5**. 21초에 503으로 실패했고, 늦은 container는 created 상태로만 남았다(시작·연결 없음). 재시도 없음, reconcile 거부. 테스트 정리 단계에서 수동 제거했다. 운영자가 조사 결과를 반영해 retire하는 도구 경로가 없다는 점이 새로 드러났다.
- DynamoDB store local host: `verify:dynamodb-local`가 DynamoDB Local에서 적합성 9/9와 함께, 빌드된 local host를 `CLOUDOPS_DYNAMODB_STORE`로 기동해 membership bootstrap·OIDC 인증·연결 생성 200·재조회 1건을 확인했다.
- 운영자 회수 경로: `DockerOrganizationWorkerProvisioner.adoptInvestigatedContainer`와 `reconcile-worker --investigated-container`를 추가했다. 합성 driver 테스트에서 fence 전·부재 ID·다른 allocation·retire 후 재시도를 거부하고, 정상 경로에서는 제거·retire·lease 회수를 확인했다. 실제 Docker daemon 지연 시나리오는 **7/7**(잘못된 ID 거부, 조사한 늦은 container 제거·retire, 잔여 0).

## 2026-10-11 추가: Payer 대시보드·원클릭 Device Code (개인 테스트 계정 실검증)

- 원본 CloudOps-Automation 조사: Payer 대시보드와 SelectBox는 demo(합성)에만 있었고, 회사 edition에는 Payer 선택이 없었다. 코드 자동 입력 URL은 브라우저 SSO 경로에서만 썼다. demo 레이아웃을 참고해 회사 edition에 실제 데이터 기반으로 구현했다.
- 실제 흐름: Identity Center SAML 웹 로그인 → Payer 미리 선택 → 'AWS Device Code 로그인' 한 번 → 새 창이 코드가 입력된 AWS 페이지로 열림 → 사용자 허용 → '접근 확인' → 조직 계정 탭 자동 로드(Root 직접 하위 계정 1·ACTIVE 1·OU 0, `ListAccountsForParent` 출처·시각 표시). 실제 계정명은 기록하지 않는다.
- 발견·수정한 결함: 같은 configurationId의 설정이 바뀌면(directory 범위 추가) 이전 연결의 digest 불일치로 `create`가 404가 되어 새 연결을 만들 수 없었다. 이전 연결을 비활성화하고 index에서 제거한 뒤 새 연결을 등록하도록 고쳤다(회귀 테스트 추가). 요청 중 탭이 다시 마운트돼 결과가 사라지던 UI 문제와, 모바일 Tabs 스크롤 버튼의 이름 누락(axe)도 고쳤다.
- **make check 종료 0**, 서버 **175/175**. 조직 웹 계약은 Payer 선택, 원클릭 팝업이 코드 URL로 이동하고 opener가 null인 것, 디렉터리 자동 로드, 탭, 접근성을 검증한다. 테스트의 AWS 도메인 요청은 합성 응답으로 가로챈다.
- 남은 관찰: 서버 재시작 직후 첫 웹 로그인 클릭이 완료되지 않고 두 번째 클릭에서 완료되는 현상이 반복됐다(원인 미조사).

## 2026-10-11 추가: 운영 대시보드·좌측 메뉴·조회 캐시 (개인 테스트 계정 실검증)

- 실제 흐름: Identity Center SAML 웹 로그인 → 상단 조직 프로필에서 'AWS Device Code 로그인' → 코드가 입력된 AWS 페이지에서 사용자 허용 → '접근 확인' → directory·경보·Lambda·EC2·DynamoDB 자동 조회 → 요약 카드·조치/주의 항목·차트 위젯 표시 → 좌측 메뉴로 Lambda·EC2 상세 화면 확인. 실제 자원 이름과 개수는 기록하지 않는다.
- EC2 조회는 처음에 `cli_failed`였다(AWS CLI가 `--no-paginate`와 `--max-items`를 함께 거부). `--cli-input-json '{"MaxResults":100}'`로 바꾼 뒤 실제 조회가 성공했다.
- 호스트 재시작 후 AWS 로그인 전에도 로컬 디스크 캐시의 마지막 결과가 '캐시된 관측'으로 먼저 보이는 것을 확인했다. 캐시 파일은 0600, 디렉터리는 0700이고 사용자·연결별로 분리된다(서버 테스트). 연결된 상태로 새로 로그인하면 자동 새로고침이 캐시 로드를 막던 순서 결함을 발견해 고쳤다(`organization-web-client.test.ts` 회귀 테스트는 수정 전 순서에서 실패한다).
- 차트 색(ALARM 빨강·데이터 없음/중지 회색·OK/실행 초록·기타 파랑)은 dataviz 검증 스크립트로 확인했다. 색각 이상·정상 시각 구분은 통과했다. 회색은 채도 하한과 대비 경고가 있어 항상 범례·라벨·상세 표와 함께 쓴다.
- **make check 종료 0**, 서버 **180/180**. 조직 웹 계약은 상단 프로필 팝업, Payer 선택, 원클릭 팝업 URL과 opener null, 파생 조치 항목과 콘솔 링크, 위젯, 좌측 메뉴 상세 화면 이동, 디렉터리 탐색, 모바일 접근성(axe)을 검증한다.

## 2026-10-11 추가: EC2·EKS·RDS·ElastiCache·MSK·CloudWatch 표준 지표 (개인 테스트 계정 실검증)

- 워커 이미지를 다시 빌드하고(로컬 Docker, 기존 승인 범위) 호스트를 정상 종료(SIGTERM, worker 회수 확인) 후 재기동했다. 사용자가 Device Code를 승인한 뒤 자동 전체 조회가 directory·경보·표준 지표·EC2·EKS·RDS·ElastiCache·MSK·Lambda·DynamoDB 모두 오류 없이 끝났다. 이 계정에는 EKS/RDS/ElastiCache/MSK 자원이 없어 빈 상태로 표시됐다(값은 기록하지 않음).
- 표준 지표 `get-metric-data`(고정 SEARCH 9개, `{AWS/Kafka,"Broker ID","Cluster Name"}` 포함)는 실제 계정에서 권한·구문 오류 없이 성공했다. 다만 지난 1시간 데이터 포인트가 없어, 데이터가 있을 때 동적 라벨(`${PROP('Dim.…')}`)이 자원 ID로 해석되는지는 이번에 관측하지 못했다. API 문서(MetricDataQuery.Label, 동적 라벨은 SEARCH 결과 각각에 적용)에 근거하며, 해석되지 않으면 `read_invalid_result`로 실패하도록 해 '데이터 없음'으로 오인되지 않게 했다. 부하가 있는 계정(회사 계정 포함)에서 확인이 남았다.
- 성능 제약: 워커는 `--cpus=0.25`이고 CLI 실행 1회가 약 2초다. supervisor는 25초를 넘는 작업의 워커를 폐기하므로, 표준 지표는 호출 한 번으로 묶고 EKS 클러스터 상세는 12초 예산 안에서만 읽는다(나머지는 '상세 미수집'). 읽기 프로세스 제한 시간은 30초→20초로 줄였다.
- **make check 종료 0**, 서버 **189/189**. 새 테스트: 고정 인자·EKS 이름/지표 입력 검증, 서비스 단위 거부 시 세션 유지와 신원 변경 시 무효화, EKS 지원 상태 병합·시간 예산, 지표 최악 10개·노드→클러스터 병합·라벨 실패 시 닫힘, EKS/RDS/ElastiCache/MSK/지표 판정. 조직 웹 계약은 좌측 메뉴(Serverless 하나, Lambda 단독 메뉴 없음)·EKS/RDS/지표 상세·MSK 권한 없음 표시와 모바일 접근성을 검증한다.

