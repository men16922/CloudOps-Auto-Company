# Worker 격리 실검증 절차

2026-10-10 작성. 로컬 Docker Desktop에서 아래 '로컬 실행 결과'의 자동 항목을 실행했다. 1·5번은 개인 테스트 계정 실로그인으로, 8번은 SIGKILL 복구 스크립트로 실행했다. Docker 실행·이미지 빌드·회사 테스트 tenant 사용이 승인된 환경에서 운영자가 수행할 절차와 남길 근거다. `make check`는 이 절차를 실행하지 않는다. 결과는 합성 사용자/테스트 계정으로만 남기고 실제 계정 ID·token·user code를 보고서에 넣지 않는다.

## 준비

| 항목 | 조건 |
|---|---|
| 승인 | Docker daemon 사용·이미지 빌드·테스트 Identity Center 할당에 대한 회사 승인 |
| IdP | 테스트 OIDC client(브라우저 `oidc`)와 서버 verifier 설정. `local.mjs check-deployment`로 짝을 확인 |
| AWS | 읽기 전용 역할이 할당된 테스트 사용자 A/B. 서로 다른 AWS 계정 또는 역할이면 교차 노출을 더 쉽게 판별한다 |
| 호스트 | Linux, swap/디스크 정책 확인, 전용 metadata root(부모 존재, supervisor 사용자 소유, 0700) |

```sh
docker build -f deploy/organization-cli-worker/Dockerfile -t cloudops-organization-cli:local .
docker image inspect --format '{{.Id}}' cloudops-organization-cli:local   # imageId
docker info --format '{{.ID}}'                                            # daemonId
docker network create --internal cloudops-workers-test                    # 예시. egress 정책은 회사 네트워크 기준으로 별도 구성
```

`docker-worker.json`은 `dockerWorkerConfigSchema`(executable/socketPath/metadataRoot/daemonId/imageId/network)만 받는다. 이 파일과 배포/verifier JSON은 Git 밖에 둔다.

## 실행

```sh
npm run build
export CLOUDOPS_DEPLOYMENT=/secure/deployment.json CLOUDOPS_WEB_IDENTITY=/secure/oidc-verifier.json
export CLOUDOPS_LOCAL_STORE=/secure/isolation.sqlite CLOUDOPS_DOCKER_WORKER_CONFIG=/secure/docker-worker.json
export CLOUDOPS_ORGANIZATION_DOCKER_ENABLED=1
node dist-company-api/local.mjs check-deployment "$CLOUDOPS_DEPLOYMENT" "$CLOUDOPS_WEB_IDENTITY"
node dist-company-api/local.mjs actor --issuer <issuer> --subject <A의 sub>   # B도 같은 방식, membership JSON 작성 후
node dist-company-api/local.mjs provision-membership /secure/membership-a.json
node dist-company-api/local.mjs serve    # 시작 로그에 worker provisioner: docker
```

브라우저 프로필 두 개(A/B)로 `http://127.0.0.1:5176`을 연다. local host는 loopback 검증용이며 운영 server가 아니다.

## 검증 항목과 근거

| # | 절차 | 통과 기준 | 근거 |
|---|---|---|---|
| 1 | A/B 각각 연결 추가 → AWS Device Code 로그인 → 기존 세션 확인 | 각자 할당된 계정/역할만 STS로 확인 | 화면 캡처(계정 마스킹) |
| 2 | `docker inspect`로 두 container 비교 | User `10001:10001`, ReadonlyRootfs, CapDrop ALL, no-new-privileges, tmpfs 2개, bind 2개(read-only), 공유 volume 없음, label의 binding/lease/generation이 서로 다름 | inspect 결과(ID/label 해시만) |
| 3 | A container에서 B의 cache 경로 접근 시도(`docker exec`는 승인 범위에서만) | B의 `/home/cloudops-worker/.aws` 접근 불가, host `.aws` 미마운트 | 명령과 오류 출력 |
| 4 | A 조회 응답이 B 화면/로그에 나타나지 않음, stdout이 container log에 없음(`log-driver=none`) | 교차 노출 0 | 캡처, `docker logs` 결과 |
| 5 | A AWS 로그아웃 → B는 계속 동작, A는 재로그인 필요 | 사용자별 세션 분리 | 캡처 |
| 6 | A membership 비활성(version 증가) | A 요청 403, A worker fence/stop, B 영향 없음 | 응답 코드, container 상태 |
| 7 | host 재시작(serve 종료/재기동) | 이전 세대는 unknown 또는 retired로 남고 자동 재배정 없음, 새 로그인 필요 | store 상태 요약, 화면 |
| 8 | 생성 중 강제 종료·daemon 응답 지연 | unknown 보존, 자동 재생성 없음, 운영자 조사 필요 표시 | 로그(민감값 제외) |
| 9 | 종료 후 `docker ps -a`·metadata root | 회수된 container 없음, metadata에 token 없음 | 목록 |

실패 항목은 수정 없이 그대로 기록하고 [worker 후속 계획](../../docs/plans/archive/2026-10-10-organization-worker-supervisor.md)에 남긴다. 이 절차의 통과는 해당 호스트·이미지·네트워크 구성에 대한 근거이며, 다른 배포 환경이나 실제 운영 승인을 대신하지 않는다.

## 로컬 실행 결과 (2026-10-10, Docker Desktop 28.3.3 linux-arm64)

`npm run verify:worker-isolation`(`tests/opt-in/verify-worker-isolation.mjs`)이 합성 사용자 A/B, 합성 OIDC, 임시 SQLite, 실제 Docker driver로 **30/30** 통과했다(2회 연속). worker 네트워크는 `--internal`이라 container 안의 AWS CLI는 AWS에 닿지 못하며 로그인은 `failed`로 끝난다.

| 절차 # | 자동 검사 | 결과 |
|---|---|---|
| 2 | 명시적 login에서만 container 2개 생성, UID 10001, read-only root, CapDrop ALL, no-new-privileges, IPC private, log-driver none, 지정 network, 메모리/PID 제한, port 없음, read-only bind 2개 + tmpfs 2개, 공유 source 없음, binding/lease/cache label 서로 다름 | 통과 |
| 3 | cache tmpfs 0700/10001, rootfs 쓰기 불가, host `.aws` 없음, 각 cache에 자기 profile만 존재 | 통과 |
| 4 | `docker logs` 불가(stdout 비공개), B가 A의 연결 상태를 읽으면 404 | 통과 |
| 6 | A membership 비활성 → heartbeat가 A container만 fence/제거, B 유지, A 요청 403 | 통과 |
| 7 | 종료 시 worker 제거, 재시작 후 status는 worker를 만들지 않고 503 | 통과 |
| 9 | 실행 후 남은 worker container 0, 임시 metadata 삭제 | 통과 |
| 1·5 | 실제 Identity Center Device Code 로그인/STS/조회/로그아웃(개인 테스트 계정, 외부 통신 가능 테스트 네트워크) | 통과(CLI 2.30 `#/device` URL 수정 후) |
| 8 | 호스트 SIGKILL(worker ready) → 재시작·lease 만료에도 재배정 없음 → `reconcile-worker` 후에만 2세대 (`npm run verify:worker-recovery`, 8/8) | 통과 |
| 8b | daemon 지연: create가 client 포기 뒤 40초에 완료 → 늦은 container는 시작·연결되지 않음, 자동 재시도 없음, reconcile은 미확인 생성에 receipt를 만들지 않음 → 운영자가 조사한 ID만 전체 검증 후 제거·retire (`npm run verify:worker-daemon-delay`, 7/7) | 통과 |

이 결과는 이 Mac의 Docker Desktop VM에 대한 근거이며, 회사 Linux 호스트·네트워크 정책·swap/디스크 정책의 검증을 대신하지 않는다.
