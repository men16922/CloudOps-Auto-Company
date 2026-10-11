▶ NEXT SESSION: 실제 계정에서 두 번째 동기화로 리포트 추이·신규/해결과 저장된 보기를 확인한다(사용자 웹·AWS 로그인 필요). 그 밖의 남은 일은 사용자 결정(Config 모드 과금, 런북 쓰기 승인, 예약 동기화 자격 모델)이나 회사 측 값이 필요하다. 로컬 호스트는 `.data/host-release` 복사본에서 띄운다.

# Agent brief

- 범위: 조직 AWS 계정 운영 전용(CloudOps Auto Company). 규칙은 `AGENTS.md`, 상태는 `docs/STATUS.md`, 할 일은 `docs/NEXT_PLAN.md`, 구조는 `docs/architecture/overview.md`.
- 구조(2026-10-11): apps/web·apps/host·apps/worker + packages/contracts·assessment·worker-protocol, 테스트는 tests/unit/<층>·contract·browser·opt-in. 빌드별 허용 폴더 검사.
- 스냅샷(2026-10-11): `make check` 녹색, 단위·계약 218/218. 엔터프라이즈 운영 1~4단계 구현(다계정·다리전 동기화와 호스트 측 수집, EOS, 거버넌스, 운영 리포트·저장된 보기). 개인 테스트 계정에서 SAML 웹 로그인·Device Code·동기화·거버넌스 상태·첫 리포트 기록 확인. 알림 기능은 사용자 결정으로 제거.
- 활성 작업: 실제 계정 2차 동기화 확인(사용자 로그인 대기). 나머지는 사용자 결정·회사 값 필요.
- 작업 트리: `main`, 로컬 commit만(remote·push 없음). commit/push/remote/Docker/클라우드 호출은 명시 요청 시에만.
- 가드레일: 합성 데이터만, 실제 회사 설정·token·계정 관측·.env/.data를 Git/로그에 넣지 않음. 테스트는 실제 AWS CLI·Docker·IdP 호출 금지. Device Code token은 웹 신원이 아님. 로그인 성공 ≠ 권한. 쓰기(런북)는 승인 전 금지.
