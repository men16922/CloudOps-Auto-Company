▶ NEXT SESSION: 사용자 웹 로그인 후 실제 계정에서 런북 '연결 점검' 요청→승인→실행, 리포트 추이, 저장된 보기를 확인한다(docs/plans/2026-10-11-enterprise-operations.md 5단계). 나머지는 회사 측 값 필요. 로컬 호스트는 `.data/host-release` 복사본에서 띄운다.

# Agent brief

- 범위: 조직 AWS 계정 운영 전용(CloudOps Auto Company). 규칙은 `AGENTS.md`, 상태는 `docs/STATUS.md`, 할 일은 `docs/NEXT_PLAN.md`, 구조는 `docs/architecture/overview.md`.
- 구조(2026-10-11): apps/web·apps/host·apps/worker + packages/contracts·assessment·worker-protocol, 테스트는 tests/unit/<층>·contract·browser·opt-in. 빌드별 허용 폴더 검사.
- 스냅샷(2026-10-11): `make check` 녹색, 단위·계약 219/219. 엔터프라이즈 운영 1~5단계 구현(런북 실행·예약 동기화 포함, 동기화는 버튼만, 캐시는 사용자+Payer 설정 단위; 다계정·다리전 동기화와 호스트 측 수집, EOS, 거버넌스, 운영 리포트·저장된 보기). 개인 테스트 계정에서 SAML 웹 로그인·Device Code·동기화·거버넌스 상태·첫 리포트 기록 확인. 알림 기능은 사용자 결정으로 제거.
- 활성 작업: 실계정 런북·리포트 확인(사용자 로그인 대기).
- 작업 트리: `main`, 로컬 commit만(remote·push 없음). commit/push/remote/Docker/클라우드 호출은 명시 요청 시에만.
- 가드레일: 합성 데이터만, 실제 회사 설정·token·계정 관측·.env/.data를 Git/로그에 넣지 않음. 테스트는 실제 AWS CLI·Docker·IdP 호출 금지. Device Code token은 웹 신원이 아님. 로그인 성공 ≠ 권한. 런북 쓰기는 승인 절차(요청→타인 승인→본인 세션 실행)로만.
