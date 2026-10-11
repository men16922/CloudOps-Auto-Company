# CloudOps Auto Company

조직 AWS 계정을 운영하기 위한 독립 저장소입니다. 사용자는 회사 웹 로그인 후 본인에게 허용된 Payer에 AWS IAM Identity Center Device Code로 연결하고, 사용자 전용 worker가 Organizations 범위의 계정·리전을 읽기 전용으로 수집합니다. 개인 AWS, GCP, On-Prem, Azure, Android, Firebase 구현은 포함하지 않습니다.

## 구조

| 경로 | 내용 |
|---|---|
| `apps/web/` | 브라우저 화면 (React + Cloudscape): 대시보드, 서비스별 목록, 운영 리포트, 거버넌스, 조직 계정 |
| `apps/host/` | API 서버: 웹 로그인 확인, 연결·저장소, worker 관리, 결과 캐시, 리포트 기록 |
| `apps/worker/` | 사용자별 Docker 컨테이너에서 AWS CLI로 조회하는 수집기 |
| `packages/contracts/` | 웹과 호스트가 공유하는 데이터 형식 |
| `packages/assessment/` | 화면과 호스트가 공유하는 판정 규칙 (조치·주의, EOS, 보안, 리포트 비교) |
| `packages/worker-protocol/` | 호스트↔worker 약속 |
| `tests/` | 단위(`unit/`), 저장소 계약(`contract/`), 브라우저(`browser/`), 수동 실행(`opt-in/`) |
| `scripts/` | 빌드(`build/`)와 운영 보조(`ops/`) |
| `deploy/` | 운영 문서, 배포 JSON 예시, worker Docker 레시피 |
| `docs/` | 상태·계획·설계·기록 |

의존 방향, 요청 흐름, 자주 하는 변경의 위치는 [레포 구조](docs/architecture/overview.md)에 정리했습니다. 화면이 호스트 코드를 넣거나 worker가 호스트 코드를 넣으면 빌드가 실패합니다.

## 실행과 검증

Node.js 24 이상을 씁니다(`.tools/node`가 있으면 `make`가 먼저 사용). 의존성과 Chromium은 검증 전에 준비합니다.

```sh
npm ci
npx playwright install chromium
make check             # 타입·경계 검사, 웹/API/worker 빌드, 단위·계약 테스트, 브라우저 검증
make dev               # 웹만 (127.0.0.1:5175)
npm run start:local    # 빌드된 웹+API를 같은 loopback origin(127.0.0.1:5176)에서 실행
```

`make check`는 합성 데이터만 쓰고 실제 AWS CLI·Docker·회사 로그인에 연결하지 않습니다. 실제 Docker나 DynamoDB Local이 필요한 검증은 `npm run verify:*`로 따로 실행합니다.

## 문서

- [현재 상태](docs/STATUS.md) · [다음 작업](docs/NEXT_PLAN.md) · [작업 기록](docs/PROGRESS_LOG.md)
- [레포 구조](docs/architecture/overview.md) · [인증과 사용자 격리](docs/architecture/identity.md) · [인증 흐름도](docs/architecture/auth-flow.md) · [회사 버전에 가져갈 범위](docs/company-porting.md)
- [API·로컬 호스트 구성](deploy/organization-api.md) · [웹 로그인과 대시보드](deploy/organization-web.md) · [worker 계약](deploy/organization-cli-worker/README.md)

## 범위와 한계

로컬 loopback 호스트와 개인 테스트 계정(Identity Center)으로 검증한 단계이며, 회사 IdP·운영 저장소·TLS·운영 배포는 [다음 작업](docs/NEXT_PLAN.md)에 남아 있습니다. 쓰기 작업은 서버 고정 카탈로그의 런북(요청 → 승인 → 요청자 본인 세션으로 실행)뿐이며, 개인 테스트 계정에서 읽기 전용 '연결 점검' 1건만 실행해 확인했습니다. 웹 로그인 사용자와 Device Code 승인자의 동일성 검사는 아직 없습니다([인증 흐름](docs/architecture/auth-flow.md)). 원본 분리 기록과 자산 출처는 [docs/provenance](docs/provenance/assets.md)에 있으며, 이 저장소로 새 공개 라이선스를 부여하지 않습니다.
