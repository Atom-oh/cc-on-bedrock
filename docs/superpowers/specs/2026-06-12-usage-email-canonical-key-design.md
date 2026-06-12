# usage key=email · IAM 롤명=subdomain · sub 제거 (ADR-025 supersede) — 설계 (Spec, B′)

- **작성일**: 2026-06-12 · **개정**: P2 게이트 6 CRITICAL+MAJOR 반영 → **B′ 전환**(패널 2/3 수렴: sub 전면 제거, Local 롤 sub→subdomain, 롤 재생성 승인)
- **상태**: Approved (brainstorming) → writing-plans 대기
- **신규 ADR**: **ADR-029** (ADR-025 supersede)
- **브랜치**: `feat/usage-email-key` (off origin/main `64fde66`)

---

## 1. 문제 (진단 확정)
ADR-025 canonical=sub. 운영 진단: 트래커 EC2 경로 `_resolve_sub_from_subdomain`이 **Cognito 미지원 custom:subdomain 필터** → 항상 실패 → `USER#{subdomain}` fallback. Local만 `USER#{sub}`. 동일인 분할 + `token-limit-enforcer`가 PK=sub 가정 → `USER#{subdomain}` 사용량 집행 누락(우회). UUID 가독성 불량.

## 2. 결정 (B′ — sub 전면 제거)
- **canonical 키 = email**(`USER#{email}`), **소문자 정규화**(`email.strip().lower()` — 키 빌더·backfill 전부). 조직상 이메일=고유·재직중 불변.
- **모든 IAM 롤 네이밍 = subdomain**: `task-{subdomain}` **및 `local-user-{subdomain}`**(기존 `local-user-{sub}`에서 변경). subdomain = email local-part의 DNS/IAM-safe 정규화형(`derive_subdomain`)이라 곧 "email id"이며 task롤/DNS/nginx가 이미 사용 → 내부 불일치 해소.
- **sub는 키도 행 속성도 아니다**(전면 제거). usage 행은 `email`·`subdomain`·`department`만. enforcer/budget-check/limit-reset는 행 `subdomain`에서 **두 롤명 모두** 구성; subdomain 없으면 fail-safe skip.
- **전체 email을 롤명에 안 씀**: 64자 한도(prefix 25 + 39자 초과 email 깨짐)·롤↔DNS 불일치·`@`/`.` 파싱 위험. 정규화 local-part(=subdomain)만.
- **Local 롤 충돌가드 신설**: EC2 task 롤에 이미 있는 가드(같은 이름·다른 소유자 → raise)를 Local 롤 provisioning에도 적용(`john.doe@a`·`john_doe@b`→`john-doe` 공유 대신 거부).
- 이메일·subdomain 출처: **인프라 태그**. EC2=인스턴스 태그 `cc:user`/`username`(=email, Dashboard가 전 경로 부착 — 확인됨) + `subdomain` 태그, Local=롤 `email`·`subdomain` 태그(sts-issuer 추가). 쓰기 시점 Cognito 조회 없음.
- **마이그레이션(재생성 승인됨)**: 배포된 `local-user-{sub}` 롤 → 삭제 후 `local-user-{subdomain}` 재생성(trust·inline 정책 복제); sts-issuer AssumeRole 타깃 subdomain 전환. IAM rename 불가 → 신규+구롤삭제.

## 3. 컴포넌트 변경 (전 consumer 열거 — P2 보강)

### 3.1 트래커 `bedrock-usage-tracker.py`
- PK=`USER#{email_lower}`. 깨진 `_resolve_sub_from_subdomain`(custom 필터)·subdomain fallback·`_sub_cache`·sub 관련 코드 **전면 제거**.
- **EC2 경로**: describe-instances(이미 dept 조회에 사용)로 `cc:user`/`username` 태그=email + `subdomain` 태그 획득. email 없으면(예외) **레코드 skip+경고**(잘못된 키로 안 씀).
- **Local 경로**: 롤 `email`·`subdomain` 태그 사용. (롤 suffix는 이제 subdomain이므로 그대로 써도 무방하나 **태그 우선**.)
- 행 속성: `email`,`subdomain`,`department` (**sub 없음**).

### 3.2 sts-issuer `sts-issuer.py`
- Local 롤 AssumeRole Tags에 `email`·`subdomain` 추가. AssumeRole **타깃 롤명을 `local-user-{subdomain}`로 전환**(기존 sub 타깃 제거). `_get_limit_status`도 §3.8.

### 3.3 token-limit-enforcer `token-limit-enforcer.py` (Local 집행)
- 한도 조회 `USER#{email}/LIMIT#`. **전환기 dual-read**: email 미스 시 행 `subdomain`으로 구 `USER#{subdomain}/LIMIT#` 및(legacy) sub-키 fallback(backfill 완료 후 제거). 집행 공백 방지(CRITICAL #1).
- Local 롤명은 **행 `subdomain` 속성**에서 `local-user-{subdomain}`. `subdomain` 없으면 **skip+경고**(잘못된 롤 Deny 금지, fail-safe).
- **DENY#active/COUNTER#/WARN#** 키도 email 기준 기록 + `subdomain` 속성 동반(budget-check/limit-reset가 롤명 재구성에 사용).
- 변경 사이트: `_get_user_limit`(123), PK 파싱(159), `_attach_deny`(222 — `role_names=[local-user-{subdomain}]`), 카운터/DENY 쓰기 — **전부 열거·수정**.

### 3.4 budget-check `budget-check.py` (CRITICAL #5 — 집행, audit 아님)
- USD/토큰 한도 초과 시 IAM Deny 부착(EC2 task 롤 + Local 롤). PK→email로, 롤명은 **행 `subdomain` 속성**에서 `task-{subdomain}`·`local-user-{subdomain}` **모두** 구성(현재 `local-user-{user}`=PK-sub 직접은 깨짐; `_subdomain_by_sub` 맵 제거하고 subdomain 직접 사용). **dual-read 전환** 동일 적용.

### 3.5 limits 테이블 + admin/limits API
- PK `USER#{email}/LIMIT#`. CRUD 키·표시 email.

### 3.6 admin/budgets PUT mirror (CRITICAL #4)
- `api/admin/budgets/route.ts:215`가 `cc-on-bedrock-limits` PK=`USER#{id}` 기록(2nd writer). `id`를 email로 정렬 — 안 하면 sub-키 한도를 email enforcer가 못 읽어 cap 무력화.

### 3.7 read consumers (CRITICAL #3 — 누락분 전부)
- `api/local/limits/route.ts`(USER#{sub} 카운터+한도+DENY 읽기) → email + dual-read(subdomain fallback).
- `sts-issuer.py _get_limit_status(sub)`(USER#{sub}/DENY#active) → email + dual-read(토큰 발급 시 limitStatus).
- `api/admin/limits/reset/route.ts`(USER#{sub}/DENY#active) → email.
- `api/usage`, `api/user/usage`, `usage-client.ts`, `cloudwatch-client.ts` → email 집계/표시(+subdomain 라벨).

### 3.8 limit-reset `limit-reset.py` (CRITICAL #2 — 상태머신 consumer, audit 아님)
- DENY#active/COUNTER#/WARN# 스캔·삭제·Deny detach를 email 키로. **detach 롤명은 행 `subdomain`에서 `local-user-{subdomain}`·`task-{subdomain}`** 재구성. backfill이 이들도 re-key(§4).

### 3.9 provisioner `user-role-provisioner.py` (롤명 sub→subdomain — NEW)
- Local 롤 생성 `cc-on-bedrock-local-user-{sub}`(L524) → **`cc-on-bedrock-local-user-{subdomain}`**.
- **충돌가드 신설**: `_ensure_ec2_task_role`의 가드(같은 이름·다른 소유자 태그 → raise)를 Local 롤 생성에도 동일 적용. 롤 태그에 `email`·`subdomain` 기록.
- deprovision 경로(L644 등) 롤명 derivation을 sub→subdomain으로. subdomain 복구 블록은 그대로(롤 태그/Cognito custom:subdomain에서 복구).

## 4. Backfill `scripts/migrate-usage-to-email.py` (+ IAM 롤 재생성)
1. Cognito **ListUsers 전수**(페이지네이션) → `{sub→email_lower, subdomain→email_lower}` (+ `sub→subdomain`).
2. **usage**: `USER#{sub}`·`USER#{subdomain}` → `USER#{email}`. SK 충돌 시 **모든 수치 카운터 ADD**(inputTokens/outputTokens/totalTokens/requests/estimatedCost — totalTokens만 아님, MAJOR).
3. **limits 테이블 전 SK 종류 re-key**: `LIMIT#*`, **`DENY#active`, `COUNTER#*`, `WARN#*`** (CRITICAL #2) → `USER#{email}`로. DENY#active는 활성 deny 보존 + `subdomain` 속성 채움.
4. **IAM 롤 재생성(승인됨)**: 배포된 `cc-on-bedrock-local-user-{sub}` 롤 열거 → 각 sub→subdomain 매핑으로 `cc-on-bedrock-local-user-{subdomain}` **신규 생성(trust·inline 정책 복제)** 후 구롤 삭제. dry-run 기본. (active DENY가 붙은 롤은 신롤에도 동일 Deny 복제해 공백 0.)
5. **검증**: 전 카운터 합계 보존(±0). 미매핑(sub/subdomain→email 미발견) 키·롤 **로그·보존**(삭제 금지).
6. dry-run 기본 + `--apply`.

## 5. Cutover (집행 공백 0 — CRITICAL #1)
1. **enforcer·budget-check·sts-issuer·local-limits·provisioner를 dual-read/dual-name(email→subdomain fallback, 신·구 롤명 모두 조회)로 먼저 배포** — 구·신 키/롤 모두 커버되어 공백 없음.
2. **backfill 실행**(limits/usage/DENY/COUNTER/WARN re-key + 롤 재생성, 배포 직후 자동 — "수동 나중" 금지).
3. backfill 완료 검증 후 **dual-read/dual-name fallback 제거**(후속 PR) — 단순화.
> writer는 1단계부터 email-키 + subdomain-롤명. dual 동작이 전환기 동안 구 sub-키/sub-롤도 읽어 enforcement·AssumeRole 연속성 보장.

## 6. 변경 파일
tracker · sts-issuer · token-limit-enforcer · **budget-check** · limit-reset · **user-role-provisioner(롤명)** · admin/limits · **admin/budgets** · **api/local/limits** · api/usage · api/user/usage · usage-client.ts · cloudwatch-client.ts · `scripts/migrate-usage-to-email.py`(신규, 롤 재생성 포함) · ADR-029(신규)·ADR-025(superseded) · 테스트.

## 7. 비범위
DEPT# 키 불변. 이메일 변경(불변 전제). dual-read/dual-name 제거는 backfill 후 후속. subdomain 개념 자체의 rename(DNS/routing 등 전면)은 비범위 — subdomain은 유지하되 Local 롤명만 정렬.

## 8. 보안
- 한도 집행 키·롤명 변경(HIGH): **dual-read/dual-name 전환 + backfill-first**로 공백 0. enforcer/budget-check는 행 `subdomain` 누락 시 **fail-safe skip**(오롤 Deny 금지).
- **Local 롤 충돌가드**(§3.9): subdomain 충돌 시 공유 대신 provisioning 거부 — privilege-bridging 방지.
- backfill dry-run+전카운터 합계검증+미매핑 보존(무손실); 롤 재생성도 dry-run+active Deny 복제.
- email 소문자 정규화로 대소문자 분할 방지.
- ADR-029 `verification_required: true` → 불변식: (a) usage/limits 신규 쓰기에 `USER#{sub}`/`USER#{subdomain}` 키 부재(email만), (b) 신규 IAM 롤명에 sub-UUID 부재(subdomain만), (c) enforcer/budget-check가 행 subdomain 없을 때 Deny 미부착. CI/테스트로 검증.

## 9. 테스트
- 트래커: EC2(태그 email/subdomain)/Local(롤 email/subdomain) → `USER#{email_lower}`+subdomain 속성(**sub 없음**); email 없으면 skip.
- enforcer/budget-check: email 조회 + dual-read fallback + 행 subdomain으로 `local-user-{subdomain}`/`task-{subdomain}` + subdomain 없으면 skip.
- provisioner: Local 롤 `local-user-{subdomain}` 생성 + 충돌(같은 subdomain·다른 소유자) raise.
- backfill: sub/subdomain→email re-key, 전 SK종류(LIMIT/DENY/COUNTER/WARN), SK충돌 전카운터 ADD, 합계보존, 미매핑 보존; 롤 재생성 dry-run 매핑·active-Deny 복제.
- consumers(local/limits, sts-issuer, admin/budgets) email+dual-read.
- `tests/run-all.sh` green.

---

## 10. P2 Round-2 보강 (추가 CRITICAL/MAJOR)
- **C-R2.1 COUNTER 누적 공백**: dual-read는 LIMIT/DENY 읽기뿐 아니라 **해당 period의 COUNTER를 구 키(sub/subdomain) + email-키 둘 다 합산**해 한도와 비교(전환기). 안 그러면 email-키 카운터가 0부터 시작해 near-limit 사용자가 backfill 전까지 under-count → 우회. (enforcer/budget-check 공통)
- **C-R2.2 상태 레코드 subdomain 속성**: enforcer가 쓰는 `DENY#active`(및 COUNTER#) 레코드에 **`subdomain` 속성 기록**(sub 아님). budget-check/limit-reset는 request context 없이 이 속성으로 IAM 롤명(`task-{subdomain}`/`local-user-{subdomain}`)을 구성·detach. dual-read로 구 키 레코드(legacy)를 만났을 땐 **PK suffix가 곧 식별자**(legacy 레코드는 속성 부재 가능 → PK에서 추출).
- **M-R2.3 cc-user-budgets backfill**: 관리자 명시 USD 예산이 `cc-user-budgets`(user_id=sub)로 저장됨 → backfill에 **`USER#{sub}`→`USER#{email}` re-key 포함**. 누락 시 `budget-check._effective_user_budget(email)` 미스 → 명시 cap이 dept/global로 fallback.
- **M-R2.4 budget-flag sub 필터**: `budget-check.set_cognito_budget_flag`이 `Filter='sub="{user}"'` — email PK면 매칭 0 → `custom:budget_exceeded` 미설정/미해제. **email 필터로 수정**(`Filter='email="{email}"'`; sub 제거 방침과 정합).
- **M-R2.5 lowercase 전역**: 소문자 정규화를 키 빌더뿐 아니라 **모든 email 비교**에 적용 — `budget-check._is_valid_user`/`_load_valid_user_keys`, `api/admin/budgets` GET `validUserKeys`. 안 하면 혼합대소문자 email이 `USER#{email.lower()}` PK와 불일치 → row SKIP(spend 유실·deny 미해제).
- **M-R2.6 legacy 스크립트**: `scripts/cleanup-stale-budget-users.py`, `scripts/reconcile-iam-grants-to-local.py`가 PK=sub 가정 → 점검·정렬.
- **MINOR LIMIT# 충돌 정책**: backfill에서 **ADD는 COUNTER#/usage 수치 카운터에만**. `LIMIT#`/`DENY#active`는 합산 아님 — email-키(신규) 우선(prefer-new), 없으면 구 키 이관.
- **MINOR CloudWatch**: 트래커 메트릭 차원 sub→email 변경 시 historical series 단절 — `cloudwatch-client.ts`/문서에 명시.
- **B′-NEW IAM 롤 재생성**: 배포된 `local-user-{sub}` 롤 재생성(§4.4) — active Deny 복제로 집행 공백 0, dry-run 기본. provisioner Local 롤 충돌가드(§3.9)와 짝.
