# Worker supervisor 후속 검증

지속 connection/lease, 세대 고정 pipe, 명시적 login에서만 provisioning, 현재 membership 검사, heartbeat와 종료 대기를 구현했다. optional Docker driver는 고정 CLI/socket/daemon/image/network를 사용하고 생성/시작/삭제 의도를 전송 전에 저장한다. 원본부터 현재까지 실제 Docker 실행은 검증하지 않았다.

회사 환경을 연결하는 별도 작업에서 다음을 확인한다.

1. 회사 인증/권한·운영 저장·host/TLS 구성과 두 사용자로 분리된 allocation.
2. 실제 Linux worker의 UID/home/config/SSO cache·private pipe와 접근 차단.
3. 응답 유실·process 재시작·권한 회수·지연 provisioning·한 사용자 로그아웃.
4. 종료/부재·cache 차단이 미확인일 때 unknown 보존과 자동 재배정 방지.

현재 synthetic/Node-process 테스트와 Dockerfile 작성은 이 검증을 대신하지 않는다. [계약](../../../deploy/organization-cli-worker/README.md)
