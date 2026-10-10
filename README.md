# CloudOps Auto Company

조직용 AWS 계정 상태와 사용자별 운영 연결을 위한 독립 저장소입니다. 원본 CloudOps-Automation의 회사용 모듈을 분리했습니다. 개인 AWS, GCP, On-Prem, Azure, Android와 Firebase 구현은 포함하지 않습니다.

## 로컬 실행

Node.js 24 이상을 사용합니다. Chromium은 검증 전에 준비합니다.

```sh
npm ci
npx playwright install chromium
make check
make dev               # 웹만(loopback 5175)
npm run start:local    # 빌드된 웹+API를 같은 loopback origin(5176)에서 실행
```

웹은 `http://127.0.0.1:5175/`에서 열립니다. 회사 인증 adapter가 설정되지 않아 처음에는 미연결 상태입니다. **합성 계정 예시 보기**로 화면을 확인할 수 있으며 실제 AWS 호출은 하지 않습니다. 개발/preview 서버에는 원본 개인 AWS 서버를 향하는 API proxy가 없습니다.

`make check`는 독립 타입·경계 검사, 웹/API/CLI worker 빌드, 서버 테스트, 회사 웹/API smoke와 조직 연결 화면의 합성 검증입니다. 의존성을 설치하거나 실제 AWS/Docker/회사 로그인에 연결하지 않습니다.

## 포함한 기능

- 조직 계정 상태 대시보드와 한국어/영어 전환. 미수집·접근 확인·계정 State를 구분합니다.
- 본인 연결 목록, Device Code 안내, STS 확인, Lambda/DynamoDB/CloudWatch 경보의 제한된 조회.
- 서버 지정 Organizations Root/OU의 직접 자식 페이지·다음 페이지·하위 OU 탐색.
- 사용자별 CLI worker 계약, 전용 프로필/홈/캐시, 지속 connection/lease, supervisor와 private pipe.
- 선택형 Docker driver와 container recipe. 실제 Docker/물리 격리는 미검증입니다.
- 배포 JSON 검증·composition·점검 명령, 표준 OIDC 서버 verifier와 브라우저 popup PKCE client 후보, loopback 전용 host와 membership bootstrap, 운영 저장소 적합성 테스트와 SDK 없는 DynamoDB adapter, worker 격리 검증 스크립트(로컬 Docker 30/30). 실제 회사 IdP·Identity Center 로그인·AWS DynamoDB 테이블은 미검증입니다.

전체 조직 자동 수집, 회사 웹 로그인, 실제 회사 SSO, 운영 환경 배포가 완료된 제품으로 표현하지 않습니다. 개인 CLI 시험과 합성 테스트는 회사 통합의 증거가 아닙니다.

## 코드와 산출물

| 경로 | 역할 |
|---|---|
| `src/company-main.tsx` | 조직 AWS 웹 진입점 |
| `src/modules/aws/organization/` | 계정 상태·연결 화면과 client |
| `server/modules/aws/organization/` | API·연결 registry·CLI worker·supervisor/driver |
| `server/cloud-auth.ts`, `cloud-store.ts` | 회사 웹 신원·membership·저장 port |
| `dist-company/` | 빌드된 웹 |
| `server/oidc-web-identity.ts` | 표준 OIDC/JWT 서버 verifier 후보 |
| `src/platform/oidc-web-identity-client.ts`, `public/oidc-callback.*` | 브라우저 OIDC popup PKCE client 후보와 callback |
| `server/cloud-store-conformance.ts` | 운영 저장소 adapter용 `CloudStore` 적합성 테스트 |
| `server/cloud-dynamodb-store.ts` | SigV4 직접 서명 DynamoDB `CloudStore` adapter |
| `scripts/verify-worker-isolation.mjs`, `scripts/verify-dynamodb-local.mjs` | opt-in Docker 검증(worker 격리, DynamoDB Local). `make check`에 포함하지 않음 |
| `server/organization-local-host.ts` | loopback 전용 웹+API host와 membership bootstrap |
| `dist-company-api/organization.mjs` | 주입 가능한 API/server factory·composition |
| `dist-company-api/local.mjs` | 로컬 loopback host CLI(`serve`/`actor`/`provision-membership`/`check-deployment`) |
| `dist-worker/worker.mjs` | 격리된 환경에서 실행할 private CLI worker |

현재 API는 회사 구성 코드가 identity/store/provisioner를 주입하는 라이브러리입니다. `composeOrganizationApi`가 검증된 배포 JSON으로 구성을 묶고, 표준 OIDC 서버 verifier 후보(`OidcJwtVerifier`)가 있습니다. 외부에 공개하는 운영 server entry는 없고, `npm run start:local`은 같은 Origin 확인용 loopback host입니다(TLS·운영 저장소·worker provisioner 없음). [회사 구성](deploy/organization-api.md), [웹 인증](deploy/organization-web.md), [SSO·사용자 격리](Identity.md), [worker 배포 계약](deploy/organization-cli-worker/README.md)을 확인하세요.

## 분리 기록과 다음 단계

[현재 상태](docs/STATUS.md)와 [검증 결과](docs/verification.md)가 이 저장소의 기준입니다. [source-manifest.json](source-manifest.json)은 원본 base commit·mixed worktree·추출 파일/의존성 해시와 테스트 변경을 기록합니다. `company-manifest.json`은 추가 문서/테스트를 넣기 전 원본 회사 후보의 기록입니다. 공통 계약의 provider 식별자는 남아 있지만 다른 provider 구현/SDK는 제외됩니다.

회사 인증과 운영 설정·저장소·worker provisioning·TLS를 구성하고 실제 환경을 확인하는 일은 [후속 계획](docs/NEXT_PLAN.md)에 남겨 두었습니다. 포털 URL만 바꿔도 권한이 생기는 것은 아니며, 웹 인증과 AWS 계정/역할 할당도 필요합니다.

원본 Git 이력은 원본 저장소에 보존됩니다. 이곳은 별도의 로컬 Git 저장소이며 commit/push·원격 생성·회사 배포는 분리 작업에 포함하지 않습니다. AWS 이미지와 npm 의존성의 출처/라이선스는 [자산 출처](reference/assets.md)를 따릅니다. 이번 분리로 새 공개 라이선스를 부여하지 않습니다.
