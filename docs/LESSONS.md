# Lessons

- 시스템 Homebrew `node`는 libsimdutf 누락으로 죽는다. `make check`는 repo `.tools/node`를 PATH에 넣는다. 직접 실행할 때는 `PATH=$PWD/.tools/node/bin:$PATH`.
- 경계 정규식(`scripts/company-build-policy.mjs`)이 `server/(service|index|http|cloud-index).*` 이름을 거부한다. 새 서버 진입점은 다른 이름을 쓴다.
- 새 서버 테스트·진입점은 `tsconfig.json`의 `files`에 추가해야 타입/경계 검사 대상이 된다.
- `membershipSchema`는 strict다. web scope 객체(label 포함)를 그대로 펼쳐 넣으면 실패한다.
- API는 Host==publicOrigin을 요구하므로, 테스트 서버는 먼저 listen하고 실제 포트로 origin을 만든 뒤 compose한다.
- Cloudscape Select option은 `getByRole('option', { name })`로 고른다. `getByText`는 screenreader 복제 때문에 strict mode 위반.
- 로컬 host는 COOP same-origin이라 OIDC popup의 opener가 끊긴다. callback은 BroadcastChannel로 전달하고 popup.closed 폴링에 의존하지 않는다.
- Node fetch(undici)는 테스트에서 `Origin`/`Sec-Fetch-Site` 헤더를 그대로 보낸다. API origin 검사 테스트에 사용 가능.
- Docker Desktop은 containerd snapshotter라 `docker image inspect {{.Id}}`가 manifest list digest다. driver의 imageId와 container `.Image`가 같은 값으로 일치했다.
- botocore로 SigV4 기준 벡터를 오프라인 생성할 수 있다(`mock.patch('botocore.auth.get_current_datetime')`). botocore에는 인코딩된 URL을 넣고, 비 S3 path는 두 번 encode된다.
- Docker 검증은 `make check` 밖의 opt-in 스크립트로만 둔다. worker는 `--internal` 네트워크로 AWS 접속을 막고 실행한다.
- esbuild ESM 번들에 CJS 의존성(debug 등)이 있으면 `Dynamic require of "tty"` 오류가 난다. API 번들 banner에 `createRequire(import.meta.url)`를 둔다.
- Identity Center organization instance는 management account에서 API(CreateInstance)로 만들 수 없다. 콘솔 클릭은 권한 분류기가 막으므로 사용자가 직접 눌러야 한다.
- AWS CLI 2.30 Identity Center Device Code 출력의 기본 URL은 `<start>/#/device`(fragment)다. 합성 fixture의 `device.sso.<region>` 형식만으로는 실환경을 대변하지 못한다.
- 백그라운드 서버 종료는 `pgrep -f`(래퍼 셸까지 잡힘) 대신 확인한 node PID에 직접 SIGTERM을 보낸다. 셸만 죽으면 node가 고아로 남아 lease를 계속 갱신한다.

