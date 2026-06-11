# IAM 권한신청 UI (커스텀 문장) + 읽기 와일드카드 허용 — 설계 (Spec)

- **작성일**: 2026-06-11
- **상태**: Approved (brainstorming) → writing-plans 대기
- **대상**: ADR-026 (admin-delegated resource-specific IAM grants) **T8 — request UI 마이그레이션** (백엔드 T1–T7 완료)
- **브랜치**: `feat/iam-request-ui` (off origin/main `7d15696`, #56 merged)

---

## 1. 목적 / 문제

ADR-026 백엔드는 사용자가 **resource-specific 커스텀 IAM 문장**(`{Action[], Resource[]}`)을 신청하면 검증(`validateIamRequest`: `*`·서비스 와일드카드·위험액션·교차계정 거부, allowlist 한정)하고, 관리자가 승인하면 task+local 롤에 grant 한다. 승인자 UI(`admin/approvals`)도 `statements`+LLM 위험주석(`llmNote`)을 표시·grant 완료.

**그러나 사용자 신청 UI(`settings-tab.tsx` `IamRequestSection`)는 여전히 프리셋 `POLICY_SETS` 객관식만 제공**한다 — `container-request` API 주석이 명시: *"Legacy policySets kept until the request UI (T8) is migrated."* 즉 백엔드 능력의 절반만 노출된 미완성 상태.

추가로, 현재 검증기는 **모든 와일드카드 액션을 거부**(`op.includes("*")` → reject)하여, 저위험 읽기 작업(`s3:Get*`, `ec2:Describe*`)도 일일이 나열해야 한다.

## 2. 목표
1. 사용자 신청 UI를 **구조화 커스텀 문장 폼**으로 교체(프리셋 제거).
2. 검증기에 **읽기 전용 와일드카드 허용** 규칙 추가.

## 3. 핵심 결정
| # | 결정 |
|---|------|
| D1 | 입력 UX = **구조화 폼** (service 드롭다운 → actions → resource ARN, statement 반복). raw JSON·프리셋 아님 |
| D2 | **프리셋(POLICY_SETS) UI 제거** — 커스텀 폼만. (policySets API 분기는 backward-compat로 유지하되 UI가 안 보냄) |
| D3 | **읽기 와일드카드 허용**: `Get* / List* / Describe* / BatchGet* / Query* / Scan*` 접두 |
| D4 | 승인자 UI 변경 없음 (이미 statements/llmNote 표시·grant) |

---

## 4. 검증기 변경 (`shared/nextjs-app/src/lib/iam-request-validation.ts`)

### 4.1 읽기 와일드카드 허용
현재 (거부):
```ts
if (op.includes("*") || op.includes("?")) {
  errors.push(`wildcard not allowed in action: ${action}`);
  continue;
}
```
변경:
```ts
const READ_WILDCARD_PREFIXES = ["Get", "List", "Describe", "BatchGet", "Query", "Scan"];

function isReadWildcardOp(op: string): boolean {
  if (op.includes("?")) return false;          // '?' 글롭 금지
  if (!op.endsWith("*")) return false;          // 단일 후행 '*'만
  const stem = op.slice(0, -1);
  if (stem.includes("*")) return false;         // 임베디드 '*' 금지 (Put*Policy 류 차단)
  return READ_WILDCARD_PREFIXES.some((p) => stem === p || stem.startsWith(p));
}
```
거부 블록을 교체:
```ts
if (op.includes("*") || op.includes("?")) {
  if (!isReadWildcardOp(op)) {
    errors.push(`wildcard not allowed in action (read-only Get*/List*/Describe*/BatchGet*/Query*/Scan* only): ${action}`);
    continue;
  }
  // 읽기 와일드카드 — 아래 allowlist + dangerous 검사를 그대로 통과해야 함 (continue 안 함)
}
```
→ 읽기 와일드카드도 **allowlist·dangerous denylist 검사를 계속 받음**(예: `iam:Get*`은 allowlist 밖이라 거부, `*ResourcePolicy` 류는 dangerous로 거부). 쓰기/변경 와일드카드(`Put*`/`Delete*`/`Create*`/`Update*`/`*Policy*`)·전체 `s3:*`·`*`는 계속 거부.

### 4.2 읽기 와일드카드의 Resource:* 허용
List/Describe류는 resource-level 스코핑이 불가한 경우가 많으므로, `allActionsWildcardOk` 판정에 **읽기 와일드카드 op도 포함**:
```ts
const allActionsWildcardOk = actions.length > 0 &&
  actions.every((a) => actionMatchesAny(a, opts.wildcardOkActions) || isReadWildcardOp(a.split(":")[1] ?? ""));
```
→ 모든 액션이 읽기 와일드카드(또는 기존 wildcardOk)면 `Resource:"*"` 허용. 쓰기 액션이 섞이면 불가(기존대로).

### 4.3 테스트 (`iam-request-validation.test.ts` 확장)
- 허용: `s3:Get*`, `s3:List*`, `dynamodb:Query*`, `dynamodb:Scan*`, `dynamodb:BatchGet*`, `ec2:Describe*` (allowlist 내)
- 거부: `s3:*`, `s3:Put*`, `s3:Delete*`, `s3:*Object`, `iam:Get*`(allowlist 밖), `s3:Get*Policy*`(임베디드 `*`), `s3:Get?`(글롭)
- Resource:*: `[s3:List*]`+`Resource:*` 허용, `[s3:Get*, s3:PutObject]`+`Resource:*` 거부

---

## 5. 사용자 UI (`shared/nextjs-app/src/components/user/settings-tab.tsx`)

### 5.1 IamRequestSection 재작성
- **POLICY_SETS 프리셋 UI 제거.**
- 상태: `statements: { service: string; actions: string[]; resources: string[] }[]` + `reason`.
- **구조화 폼** (statement 반복):
  - `service` — `<select>` (DEFAULT_SERVICE_ALLOWLIST 9종) → allowlist 강제.
  - `actions` — 칩/멀티입력. 입력 시 `service:` prefix 자동 결합(사용자는 `GetObject`/`Get*` 만 입력). 읽기 와일드카드 힌트.
  - `resources` — ARN 입력 N개(+추가). placeholder 예시(`arn:aws:s3:::bucket/prefix/*`). 읽기 액션만일 때 "Resource: * 가능" 토글.
  - statement 추가/삭제.
- 제출: `POST /api/user/container-request { type:"iam_extension", statements: [{Action: [`${service}:${op}`...], Resource: [...], Sid?}], reason }`.

### 5.2 클라이언트 인라인 검증 (검증기 규칙 재사용)
`validateIamRequest`를 클라이언트에서 import해 제출 전 검증 + 필드별 오류 표시:
- `*`/`s3:*`/쓰기 와일드카드 → 즉시 에러(빨강), 제출 차단.
- 비-allowlist service → 드롭다운으로 원천 차단.
- `Resource:*`는 읽기 전용일 때만 허용 안내.
- 교차계정/교차리전 ARN 경고 — 단 클라이언트는 accountId/region을 모를 수 있으므로 서버 최종 검증에 위임(클라이언트는 형식·와일드카드·allowlist만 강하게).
- 서버 400(`details: errors[]`) 응답을 폼에 매핑 표시.

> 검증 코어는 단일 출처(`iam-request-validation.ts`) — 클라이언트·서버가 동일 함수 사용해 drift 방지.

---

## 6. 승인자 UI / 백엔드 — 변경 없음
`admin/approvals/page.tsx`(statements+llmNote 표시), `approval-requests` API(grant), `container-request` API(검증·annotate)는 완료 상태. 본 작업은 신청 UI + 검증기 규칙만.

## 7. 변경 파일
| 파일 | 변경 |
|---|---|
| `shared/nextjs-app/src/lib/iam-request-validation.ts` | 읽기 와일드카드 허용(`isReadWildcardOp`) + Resource:* 연계 |
| `shared/nextjs-app/src/lib/__tests__/iam-request-validation.test.ts` | read-wildcard allow/deny 매트릭스 |
| `shared/nextjs-app/src/components/user/settings-tab.tsx` | IamRequestSection 재작성(프리셋 제거, 구조화 폼, 인라인 검증) |
| `docs/decisions/ADR-026-iam-permission-grant-boundary.md` | T8 완료 + 읽기-와일드카드 규칙 명시 |
| `shared/nextjs-app/CLAUDE.md` | settings-tab IAM 신청 = 커스텀 문장 폼 |

## 8. 비범위 (YAGNI)
- 백엔드 grant/validation 코어(완료), 승인자 UI(완료), policySets API 분기(유지·미사용), POLICY_SETS 상수 제거는 UI 한정(상수는 남겨도 무방하나 미참조 시 제거 가능).
- service allowlist 확장, 부분 ARN 빌더, 정책 시뮬레이션.

## 9. 테스트 전략
- **validation** (vitest): §4.3 매트릭스 + 기존 테스트 유지(회귀).
- **UI**: tsc 통과 + (가능 시) 폼 제출 payload 형태 테스트(`statements` 구조).
- **수동**: 신청 → 관리자 승인 화면에 statements+llmNote 표시 확인(이미 동작), 읽기 와일드카드(`s3:Get*`) 신청 통과 / `s3:*` 거부.

## 10. 보안 고려
- 읽기 와일드카드는 **List/Get/Describe류 비변조 작업**으로 한정 + dangerous denylist·allowlist를 여전히 통과해야 함 → 노출 위험만 소폭 증가(변조·권한상승 불가).
- 단일 검증 출처(클라이언트=서버) — 클라이언트 우회해도 서버가 최종 거부(fail-closed, AWS_ACCOUNT_ID 필수).
