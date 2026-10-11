# 후속 작업

로컬에서 가능한 구현과 검증은 마쳤다. 남은 일마다 필요한 입력·승인을 표시했다.

1. **웹 인증(Identity Center SAML).** 완료: SAML bridge·popup PKCE·ES256 verifier, 합성 SAML 단위/e2e, 개인 테스트 계정 실제 로그인. **남음(회사):** 회사 Identity Center에 같은 SAML 앱 구성(운영 https ACS), 다중 인스턴스 시 공유 서명 키·sticky session. 선택: 웹 사용자와 Device Code 주체(role session name) 일치 검사.
2. **AWS 인증(Identity Center + Device Code).** 완료: 배포 스키마·`check-deployment`·worker 경로, 개인 테스트 Identity Center에서 Device Code 로그인·STS·조회·로그아웃. **남음(회사):** 회사 Identity Center의 실제 start URL·할당 계정/역할로 같은 확인.
3. **운영 기동(DynamoDB).** 완료: `DynamoDbCloudStore`, 적합성·DynamoDB Local·실제 AWS 임시 테이블(9/9, 삭제함), local host의 DynamoDB store 기동. **남음(회사):** 운영 테이블·IAM 최소 권한·자격 provider(role), listener/TLS/proxy/CA.
4. **worker 실검증.** 완료: 로컬 Docker 30/30, 실제 로그인 절차, 정상 종료 회수·`reconcile-worker`, SIGKILL 복구 8/8, daemon 지연 7/7, 운영자 조사 기반 회수 7/7. **남음(회사):** 회사 Linux 호스트·네트워크·swap/디스크 정책에서 재실행.
5. **엔터프라이즈 운영 기능.** [계획](plans/2026-10-11-enterprise-operations.md). 1~4단계 구현 완료(다계정·다리전 동기화와 호스트 측 수집, EOS 센터, 거버넌스, 운영 리포트·저장된 보기). 알림은 사용자 결정으로 두지 않는다. **남음:**
   - 실제 계정: 런북 '연결 점검' 성공, 리포트 추이·저장된 보기 확인(2026-10-11). 남음: 웹 사용자와 Device Code 승인자 동일성 검사 설계·검증, EC2 런북의 실계정 확인(필요 시 테스트 인스턴스).
   - 구현 완료·실계정 미확인: 5단계 런북 실행, 예약 동기화(사용자 세션 기반; 무인 서비스 역할 수집은 회사 배포 단계 설계).
   - 6단계 성능·운영 저장소(회사 배포 단계).

로컬 기록: 사용자 승인으로 로컬 commit만 한다. push·remote 생성은 별도 요청 시에만 한다.

GCP 해커톤/Android 개발은 ai-builder-cup, 개인 AWS/On-Prem 및 원본 이력은 CloudOps-Automation에서 관리한다. 이 저장소의 회사 설정·데이터를 두 저장소에 자동 동기화하지 않는다.
