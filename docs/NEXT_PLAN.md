# 후속 작업

로컬에서 가능한 구현과 검증은 마쳤다. 남은 일마다 필요한 입력·승인을 표시했다.

1. **웹 인증(Identity Center SAML).** 완료: SAML bridge·popup PKCE·ES256 verifier, 합성 SAML 단위/e2e. 개인 테스트 계정에서 실제 SAML 웹 로그인 통과. **남음(회사):** 회사 Identity Center에 같은 SAML 앱 구성(운영 https ACS)과 공유 서명 키·sticky session(다중 인스턴스 시). 선택: 웹 사용자와 Device Code 주체 일치 검사. http loopback ACS가 거부되면 local host TLS 추가. 선택: 웹 사용자와 Device Code 주체(role session name) 일치 검사.
2. **AWS 인증(Identity Center + Device Code).** 완료: 배포 스키마·`check-deployment`·worker 경로. 개인 계정 사전 확인(management account, instance 없음, 무료). 개인 테스트 계정에서 실제 Device Code 로그인·STS·조회·로그아웃 통과(격리 절차 1·5번). **남음(회사):** 회사 Identity Center의 실제 start URL·할당 계정/역할로 같은 확인.
3. **운영 기동(DynamoDB).** 완료: `DynamoDbCloudStore`, 적합성·DynamoDB Local·실제 AWS 임시 테이블 검증(9/9, 삭제함), `composeOrganizationApi`. **남음(회사):** 운영 테이블·IAM 최소 권한·자격 provider(role), listener/TLS/proxy/CA.
4. **worker 실검증.** 완료: 로컬 Docker 30/30(절차 2·3·4·6·7·9). 절차 1·5 실제 통과, 정상 종료 회수와 `reconcile-worker`(활성 lease 거부) 확인. 8번 SIGKILL 복구 실검증 8/8. **남음(회사):** 회사 Linux 호스트·네트워크 정책·swap/디스크 정책에서 재실행, daemon 지연 주입.
5. **기능 확장.** **남음(운영자):** 실제 운영자의 계정 상태 탐색과 점검/결과·인계 요구를 확인한 뒤 확장한다. 현재 조회/조직 페이지를 전체 조직 집계나 자동 복구로 표현하지 않는다.

로컬 기록: 초기 로컬 commit 완료(사용자 승인). push·remote 생성은 별도 요청 시에만 한다.

GCP 해커톤/Android 개발은 ai-builder-cup, 개인 AWS/On-Prem 및 원본 이력은 CloudOps-Automation에서 관리한다. 이 저장소의 회사 설정·데이터를 두 저장소에 자동 동기화하지 않는다.
