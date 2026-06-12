# usage canonical key = email (ADR-025 supersede) — 설계 (Spec, P2-hardened)

- **작성일**: 2026-06-12 · **개정**: P2 게이트 6 CRITICAL+MAJOR 반영
- **상태**: Approved (brainstorming) → writing-plans 대기
- **신규 ADR**: **ADR-029** (ADR-025 supersede)
- **브랜치**: `feat/usage-email-key` (off origin/main `64fde66`)

---

## 1. 문제 (진단 확정)
ADR-025 canonical=sub. 운영 진단: 트래커 EC2 경로 `_resolve_sub_from_subdomain`이 **Cognito 미지원 custom:subdomain 필터** → 항상 실패 → `USER#{subdomain}` fallback. Local만 `USER#{sub}`. 동일인 분할 + `token-limit-enforcer`가 PK=sub 가정 → `USER#{subdomain}` 사용량 집행 누락(우회). UUID 가독성 불량.

## 2. 결정
- **canonical 키 = email**(`USER#{email}`), **소문자 정규화**(`email.strip().lower()` — 키 빌더·backfill 전부). 조직상 이메일=고유·재직중 불변.
- **sub·subdomain은 usage 행 속성**으로 보존(enforcer/budget-check가 IAM 롤명 구성에 사용). **IAM 롤 네이밍 불변**(`task-{subdomain}`, `local-user-{sub}`).
- 이메일 출처: **인프라 태그**. EC2=인스턴스 태그 `cc:user`/`username`(Dashboard가 전 경로에서 부착 — 확인됨), Local=롤 `email` 태그(sts-issuer 추가). 쓰기 시점 Cognito 조회 없음.

## 3. 컴포넌트 변경 (전 consumer 열거 — P2 보강)

### 3.1 트래커 `bedrock-usage-tracker.py`
- PK=`USER#{email_lower}`. 깨진 `_resolve_sub_from_subdomain`(custom 필터)·subdomain fallback **제거**.
- **EC2 경로**: describe-instances(이미 dept 조회에 사용)로 `cc:user`/`username` 태그=email 획득. subdomain=tag, sub=선택. email 없으면(예외) **레코드 skip+경고**(잘못된 키로 안 씀).
- **Local 경로**: 롤 `email` 태그 사용, sub=롤 suffix, subdomain=태그.
- 행 속성: `email`,`sub`,`subdomain`,`department`.

### 3.2 sts-issuer `sts-issuer.py`
- Local 롤 AssumeRole Tags에 `email` 추가(payload.email 존재). `_get_limit_status`도 §3.8.

### 3.3 token-limit-enforcer `token-limit-enforcer.py` (Local 집행)
- 한도 조회 `USER#{email}/LIMIT#`. **전환기 dual-read**: email 미스 시 행 `sub` 속성으로 `USER#{sub}/LIMIT#` fallback(backfill 완료 후 제거). 집행 공백 방지(CRITICAL #1).
- Local 롤명은 **행 `sub` 속성**에서 `local-user-{sub}`. `sub` 없으면 **skip+경고**(잘못된 롤 Deny 금지, fail-safe).
- **DENY#active/COUNTER#/WARN#** 키도 email 기준 기록.
- 변경 사이트: `_get_user_limit`(123), PK 파싱(159), `_attach_deny`(223), 카운터/DENY 쓰기 — **전부 열거·수정**.

### 3.4 budget-check `budget-check.py` (CRITICAL #5 — 집행, audit 아님)
- USD/토큰 한도 초과 시 IAM Deny 부착(EC2 task 롤 + Local 롤). PK→email로, 롤명은 **행 sub/subdomain 속성**에서 `task-{subdomain}`·`local-user-{sub}` 구성(현재 `local-user-{user}`=PK 직접은 깨짐). **dual-read 전환** 동일 적용.

### 3.5 limits 테이블 + admin/limits API
- PK `USER#{email}/LIMIT#`. CRUD 키·표시 email.

### 3.6 admin/budgets PUT mirror (CRITICAL #4)
- `api/admin/budgets/route.ts:215`가 `cc-on-bedrock-limits` PK=`USER#{id}` 기록(2nd writer). `id`를 email로 정렬 — 안 하면 sub-키 한도를 email enforcer가 못 읽어 cap 무력화.

### 3.7 read consumers (CRITICAL #3 — 누락분 전부)
- `api/local/limits/route.ts`(USER#{sub} 카운터+한도+DENY 읽기) → email + dual-read.
- `sts-issuer.py _get_limit_status(sub)`(USER#{sub}/DENY#active) → email + dual-read(토큰 발급 시 limitStatus).
- `api/admin/limits/reset/route.ts`(USER#{sub}/DENY#active) → email.
- `api/usage`, `api/user/usage`, `usage-client.ts`, `cloudwatch-client.ts` → email 집계/표시(+subdomain 라벨).

### 3.8 limit-reset `limit-reset.py` (CRITICAL #2 — 상태머신 consumer, audit 아님)
- DENY#active/COUNTER#/WARN# 스캔·삭제·Deny detach를 email 키로. backfill이 이들도 re-key(§4).

## 4. Backfill `scripts/migrate-usage-to-email.py`
1. Cognito **ListUsers 전수**(페이지네이션) → `{sub→email_lower, subdomain→email_lower}`.
2. **usage**: `USER#{sub}`·`USER#{subdomain}` → `USER#{email}`. SK 충돌 시 **모든 수치 카운터 ADD**(inputTokens/outputTokens/totalTokens/requests/estimatedCost — totalTokens만 아님, MAJOR).
3. **limits 테이블 전 SK 종류 re-key**: `LIMIT#*`, **`DENY#active`, `COUNTER#*`, `WARN#*`** (CRITICAL #2) → `USER#{email}`로. DENY#active는 활성 deny 보존.
4. **검증**: 전 카운터 합계 보존(±0). 미매핑(sub/subdomain→email 미발견) 키 **로그·보존**(삭제 금지).
5. dry-run 기본 + `--apply`.

## 5. Cutover (집행 공백 0 — CRITICAL #1)
1. **enforcer·budget-check·sts-issuer·local-limits를 dual-read(email→sub/subdomain fallback)로 먼저 배포** — 구·신 키 모두 조회되어 공백 없음.
2. **backfill 실행**(limits/usage/DENY/COUNTER/WARN re-key, 배포 직후 자동 — "수동 나중" 금지).
3. backfill 완료 검증 후 **dual-read fallback 제거**(후속 PR) — 단순화.
> writer는 1단계부터 email-키. dual-read가 전환기 동안 구 sub-키 한도/deny도 읽어 enforcement 연속성 보장.

## 6. 변경 파일
tracker · sts-issuer · token-limit-enforcer · **budget-check** · limit-reset · admin/limits · **admin/budgets** · **api/local/limits** · api/usage · api/user/usage · usage-client.ts · cloudwatch-client.ts · `scripts/migrate-usage-to-email.py`(신규) · ADR-029(신규)·ADR-025(superseded) · 테스트.

## 7. 비범위
IAM 롤 네이밍 불변. DEPT# 불변. 이메일 변경(불변 전제). dual-read 제거는 backfill 후 후속.

## 8. 보안
- 한도 집행 키 변경(HIGH): **dual-read 전환 + backfill-first**로 공백 0. enforcer/budget-check는 행 sub/subdomain 누락 시 **fail-safe skip**(오롤 Deny 금지).
- backfill dry-run+전카운터 합계검증+미매핑 보존(무손실).
- email 소문자 정규화로 대소문자 분할 방지.
- ADR-029 `verification_required: true` → 불변식: (a) usage/limits 신규 쓰기에 `USER#{sub}`/`USER#{subdomain}` 키 부재, (b) enforcer/budget-check가 행 sub 없을 때 Deny 미부착. CI/테스트로 검증.

## 9. 테스트
- 트래커: EC2(태그 email)/Local(롤 email) → `USER#{email_lower}`+sub/subdomain 속성; email 없으면 skip.
- enforcer/budget-check: email 조회 + dual-read fallback + 행 sub로 롤명 + sub 없으면 skip.
- backfill: sub/subdomain→email re-key, 전 SK종류(LIMIT/DENY/COUNTER/WARN), SK충돌 전카운터 ADD, 합계보존, 미매핑 보존.
- consumers(local/limits, sts-issuer, admin/budgets) email+dual-read.
- `tests/run-all.sh` green.
