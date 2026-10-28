# 두 에디션 정리 + 예산 증액 요청·승인 설계

- 날짜: 2026-10-24
- 상태: 승인됨 (2026-10-24)
- 관련: ADR-006(Local Governance), ADR-008(예산 집행), PR #134(deployment_mode), PR #136(governance UI 정리)

## 1. 의도와 이유

CC-on-Bedrock은 **LLM gateway 없이** Bedrock 사용을 통제한다. 사용자는 Cognito로 받은 STS 자격 증명으로 Bedrock을 직접 호출하고, 플랫폼은 호출 로그로 비용을 집계해 한도를 넘으면 per-user IAM role에 deny 정책을 붙인다. gateway가 없으므로 **비용 한도, 부서별 예산, 차단 목록, 한도 허용(증액)** 이 이 제품이 제공하는 통제의 전부이고, 그래서 이것이 핵심 기능이다.

현재는 차단된 사용자가 "관리자가 예산을 올리면 약 5분 안에 해제" 안내만 보고 할 수 있는 일이 없다. 관리자가 수동으로 개인 한도를 영구히 올리는 방법뿐이다. 이 설계는 **사용자가 증액을 요청하고, 부서장 또는 admin이 일회성으로 승인하는 흐름**을 두 배포 모두에 추가하고, 두 에디션의 경계를 정리한다.

## 2. 에디션

같은 Terraform, `deployment_mode`로 구분한다 (PR #134에서 구현됨).

| | policy 에디션 (`governance`, 기본) | devEnv 에디션 (`devenv`) |
|---|---|---|
| 배포 | 관리자 대시보드 + 로컬 설치 스크립트 | + 사용자별 EC2 DevEnv |
| 비용 현황, 부서 예산, 사용자 한도, 차단 목록 | O | O |
| **예산 증액 요청·승인** | **O (핵심)** | **O (핵심)** |
| 부서장의 사용자별 한도 관리 | O | O |
| IAM 확장 / 컨테이너 / 티어 / DLP 승인 | X (인스턴스 권한이므로) | O |
| ccdash 연동 (선택) | O | O |

- policy 에디션 승인 화면에는 `budget_increase` 요청만 보인다. PR #136은 `iam_extension`을 governance에서도 남겼으므로, 이 작업에서 governance 모드의 `iam_extension` 표시도 숨긴다 (사용자 결정: IAM 확장은 devEnv 전용).

## 3. 목표 / 비목표 / 반목표

목표
- 사용자가 대시보드에서 기간(일·주·월)·금액·사유를 담아 증액을 요청한다.
- 부서장 또는 admin이 승인한다. **부서 예산을 넘기는 증액은 admin만 승인한다.**
- 승인은 **일회성**: 요청한 기간의 *현재 기간 인스턴스*(오늘 / 이번 ISO 주 / 이번 달)에만 적용되고, 다음 기간에는 원래 한도로 돌아간다.
- 승인 후 차단이 기존 해제 경로(budget-check 5분 주기)로 자동 해제된다.
- 부서장이 자기 부서 사용자의 상시 한도(일·주·월)를 직접 관리한다 (증액 승인과 별개).
- ccdash는 선택형 부가 기능으로 연결한다 (§7).

비목표
- LLM gateway, 실시간(5분 미만) 차단.
- 이메일/Slack 개별 알림 (SNS 토픽은 있으나 구독 없음 — 후속).
- CLI에서 증액 요청 (대시보드에서만; CLI는 차단 메시지에 요청 URL을 보여주는 정도는 빌더 재량).
- 부서 총예산을 부서장이 바꾸는 것 (admin 전용 유지).

반목표 (기술적으로 돌아가도 실패로 보는 것)
- 일회성 승인이 영구 한도를 바꿔 버리는 것.
- 부서장이 자기 부서가 아닌 사용자의 요청·한도를 다룰 수 있는 것.
- 승인됐는데 다른 축(토큰 deny, 부서 deny) 때문에 계속 막혀 있고 화면은 "승인됨"만 보여주는 것.
- 상세 텔레메트리 로그를 CloudWatch에 쌓아 비용을 키우는 것 (깊은 관측은 ccdash 몫).

## 4. 현재 상태 (근거)

- 한도 저장: `cc-user-budgets` (PK `user_id`=소문자 email; 구 행은 subdomain 키 가능, `app/api/local/limits/route.ts:138`). 부서: `cc-department-budgets` (`monthlyBudget` 총액 + `perUserDaily/Weekly/MonthlyBudget`). 전역 기본값은 TF 변수 → Lambda env.
- 해석: 기간별로 사용자 값(>0) → 부서 인당 기본값 → 전역 → 무제한 (`lambda/budget-check.py:252-265`, `lib/budget-periods.ts:31-44`). 0 = 상속.
- 집행: `budget-check` 5분 주기, UTC 기준 일/ISO주/월 합산, 초과 시 `cc-bedrock-user-daily-deny`를 `cc-on-bedrock-local-user-{sub}`와 `cc-on-bedrock-task-{sub}`에 부착, 초과가 아니면 매 주기 제거 (`budget-check.py:476-609, 1022-1040`). 부서 월 총액 초과 시 `cc-bedrock-dept-budget-deny` (`:1063-1092`).
- 별도 토큰 축: `token-limit-enforcer`(KST 기준)가 `cc-bedrock-local-token-deny`를 붙이고 limit-reset cron 또는 수동 reset으로만 풀린다. 월 USD 한도 PUT이 `LIMIT#monthly`(floor(usd×66667))를 미러링하지만 **USD 한도를 올려도 토큰 deny는 풀리지 않는다**.
- 일회성/임시 override 개념은 없음.
- 승인 테이블 `cc-on-bedrock-approval-requests` (`REQUEST#{id}`/`META`, GSI `department-status-index` 미사용). 요청 생성 라우트 `api/user/container-request`는 governance에서 통째로 404.
- 승인 권한 `lib/approval-authz.ts`: admin 전부, dept-manager는 자기 부서만. **그러나 `middleware.ts:36-40`이 `/api/admin*`을 admin 그룹 전용으로 막아 부서장은 승인 API에 도달 못 함.**
- 부서 대시보드: `api/dept/route.ts` GET은 비admin의 부서를 **email 도메인에서 유도**(`:44`), POST(승인/거절)는 **부서 검사·pending 검사·적용 없이 status만 바꿈**(`:233-260`).
- ADR-008:124 "dept-manager는 조회만, 예산 변경은 admin 전용".

## 5. 결정된 설계

### 5.1 요청
- 새 요청 유형 `budget_increase`, 승인 테이블 재사용. 필드: `period`(`daily|weekly|monthly`), `periodKey`(요청 시점의 UTC 기간 키: `2026-10-24` / `2026-W43` / `2026-10`), `requestedAmount`(USD, 기존 유효 한도에 **더하는** 금액), `reason`, 요청 시점 스냅샷(`currentSpend`, `effectiveBudget`), `department`(서버가 Cognito `custom:department`에서 채움, 클라이언트 값 불신).
- 생성 라우트는 **두 모드 모두** 동작하는 새 사용자 라우트 (devenv 전용 `container-request`와 분리).
- 같은 사용자·같은 period·같은 periodKey에 pending 요청은 1건만.
- 진입점: `/local` 차단 배너와 한도 근접(80%) 표시에 "증액 요청" 버튼, governance 사용자 포털(LocalSetup 화면)과 devEnv 사용자 포털에 요청 이력/상태.

### 5.2 승인 권한
- admin: 모든 요청.
- 부서장: 자기 부서(`custom:department`) 요청만, 그리고 **부서 예산을 넘지 않는 경우만**.
- "부서 예산을 넘는다"의 정의 (내 판단): 부서 `monthlyBudget`이 설정(>0)돼 있고, `부서 월 누적 지출 + 이번 달 이미 승인된 부서 내 일회성 증액 합 + 승인 금액 > monthlyBudget`. 부서 총액 미설정(0)이면 부서 한도 없음 → 부서장 승인 가능. 부서장 화면에서는 이런 요청을 "admin 승인 필요"로 표시하고 버튼을 비활성화하며, 서버도 같은 검사를 강제한다.
- **자기 승인 금지 (결정).**
  - 아무도 본인 요청을 승인하거나 거절할 수 없다.
  - 부서장 본인의 요청은 admin만 처리한다.
  - admin 본인의 요청은 다른 admin이 처리한다. admin이 한 명뿐이면 증액 요청 대신 본인 한도를 직접 바꾼다. 이 경우도 감사 기록에 남긴다 (내 판단).
  - 서버는 `approver.email != request.requester`를 강제한다.
- 기간이 끝난 pending 요청은 "만료"로 표시하고 승인할 수 없다 (내 판단).
- 승인자는 금액을 줄여 승인할 수 있다 (늘리는 것도 허용하되 같은 권한 검사 적용). 거절 시 사유 입력.
- 부서장 접근 경로: 승인/부서 API를 `/api/admin*` 밖의 승인자용 경로로 두거나 middleware에서 승인자 그룹을 허용한다 (방식은 빌더 재량). 기존 `api/dept` POST의 권한 누락과 email 도메인 기반 부서 유도는 이 작업에서 함께 고친다 (보안 결함).

### 5.3 일회성 적용 (grant)
- 승인 시 `cc-user-budgets` 해당 사용자 행에 기간별 grant를 기록한다: 예) `dailyGrant = {periodKey, amount}`. 같은 periodKey에 추가 승인되면 amount를 합산, periodKey가 다르면 덮어쓴다 (조건부 업데이트로 경쟁 방지).
- budget-check: 기간 유효 한도 = 기존 해석 결과 + (grant.periodKey == 현재 periodKey ? grant.amount : 0). 기간이 바뀌면 자연히 0 → 원래 한도. 별도 만료 작업 불필요.
- **상위 기간 연쇄 (결정: A).** 지출은 일·주·월 합계에 동시에 쌓인다. 그래서 짧은 기간의 증액은 그 기간을 포함하는 긴 기간에도 같은 금액을 더한다.
  - 일 증액은 그날이 속한 주와 월에도 더한다.
  - 주 증액은 승인 시점의 월에도 더한다.
  - 월 증액은 월에만 더한다.
  - 예: 10-24에 일 +$20을 승인하면 `dailyGrant{2026-10-24}`, `weeklyGrant{2026-W43}`, `monthlyGrant{2026-10}`에 각각 +$20이 들어간다.
  - 각 기간의 periodKey는 그날을 기준으로 UTC로 계산한다. 주가 월 경계를 넘어도 그날이 속한 월에 더한다.
  - 세 갱신은 한 번의 원자적 업데이트로 처리한다.
  - 연쇄 대상 기간이 무제한이면 그 기간은 건너뛴다.
  - 부서 예산 초과 판정(§5.2)과 감사 기록에서는 승인 금액을 **한 번만** 센다. 연쇄된 사본은 합산하지 않는다.
- 기존 해석이 "무제한"인 기간에는 증액 요청 자체를 막는다 (차단될 수 없음).
- 승인 후 최대 5분 내 기존 release 경로로 USD deny가 풀린다. 승인 응답과 화면은 "최대 5분 내 해제"를 표시.
- 대시보드 표시(`lib/budget-periods.ts` 미러 포함)도 같은 계산을 써서 "기본 한도 $X + 오늘 증액 $Y"로 보여준다.
- 부서 월 총액 deny가 원인이면 개인 grant로는 풀리지 않는다 → 요청 화면에서 차단 원인을 구분해 "부서 예산 초과 — admin만 해제 가능"을 표시하고, admin 승인 화면에서 부서 총액 상향을 안내한다.

### 5.4 토큰 축 (내 판단)
- 증액은 USD 축이 기준이다. 승인된 grant가 있는 기간에 같은 사용자의 토큰 deny(`DENY#active`)가 걸려 있으면, 승인 처리 시 기존 수동 reset 경로(`api/admin/limits/reset`의 로직)로 해당 기간 토큰 카운터/deny를 해제한다. 월 grant는 `LIMIT#monthly` 미러에도 같은 비율로 반영하되 일회성(기간 키 포함)으로 기록한다. 토큰 축 처리 방식의 세부(미러 갱신 vs reset)는 빌더 재량이지만 반목표("승인됐는데 계속 막힘")를 위반하면 안 된다.

### 5.5 부서장의 사용자별 상시 한도 관리
- 부서 대시보드에서 부서장이 **자기 부서 구성원**의 일·주·월 상시 한도를 설정/해제(0=상속)한다. 부서 총액과 부서 인당 기본값은 admin 전용 유지.
- 서버 검사: 대상 사용자의 부서 == 부서장 부서. 부서 총액이 설정돼 있으면 개인 월 한도는 부서 총액을 넘을 수 없다 (내 판단). 부서장은 **본인 한도를 바꿀 수 없다** (결정). 부서장 본인 한도는 admin만 바꾼다.
- 이는 ADR-008:124 결정을 바꾸므로 **ADR-008 개정 + BASELINE §2/§3 갱신**을 같은 PR에서 한다 (새 ADR 아님).

### 5.6 감사와 가시성
- 모든 승인/거절/한도 변경은 승인 테이블 또는 기존 감사 로그에 승인자·전후 값·시각을 남긴다.
- 사이드바 승인 메뉴에 pending 건수 배지. 부서장에게도 승인 메뉴 노출 (자기 부서만).
- 차단 목록: admin 예산 화면과 부서 대시보드에 "현재 차단 사용자(원인: 개인 일/주/월, 부서 총액, 토큰)"와 활성 grant 표시.

### 5.7 역할 = Cognito 그룹 (필수), 관리자 페이지에서 지정
- 역할의 정본은 Cognito 그룹 `admin` / `dept-manager` / `user` 하나뿐이다 (`terraform/modules/security/main.tf:212-228`). 권한 판단은 모두 `cognito:groups`에서 나온다 (`lib/auth.ts:108,135,148-149`). 커스텀 속성이나 DynamoDB에 역할을 따로 두지 않는다.
- **모든 사용자는 역할 그룹을 정확히 하나 가져야 한다 (필수 제약).** 그룹이 없거나 둘 이상인 상태는 허용하지 않는다.
- `dept-manager`는 `custom:department`가 비어 있으면 지정할 수 없다. 서버가 거부한다 (기존 fail-closed와 일치).
- 관리자 페이지 (두 에디션 공통):
  - 사용자 생성 폼에 역할 선택이 필수 항목으로 들어간다. 지금은 항상 `user`로 고정돼 있다 (`lib/aws-clients.ts:176-183`).
  - 사용자 목록에 역할 열이 생기고, 편집 화면에서 역할을 바꿀 수 있다.
  - 저장하면 서버가 Cognito에 바로 반영한다. 새 그룹에 `AdminAddUserToGroup`을 하고, 나머지 역할 그룹은 `AdminRemoveUserFromGroup`으로 뺀다. 결과는 항상 그룹 하나가 된다.
  - 기존 `user-role-provisioner`는 이 두 API의 CloudTrail 이벤트로 `custom:dept_manager_sub`를 갱신한다 (`lambda/user-role-provisioner.py:794-800`). 그래서 같은 API를 쓰면 부서장 지정이 부서원에게 자동으로 전파된다.
  - 대시보드 IAM 정책에 `cognito-idp:AdminRemoveUserFromGroup`과 `AdminUserGlobalSignOut`을 추가한다. 현재 정책에는 없다 (`security/main.tf:543-558`).
- 역할 변경 권한은 admin만 가진다. 부서장은 역할을 바꿀 수 없다.
- admin은 자기 자신을 강등할 수 없고, 마지막 admin은 제거할 수 없다 (내 판단).
- 적용 시점: 그룹은 로그인할 때 세션 JWT에 고정되고, 세션은 8시간 유지된다 (`lib/auth.ts:166-167`).
  - 역할을 바꾸면 `AdminUserGlobalSignOut`을 호출하고, 화면에 "다음 로그인부터 적용"이라고 표시한다.
  - 권한을 회수할 때는 세션이 남아 있어도 바로 막아야 한다. 그래서 승인, 한도 변경, 역할 변경 같은 특권 쓰기 API는 `AdminListGroupsForUser`로 현재 그룹을 다시 확인한다 (내 판단).
- 기존 사용자 정리:
  - 그룹이 없는 사용자는 최소 권한인 `user`로 간주한다.
  - 그룹이 여러 개인 사용자는 관리자 페이지에서 "역할 정리 필요"로 표시하고, admin이 저장하면 그룹 하나로 정규화된다.
  - 자동 일괄 변경은 하지 않는다 (내 판단).
- 이 제약은 앱 내 관리자 가이드(`app/docs/admin-guide`)와 `shared/nextjs-app/CLAUDE.md`에도 적는다.

## 6. 제약
- 역할은 Cognito 그룹(`admin`/`dept-manager`/`user`)에서만 나오며, 사용자마다 정확히 하나가 필수다. 역할 지정·변경은 관리자 페이지에서 admin만 할 수 있고, 저장 즉시 Cognito 그룹에 반영된다 (§5.7).
- Terraform 단일 IaC. 새 테이블보다 기존 `cc-user-budgets`/승인 테이블 확장 우선 (새 리소스가 필요하면 TF로).
- 집계 기간은 budget-check 기준 **UTC**. periodKey도 UTC로 계산 (토큰 축 KST와 혼동 금지 — 화면에 기준 시간대 표기).
- budget-check의 fail-closed 동작(스캔 100페이지 초과 시 해제 생략)을 유지한다.
- 보안: 요청자 식별·부서는 서버 세션/Cognito에서만. Cognito 사용자 쓰기 속성 제한(PR #136)이 전제.
- devEnv 모드 동작은 승인 메뉴·포털 외에는 바뀌지 않는다.

## 7. ccdash 연동 (선택, 부가 기능)
- ccdash(`Atom-oh/claude-code-usage-dashboard`)는 별도 저장소·별도 배포. cc는 배포하지 않는다.
- **ccdash 저장소는 수정하지 않는다** (사용자 결정). cc 쪽에서만 연결한다.
- ccdash 수집 구조 (확인됨, ccdash `main` d039ea1 기준):
  - 사용자 PC마다 ccdash 전용 수집기가 로컬(127.0.0.1:4317 gRPC / 4318 HTTP)에서 받는다 (`collector-config.yaml:21-29`).
  - 수집기는 기기별 토큰(`Authorization: Bearer ccd1.…`, 30일 만료)으로 ccdash `/api/ingest/v1/*`에 보낸다 (`dashboard/server/collectorRoutes.js:10,180-181`). 토큰은 ccdash `/collector` SSO 화면에서 발급한다.
  - ccdash 설치 스크립트가 Claude Code `settings.json` env와 Codex `config.toml [otel]`을 직접 쓰고, 다른 OTLP 설정이 있으면 거부한다 (`scripts/configure-client-telemetry.py:14-40,79-81,113-118`).
  - 사용자 식별은 `user.email` 리소스 속성뿐이며(자기 신고), 수집기 allowlist가 부서 같은 커스텀 속성을 버린다 (`collector-config.yaml:153`). 부서·예산 개념은 없다.
- 그래서 cc는 **텔레메트리 설정을 쓰지 않는다**. ccdash 설치는 ccdash 자체 설치 스크립트 몫이다. cc 설치 스크립트가 OTLP 주소를 넣으면 인증이 없어 거부되고 ccdash 설치와 충돌한다.
- cc Terraform 선택 변수 1개 (내 판단): `ccdash_url`. 설정 시:
  - 대시보드 사이드바에 "상세 관측 (ccdash)" 외부 링크.
  - 로컬 설치 화면(LocalSetup)과 `/local`에 "ccdash 수집기 설치" 안내 + `{ccdash_url}/collector` 링크, 그리고 Cognito 로그인 이메일을 `user.email` 값으로 미리 보여 준다 (ccdash 사용자 구분과 cc 비용 데이터를 같은 이메일로 맞추기 위해). cc는 이 값을 사용자 PC에 쓰지 않는다.
  - 미설정 시 링크·안내 모두 숨김.
- 기존 cc 자체 `LOCAL_OTEL_EXPORTER_OTLP_ENDPOINT` 경로(`app/api/install/route.ts:68,117-122`)는 손대지 않는다 (TF가 값을 넣지 않으므로 기본 비활성).
- 비용 통제(차단·증액)는 ccdash에 의존하지 않는다. ccdash가 없어도 cc 기능은 100% 동작.
- 텔레메트리를 CloudWatch Logs로 보내지 않는다.

## 8. 빌더에게 맡기는 것
- API 경로/이름, 컴포넌트 구조, 승인자용 라우트 배치 방식.
- grant 필드의 정확한 DynamoDB 표현(맵 vs 평면 속성).
- 요청 폼 UX(금액 프리셋 등), 배지 구현.
- 토큰 축 해제의 구체 메커니즘(§5.4 범위 안에서).
- 테스트 구성 (budget-check grant 계산과 상위 기간 연쇄, 권한 검사(자기 승인 금지·역할 그룹 하나), 부서 예산 초과 판정은 단위 테스트 필수).
