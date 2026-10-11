# 후속 작업

로컬에서 가능한 구현과 검증은 마쳤다. 남은 일마다 필요한 입력·승인을 표시했다.

1. **웹 인증(Identity Center SAML).** 완료: SAML bridge·popup PKCE·ES256 verifier, 합성 SAML 단위/e2e. 개인 테스트 계정에서 실제 SAML 웹 로그인 통과. **남음(회사):** 회사 Identity Center에 같은 SAML 앱 구성(운영 https ACS)과 공유 서명 키·sticky session(다중 인스턴스 시). 선택: 웹 사용자와 Device Code 주체 일치 검사. http loopback ACS가 거부되면 local host TLS 추가. 선택: 웹 사용자와 Device Code 주체(role session name) 일치 검사.
2. **AWS 인증(Identity Center + Device Code).** 완료: 배포 스키마·`check-deployment`·worker 경로. 개인 계정 사전 확인(management account, instance 없음, 무료). 개인 테스트 계정에서 실제 Device Code 로그인·STS·조회·로그아웃 통과(격리 절차 1·5번). **남음(회사):** 회사 Identity Center의 실제 start URL·할당 계정/역할로 같은 확인.
3. **운영 기동(DynamoDB).** 완료: `DynamoDbCloudStore`, 적합성·DynamoDB Local·실제 AWS 임시 테이블 검증(9/9, 삭제함), `composeOrganizationApi`, local host의 DynamoDB store 기동(DynamoDB Local smoke). **남음(회사):** 운영 테이블·IAM 최소 권한·자격 provider(role), listener/TLS/proxy/CA.
4. **worker 실검증.** 완료: 로컬 Docker 30/30(절차 2·3·4·6·7·9). 절차 1·5 실제 통과, 정상 종료 회수와 `reconcile-worker`(활성 lease 거부) 확인. 8번 SIGKILL 복구 8/8, daemon 지연 7/7 실검증. **남음(회사):** 회사 Linux 호스트·네트워크·swap/디스크 정책에서 재실행.운영자 조사 기반 회수(`reconcile-worker --investigated-container`)도 실검증 7/7.
5. **엔터프라이즈 운영 기능.** [계획](plans/2026-10-11-enterprise-operations.md). 1단계(다계정·다리전 동기화, 직접/Config 집계자 모드, VPC 태그 기준 사용 리전, 디스크 캐시·동기화 버튼, 계정·리전 열·범위 필터·검색 조건·CSV, Serverless 탭(+API Gateway), Systems Manager 읽기), 2단계(수명주기 EOS 센터), 3단계 거버넌스(Security Hub·GuardDuty 결과와 적용 범위, AWS Health, 필수 태그 준수), 4단계 운영 리포트(동기화별 판정 기록·추이·신규/해결·EOS 일정·Markdown/HTML 내보내기), 저장된 보기(서버 측 사용자 설정), 호스트 측 결과 수집 구현 완료(이메일 알림은 사용자 결정으로 제거)(3·4단계는 합성 검증만, 실제 계정 검증 남음). **남음:**  5단계 SSM Automation 런북 실행(쓰기, AGENTS 규칙 변경과 승인 필요), 6단계 예약 동기화·성능·운영 저장소. Config 집계자 모드의 실제 계정 검증(Config 기록 필요, 소액 과금).

로컬 기록: 초기 로컬 commit 완료(사용자 승인). push·remote 생성은 별도 요청 시에만 한다.

GCP 해커톤/Android 개발은 ai-builder-cup, 개인 AWS/On-Prem 및 원본 이력은 CloudOps-Automation에서 관리한다. 이 저장소의 회사 설정·데이터를 두 저장소에 자동 동기화하지 않는다.
