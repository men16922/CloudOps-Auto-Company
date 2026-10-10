# 자산·소스 출처

- 원본 저장소는 CloudOps-Automation이다. 추출 시점의 base commit·mixed worktree·파일 해시는 source-manifest.json에 기록한다. 원본 Git 이력은 원본 repo에 남아 있다.
- AWS 표시는 `src/modules/aws/assets/aws.svg`에 있다. 원본 작업에서 2026-10-10 AWS 공식 홈페이지 탐색 로고를 참고했고 CSS 채움을 고정했다. provider 식별 표시이며 제휴/인증/계정 연결을 의미하지 않는다. [AWS 홈페이지](https://aws.amazon.com/)
- `public/cloudops-mark.svg`와 앱 코드는 원본 작업의 출처를 유지한다. npm의 정확 버전·integrity·license metadata는 manifest/lock을 따른다. 설치된 패키지의 license 파일을 보존한다.
- 이번 분리는 회사 재배포 권리 심사나 새 공개 라이선스 부여가 아니다. 회사 코드·설정·관측 자료를 공개 저장소로 자동 전송하지 않는다.
