# Progress log

## 2026-10-10 — daemon 지연·DynamoDB local host
- `verify-worker-daemon-delay.mjs` 실제 Docker 7/7(늦은 create fail-closed, 조사한 ID만 전체 검증 후 회수). `adoptInvestigatedContainer` + `reconcile-worker --investigated-container`.
- local host `CLOUDOPS_DYNAMODB_STORE`, DynamoDB Local에서 host smoke 통과.

## 2026-10-10 — worker 장애 주입
- `scripts/verify-worker-recovery.mjs`(npm `verify:worker-recovery`): SIGKILL→재배정 없음→만료 후에도 없음→reconcile 후 2세대, 실제 Docker 8/8.

## 2026-10-10 — 실제 Identity Center end-to-end
- 실제 SAML 웹 로그인, Device Code 승인, STS, Lambda 조회, AWS 로그아웃 통과. CLI 2.30 `<start>/#/device` 거부 결함을 parser·서버·브라우저에서 수정하고 회귀 테스트 추가. `reconcile-worker`, SIGHUP 처리 추가. 173/173.

## 2026-10-10 — 개인 테스트 계정 Identity Center 실구성
- 단일 리전 organization instance 활성화, 테스트 사용자·CloudOpsReadOnly 할당, SAML 앱(http loopback ACS 수락) 생성·할당, local host(SAML+Docker) 기동. 사용자 비밀번호·MFA 대기.

## 2026-10-10 — Identity Center SAML 웹 로그인·실제 DynamoDB
- 웹 로그인을 Identity Center SAML로 통일(사용자 결정): `organization-saml-bridge.ts`, 배포 `samlBridge`, composition 연결, 단위 4 + Chromium e2e.
- 실제 AWS DynamoDB 임시 테이블 9/9 후 삭제. 테스트 171/171.
- Identity Center 활성화는 콘솔 클릭이 필요하나 자동 클릭이 권한 분류기에 거부되어 사용자 조치 대기. 대비로 local host 선택형 TLS와 `scripts/identity-center-test-setup.sh`(미실행) 추가.

## 2026-10-10 — 로컬 Docker 검증·DynamoDB adapter (사용자 승인)
- worker 이미지 빌드, `scripts/verify-worker-isolation.mjs` 실제 Docker 30/30(internal 네트워크).
- `server/cloud-dynamodb-store.ts`(SigV4 직접 서명, TransactWriteItems 낙관적 동시성, 같은 token 재전송) + 테스트 13, DynamoDB Local 9/9(`scripts/verify-dynamodb-local.mjs`).
- 개인 계정 Identity Center 가능·무료 확인(읽기 전용), `deploy/identity-center-test-setup.md`. 테스트 167/167.

## 2026-10-10 — 브라우저 OIDC·점검·저장소 적합성·격리 절차
- 브라우저 `OidcWebIdentityClient`(popup PKCE, 메모리 전용 token) + `public/oidc-callback.*`, web config `company.oidc`, company-main factory. 합성 IdP Chromium e2e를 check-company에 추가.
- `local.mjs check-deployment`(브라우저/서버 OIDC 짝, 마스킹 요약), opt-in Docker provisioner 연결(`CLOUDOPS_DOCKER_WORKER_CONFIG`).
- `server/cloud-store-conformance.ts` + SQLite 실행. worker 격리 실검증 절차 문서(미실행). 테스트 154/154.

## 2026-10-10 — 로컬 구성·인증 기반
- 배포 JSON 검증(`organizationDeploymentSchema`)과 명시적 `composeOrganizationApi` 추가. company 방식만 허용, scope 일치·중복 거부, verifier 없으면 503.
- 표준 OIDC 서버 verifier 후보 `server/oidc-web-identity.ts`(node:crypto, RS256/PS256/ES256, JWKS 고정/원격 1분 간격).
- loopback host `server/organization-local-host.ts` + `dist-company-api/local.mjs`(`serve`/`actor`/`provision-membership`), `npm run start:local`.
- 테스트 +10(132/132), check-company에 빌드 산출물 local host smoke 추가. 문서: deploy/organization-api.md, organization-web.md, README, STATUS, NEXT_PLAN, verification.

## 2026-10-10 — 독립 repo 분리
- 원본 CloudOps-Automation에서 회사용 조직 AWS 모듈 분리, make check 122/122. 상세는 docs/verification.md.
