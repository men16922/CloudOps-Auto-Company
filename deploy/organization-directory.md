# 조직 Root/OU 계정 상태 수집

갱신: 2026-10-10. CLI worker·조직 API·한/영 화면의 로컬 합성 통합을 구현했다. 실제 AWS Organizations/회사 SSO·물리 worker 배포는 검증하지 않았다.

## 설정과 사용

서버의 연결 설정 하나에 선택적인 `directory`를 추가한다. 값은 예시이며 실제 조직/Root/OU는 관리자가 정한다. 브라우저는 원시 조직 ID·parent ID·명령·AWS NextToken을 보내지 않는다. 후속 조회에는 worker가 발급한 임시 UUID cursor만 사용한다.

```json
{
  "configurationId": "aws-directory-read",
  "directory": {
    "awsOrganizationId": "o-synthetic1",
    "parentId": "r-demo"
  }
}
```

이 조각은 기존 연결의 portal·account·role·region 설정과 합친다. 전체 형식은 [조직 웹 설정 예시](organization-web.example.json), 로그인/worker 연결은 [웹 사용법](organization-web.md)을 따른다. `directory`가 없으면 해당 읽기 버튼은 제공하지 않고 서버도 명령을 거절한다. 기존 연결의 scope를 바꾸면 binding digest가 달라져 사용을 거절한다. 새 `configurationId`로 등록하고 그 설정의 새 연결/worker를 배정해야 한다.

웹 로그인 → 본인 연결 → AWS Device Code/기존 세션 확인 → **지정 Root/OU 계정 상태 조회**로 사용한다. 수명주기 필터는 반환된 페이지 안에서 적용한다. AWS의 `State`를 사용하며 값이 없거나 알 수 없으면 `UNKNOWN`이다. `ACTIVE`는 서비스 정상이나 사용자의 하위 계정 접근 권한으로 해석하지 않는다. [AWS Account 필드](https://docs.aws.amazon.com/organizations/latest/APIReference/API_Account.html)

**계정 다음 페이지 / OU 다음 페이지**로 이동하고, OU 이름을 눌러 하위 범위를 조회한다. 경로 버튼은 해당 상위 범위의 첫 페이지로 돌아간다. **설정 범위 처음부터**는 지정된 Root/OU 안에서 다시 시작한다. 탐색 정보가 만료되면 위의 **지정 Root/OU 계정 상태 조회**를 눌러 새로 수집한다. 한 목록의 페이지를 넘길 때 다른 목록은 현재 페이지를 재조회하며 각각 페이지 번호·관측 시각을 표시한다.

## 조회 범위와 증거

고정 명령은 STS 확인 → DescribeOrganization → ListRoots 또는 DescribeOrganizationalUnit → ListAccountsForParent → ListOrganizationalUnitsForParent → STS 재확인이다. 하위 OU에서는 조회 전후 ListParents로 경로를 재검증한다. 기본 6개, 탐색 경로 최대 5개 하위 OU의 전후 확인을 포함해 최대 16개 CLI 호출이다. 각 목록은 `--no-paginate`, `MaxResults=20`, 수집 전체는 25초 취소 기한으로 제한한다. 각 자식 계정에 역할을 맡거나 서비스를 전수 점검하지 않는다. [ListParents 의미](https://docs.aws.amazon.com/organizations/latest/APIReference/API_ListParents.html)

한 화면은 현재 Root/OU의 **직접 자식**만 표시한다. Root에 지정해도 하위 OU 안의 계정을 자동 포함하지 않는다. 빈 결과에도 NextToken이 있으면 `hasMore=true`와 다음 페이지 이동을 제공한다. 같은 token이 순환하면 해당 목록을 미수집으로 처리한다. 조직 전체 자동 수집·집계는 없으며 페이지 수를 조직 총계로 표시하지 않는다. [ListAccountsForParent 범위/페이지](https://docs.aws.amazon.com/organizations/latest/APIReference/API_ListAccountsForParent.html) · [OU 목록](https://docs.aws.amazon.com/organizations/latest/APIReference/API_ListOrganizationalUnitsForParent.html)

탐색 cursor는 연결/사용자 전용 worker 메모리에만 저장하며 10분 뒤 만료한다. 최대 128개를 보관하고 오래된 참조부터 제거한다. 상단 **지정 Root/OU 계정 상태 조회**로 새 수집을 시작하거나 AWS 재인증·연결 해제·worker 재시작 때 폐기한다. 경로 버튼을 통한 복귀는 기존 탐색 만료 시각을 유지한다. 서로 다른 worker의 cursor, 임의 UUID, 만료된 cursor는 CLI를 호출하기 전에 거절한다. AWS NextToken은 worker 내부에서 JSON 입력으로 전달하며 브라우저/지속 replay 기록에 넣지 않는다. 각 목록은 최대 1,000페이지, 경로는 지정 범위를 포함해 최대 6단계로 제한하고 제한 도달 시 완전 수집으로 표시하지 않는다.

- 예상 AWS 조직 ID, Root/OU ARN, 계정/OU ARN의 조직 범위를 검사한다. 조회 전후 STS 계정·역할·주체가 달라지거나 도중 연결이 끊기면 전체 결과를 폐기한다.
- 탐색한 OU가 이전 경로 밖으로 이동하면 결과를 폐기한다. ListParents가 불완전하거나 확인이 거절되어 현재 경로를 입증하지 못하면 관측을 반환하지 않는다. OU 경로 검증에는 해당 IAM 읽기 권한도 필요하다.
- 계정/OU 부분별 관측 시각·API 출처·부분 목록 여부를 보존한다. 선행 조직/parent 확인에서 실패하면 실제 실패한 API를 출처로 남긴다. 여러 API의 관측은 원자적인 한 시점 스냅샷이 아니다.
- 목록 조회 거절/오류는 `denied`/`unavailable`이며 0개나 정상으로 바꾸지 않는다. 계정 목록만 거절되면 수집된 OU 결과는 표시한다. 유효한 STS 세션을 단순 목록 거절 때문에 로그아웃시키지 않는다.
- 조직 계정 수명주기, 사용자 접근 `not-checked`, 서비스 점검 `not-collected`는 별도 값이다. 이름·ID·수명주기만 화면에 보내며 email·원문 ARN·CLI 응답·토큰은 반환하지 않는다.
- 기존 registry의 소유권/membership 재검증·요청 키·응답 유실 unknown을 유지한다. 새로고침/사용자 전환/로그아웃 후 화면 관측은 복원하지 않는다. 실패한 새 수집으로 이전 결과를 최신인 것처럼 남기지 않는다.

Organizations 목록은 관리 계정 또는 delegated administrator의 해당 권한이 필요하다. 서버 설정이나 OU 선택 자체는 IAM 권한을 추가하지 않는다. 회사 역할/정책은 별도로 확인한다. [AWS ListRoots](https://docs.aws.amazon.com/organizations/latest/APIReference/API_ListRoots.html)

## 로컬 검증

`tests/unit/worker/directory-reads.test.ts`는 고정 명령·상태/부분 거절·빈 다음 페이지·미지원 State·조직/ARN 변조·주체 변경/취소와 페이지/하위 OU·만료/worker 격리·재인증/초기화·OU 이동·순환 token을 확인한다. HTTP→registry→worker와 private pipe/router에서도 cursor 전달/재시도를 검증한다. `test:organization-web`는 계정/OU 페이지·하위 탐색/복귀·만료 후 재조회·필터·거절/사용자 전환과 한/영 모바일 접근성을 확인한다. 실제 AWS API·배포 검증과 구분한다.
