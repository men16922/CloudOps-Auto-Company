# 자산·소스 출처

- 원본 저장소는 CloudOps-Automation이다. 2026-10-10에 base commit `b9e6fbdaf61994d6c6392665a776b5ac3cdaf3d1`(작업 트리 변경 포함)에서 회사용 모듈을 분리했다. 당시 파일 해시·의존성 목록 매니페스트는 현재 구조와 맞지 않아 제거했으며 이 저장소의 Git 이력(`2c89f29` 이전)에 남아 있다. 원본 Git 이력은 원본 repo에 남아 있다.
- AWS 표시는 `apps/web/src/assets/aws.svg`에 있다. 원본 작업에서 2026-10-10 AWS 공식 홈페이지 탐색 로고를 참고했고 CSS 채움을 고정했다. provider 식별 표시이며 제휴/인증/계정 연결을 의미하지 않는다. [AWS 홈페이지](https://aws.amazon.com/)
- `apps/web/public/cloudops-mark.svg`와 앱 코드는 원본 작업의 출처를 유지한다. npm의 정확 버전·integrity·license metadata는 manifest/lock을 따른다. 설치된 패키지의 license 파일을 보존한다.
- 이번 분리는 회사 재배포 권리 심사나 새 공개 라이선스 부여가 아니다. 회사 코드·설정·관측 자료를 공개 저장소로 자동 전송하지 않는다.
