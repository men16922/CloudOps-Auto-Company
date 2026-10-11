# CloudOps Auto Company 개발 지침

- 이 저장소는 **조직용 AWS 계정 운영**만 담당한다. 회사용 화면·연결 API·IAM Identity Center Device Code CLI worker와 공통 인증/저장 계약을 포함한다. 개인 AWS/로컬 trial·GCP·On-Prem·Azure·Android·해커톤 개발은 다른 저장소의 범위다.
- 제품 표시명은 CloudOps Auto이며 한국어/영어를 지원한다. `src/i18n.tsx`의 저장·전환을 사용한다. 언어는 계정/권한을 선택하지 않는다.
- `docs/STATUS.md` → `docs/NEXT_PLAN.md` → `Identity.md`를 읽어 복원한다. 현재 요청은 독립 로컬 repo 분리다. 실제 회사 배포나 SSO 완료로 확대 해석하지 않는다.
- Node.js 24 이상, React/TypeScript/Vite와 실제 Cloudscape를 사용한다. Cloudscape는 컴포넌트별 import. 의존성/Chromium은 게이트 전에 준비하고 `make check` 안에서 설치하지 않는다.
- `make check`는 타입/모듈 경계·웹/API/private worker 빌드·서버 테스트·회사 smoke·조직 웹 합성 검증이다. 별도 임시 DB/합성 데이터/캡처를 사용한다. 테스트가 실제 AWS CLI·Docker·회사 IdP를 호출하지 않게 한다.
- 회사 인증은 Frontend → Backend → AWS CLI Device Code 경계를 유지한다. 현재 구현은 TypeScript/Node이며 Flask 서비스로 표현하지 않는다. 웹의 `WebIdentityClient`와 서버 `WebIdentityVerifier`는 회사가 선택한 인증 adapter를 별도로 주입한다. AWS Device Code token은 웹 신원이 아니다.
- 사용자별 프로필·sso-session·실제 홈/캐시·실행 환경을 분리한다. 공용 홈/캐시·요청별 전역 AWS_PROFILE 변경·개발자의 개인 CLI/키 승계는 금지한다. private pipe를 브라우저에 공개하지 않는다.
- 서버의 현재 웹 신원·조직/workspace membership·역할·connection owner를 매번 검사한다. OU/Payer 선택과 로그인 성공을 하위 계정 권한 부여로 취급하지 않는다. 클라이언트 context/actor/profile/endpoint/명령을 실행 입력으로 받지 않는다.
- 서버 고정 계정·역할·리전·조회 API만 수행한다. 전후 STS/대상·binding digest·lease 세대를 확인하고 늦은 사용자 응답을 버린다. Organizations는 지정 범위의 직접 자식 한 페이지씩 조회하며 10분 worker cursor만 받는다. State 미수집은 UNKNOWN이다.
- 동기화(2026-10-11 사용자 결정)는 사용자 전용 worker가 서버에 설정된 Organizations 범위의 계정(상한)과 활성/설정 리전만 대상으로 한다. 계정마다 같은 Identity Center 사용자인지 STS로 전후 확인하고, 태그된 VPC가 있는 리전만 사용 리전으로 본다. 결과는 호스트의 사용자별 디스크 캐시로만 전달한다. 브라우저의 디렉터리 탐색은 위 cursor 규칙을 그대로 따른다. 쓰기(런북 실행)는 별도 승인 전까지 추가하지 않는다.
- 알림(2026-10-11 사용자 결정): Slack은 쓰지 않고 이메일만 보낸다. SMTP·수신자·비밀번호 파일 경로는 서버 설정(.data)에만 두고 비밀번호는 호스트 사용자만 읽는 0600 파일로 둔다. 동기화가 끝날 때 새로 나타난 조치·주의 항목만 보내며, 브라우저는 수신자·내용을 정하지 못한다(테스트 메일은 고정 문구). 수신자 주소를 Git·로그·문서에 넣지 않는다. 동기화를 시작한 뒤 결과 수집은 호스트가 이어서 하며 worker 생성·로그인은 하지 않는다.
- 상태/재시도/새로고침으로 worker를 생성하거나 로그인을 시작하지 않는다. 미확인 dispatch/생성은 자동 재전송하지 않는다. worker 종료와 캐시 접근 차단의 확인 없이는 새 세대를 배정하지 않는다. 물리 격리·실제 회사 SSO는 별도 검증이다.
- 저장 transaction의 재시도 콜백에는 외부 호출을 넣지 않는다. SQLite는 로컬 테스트 adapter이고 회사 운영 저장소 선택은 남았다. 해시 연결을 불변 감사 저장소로 표현하지 않는다.
- 회사 설정·키·SSO token·실제 계정 관측·.env·.data를 Git/브라우저 저장소/로그/보고서에 넣지 않는다. 테스트/캡처에는 합성 데이터만 사용한다.
- runtime/type-only 경계 검사는 다른 provider·개인 AWS·Firebase/Google SDK를 거부한다. 공통 계약에 provider 식별자가 남아 있어도 해당 provider 구현이 포함된 것은 아니다.
- source-manifest.json은 최초 분리 출처와 파일 해시이며, company-manifest.json은 원본 빌드 후보의 기록이다. 원본 mixed WIP/이력은 원본 repo에 보존한다. 회사 전용 변경을 다른 repo에 자동 동기화하지 않는다.
- 로컬 repo 분리는 commit/push·원격 repo 생성·Docker/클라우드 호출·IAM/전역 설정 변경·회사 배포 승인이 아니다. 요청 범위 안의 로컬 수정/검증을 진행하고 실제 통합은 명시된 범위에서 별도로 수행한다.
