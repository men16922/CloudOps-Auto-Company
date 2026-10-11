▶ NEXT SESSION: 개인 테스트 계정 실 end-to-end 완료. 남은 것은 회사 측(회사 Identity Center SAML 앱·실제 값, 운영 DynamoDB 테이블·IAM role·TLS, 회사 호스트 격리 재실행·장애 주입, 운영자 요구). 사용자 결정(2026-10-10): Chrome allow 규칙·개인 Identity Center 테스트 구성·Docker 테스트 리소스는 유지.

# Agent brief

- 범위: 조직 AWS 계정 운영 전용(CloudOps Auto Company). 규칙은 `AGENTS.md`, 상태는 `docs/STATUS.md`, 할 일은 `docs/NEXT_PLAN.md`.
- 스냅샷(2026-10-11): `make check` 녹색, 서버 219/219. 실제 Identity Center SAML+Device Code e2e 통과. 엔터프라이즈 운영 1·2단계(다계정·다리전 동기화, 직접/Config 모드, VPC 태그 사용 리전, 계정·리전 필터·검색 조건·CSV, Serverless 탭·API Gateway, SSM 읽기, EOS 센터), 3단계 거버넌스(Security Hub·GuardDuty·AWS Health 읽기, 필수 태그 준수), 4단계 운영 리포트(동기화별 판정 기록, 추이·신규/해결·EOS 일정, Markdown/HTML 내보내기), 저장된 보기(서버 측 사용자 설정), 이메일 알림(SMTP/TLS)과 호스트 측 결과 수집 구현. 3·4단계는 합성 검증만 했고 실제 계정 검증 전이다. 계획: docs/plans/2026-10-11-enterprise-operations.md. Identity Center SAML bridge(합성 e2e), DynamoDB adapter(실제 AWS 9/9), 로컬 Docker worker 격리 30/30. 서버 OIDC verifier와 브라우저 popup PKCE client(합성 IdP 브라우저 검증), 배포 스키마·composition·`check-deployment`, `npm run start:local`(loopback, opt-in Docker provisioner), `cloudStoreConformance`, worker 격리 절차 문서(미실행).
- 활성 작업: 없음(로컬). NEXT_PLAN 1~5의 남은 부분은 모두 회사 결정·실제 값·실행 승인이 필요.
- 작업 트리: `main`, 로컬 commit 2개(remote·push 없음), 대시보드 작업은 미commit. commit/push/remote/Docker/클라우드 호출은 명시 요청 시에만.
- 가드레일: 합성 데이터만, 실제 회사 설정·token·계정 관측·.env/.data를 Git/로그에 넣지 않음. 테스트는 실제 AWS CLI·Docker·IdP 호출 금지. Device Code token은 웹 신원이 아님. 로그인 성공 ≠ 권한.
