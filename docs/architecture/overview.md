# 레포 구조

CloudOps Auto Company는 **조직 AWS 계정 운영** 하나만 담당한다. 실행 단위는 셋(웹, 호스트, worker)이고, 둘 이상이 함께 쓰는 코드는 `packages/`에 둔다.

```
apps/
  web/       브라우저 화면 (React + Cloudscape)
  host/      API 서버: 웹 로그인 확인, 연결·저장소, worker 관리, 결과 캐시, 알림
  worker/    사용자별 Docker 컨테이너 안에서 AWS CLI로 읽기 전용 조회를 하는 수집기
packages/
  contracts/        웹과 호스트가 주고받는 데이터 형식(zod), 오류 형식, 웹 설정 형식
  assessment/       수집 결과 판정 규칙(조치·주의·참고, EOS, 보안, 리포트 비교) — 화면과 호스트가 같은 규칙을 쓴다
  worker-protocol/  호스트↔worker 약속: 바인딩·CLI 인자, 명령 형식, lease 식별자, 제한된 서브프로세스 실행
tests/
  unit/{web,assessment,host,worker}   단위 테스트 (node:test)
  contract/storage                    저장소 adapter 계약 테스트
  browser/                            빌드 산출물 브라우저 검증 (Playwright + axe, 합성 데이터)
  opt-in/                             실제 Docker/DynamoDB Local이 필요한 검증 (make check 밖)
scripts/
  build/   빌드 스크립트와 경계 정책
  ops/     운영자 보조 스크립트 (Identity Center 테스트 설정)
deploy/    운영 문서, 배포 JSON 예시, worker Docker 레시피
docs/      상태·계획·기록 (아래 "문서" 참고)
```

## 의존 방향

```
apps/web ──► packages/contracts, packages/assessment
apps/host ─► packages/contracts, packages/assessment, packages/worker-protocol
apps/worker► packages/contracts, packages/worker-protocol
packages/assessment ─► packages/contracts
packages/worker-protocol ─► packages/contracts
```

- 앱끼리는 서로 import하지 않는다. 화면은 호스트·worker 코드를 포함할 수 없고, worker는 호스트 코드를 포함할 수 없다.
- 각 빌드가 실제로 포함한 파일을 `scripts/build/company-build-policy.mjs`의 `artifactSources`와 대조해 어기면 빌드가 실패한다. 다른 provider·개인 AWS·Firebase/Google SDK·`.data`·`.env`도 같은 정책이 거부한다.

## 요청 흐름

1. **웹 로그인:** 브라우저 → `apps/host/src/identity/` (IAM Identity Center SAML 또는 OIDC) → 호스트가 발급한 웹 신원. AWS Device Code token은 웹 신원이 아니다.
2. **AWS 연결:** 브라우저가 Payer를 고르고 로그인을 누르면 `apps/host/src/connections/connections.ts`가 요청을 기록하고, `apps/host/src/workers/supervisor.ts`가 사용자 전용 worker 컨테이너(`workers/docker/`)를 띄운다. worker(`apps/worker/src/cli-worker.ts`)가 AWS CLI Device Code 로그인을 하고 사용자가 브라우저에서 승인한다.
3. **동기화:** worker가 Organizations 범위의 계정과 태그된 VPC가 있는 리전을 읽고(`apps/worker/src/sync.ts`), 호스트가 끝난 결과를 검증해 사용자별 디스크 캐시(`connections/observation-cache.ts`)에 저장한다. 브라우저가 떠나도 호스트가 끝까지 가져온다.
4. **판정·리포트:** 화면과 호스트가 `packages/assessment`의 같은 규칙으로 판정한다. 동기화가 끝날 때마다 호스트가 판정을 기록하고(`connections/report-snapshots.ts`) 새 항목을 메일로 알린다(`notifications/`).

## 빌드 산출물 (`make check`가 만든다, Git 제외)

| 산출물 | 입력 | 용도 |
|---|---|---|
| `dist-company/` | `apps/web` (Vite, root `apps/web`) | 브라우저 화면 |
| `dist-company-api/organization.mjs` | `apps/host/src/index.ts` | 회사 구성 코드가 주입해 쓰는 API 라이브러리 |
| `dist-company-api/local.mjs` | `apps/host/src/local-main.ts` | loopback 전용 호스트 CLI (`serve`, `check-deployment`, `provision-membership` …) |
| `dist-worker/worker.mjs` | `apps/worker/src/worker-main.ts` | Docker worker 이미지에 들어가는 수집기 |

각 산출물 옆의 `module-inputs.json`은 실제로 포함된 소스 목록이다.

## 자주 하는 변경

| 하고 싶은 일 | 고칠 곳 |
|---|---|
| AWS 조회 추가 | `packages/worker-protocol/cli-contract.ts`(고정 CLI 인자) → `apps/worker/src/cli-worker.ts`·`sync.ts`(파싱) → `packages/contracts/aws/connections.ts`(형식) → `packages/assessment/`(판정) → `apps/web/src/dashboard/`(화면) |
| 판정 규칙·임계값 | `packages/assessment/operations-assessment.ts`, EOS는 `eos-rules.ts` |
| 화면·문구 | `apps/web/src/dashboard/`, 언어 전환은 `apps/web/src/i18n.tsx` |
| HTTP 경로 | `apps/host/src/api/routes.ts`, 서비스 로직은 `connections/connections.ts` |
| 배포 설정 항목 | `apps/host/src/api/deployment.ts` (스키마), 예시 `deploy/organization-web.example.json` |
| 저장소 adapter | `apps/host/src/storage/` + `tests/contract/storage/store-conformance.ts` |

## 로컬 데이터

`.data/`(Git 제외)에 로컬 배포 JSON, SQLite 저장소, 사용자별 결과 캐시(`observations/`), Docker worker 설정, SMTP 비밀번호 파일을 둔다. 실제 계정 관측과 설정은 Git·브라우저 저장소·로그에 넣지 않는다.

## 문서

- 상태와 다음 일: `docs/AGENT_BRIEF.md` → `docs/STATUS.md` → `docs/NEXT_PLAN.md`, 작업 기록 `docs/PROGRESS_LOG.md`, 함정 `docs/LESSONS.md`
- 설계: 이 문서, 인증·격리 `docs/architecture/identity.md`
- 계획: `docs/plans/` (끝난 계획은 `docs/plans/archive/`)
- 지난 검증 기록: `docs/history/verification.md`
- 원본 분리 출처: `docs/provenance/` (원본 repo 기준 해시라 현재 파일과 다를 수 있다)
- 운영: `deploy/` (API·웹 인증·Root/OU·Identity Center 테스트 설정·worker 계약)
