# usage key=email · IAM 롤명=subdomain · sub 제거 (ADR-025 supersede) — 설계 (Spec, B′)

- **작성일**: 2026-06-12 · **개정**: P2 게이트 6 CRITICAL+MAJOR 반영 → **B′ 전환**(패널 2/3 수렴: sub 전면 제거, Local 롤 sub→subdomain, 롤 재생성 승인)
- **상태**: Approved (brainstorming) → writing-plans 대기
- **신규 ADR**: **ADR-029** (ADR-025 supersede)
- **브랜치**: `feat/usage-email-key` (off origin/main `64fde66`)

---

## 1. 문제 (진단 확정)
ADR-025 canonical=sub. 운영 진단: 트래커 EC2 경로 `_resolve_sub_from_subdomain`이 **Cognito 미지원 custom:subdomain 필터** → 항상 실패 → `USER#{subdomain}` fallback. Local만 `USER#{sub}`. 동일인 분할 + `token-limit-enforcer`가 PK=sub 가정 → `USER#{subdomain}` 사용량 집행 누락(우회). UUID 가독성 불량.

## 2. 결정 (B′ — sub 전면 제거)
> **근거(명시)**: `sub`(UUID)는 가독성이 없어 식별자로 부적합 → 가독성 있는 **email(키) + subdomain(리소스명)** 으로 단일화. **subdomain은 전역 유니크 — 중복 이름 불허**(두 사용자가 같은 subdomain/롤/한도 공유 금지). 충돌 시 provisioner가 suffix disambiguation(`john-doe-2`)으로 유니크 보장, Cognito `custom:subdomain`에 저장.

- **canonical 키 = email**(`USER#{email}`), **소문자 정규화**(`email.strip().lower()` — 키 빌더·backfill 전부). 조직상 이메일=고유·재직중 불변.
- **모든 IAM 롤 네이밍 = subdomain**: `task-{subdomain}` **및 `local-user-{subdomain}`**(기존 `local-user-{sub}`에서 변경). subdomain = email local-part의 DNS/IAM-safe 정규화형(`derive_subdomain`)이라 곧 "email id"이며 task롤/DNS/nginx가 이미 사용 → 내부 불일치 해소.
- **sub는 end-state에서 식별자가 아니다**(완전 제거). usage 행은 `email`·`subdomain`·`department`만(항상 — sub 없음). enforcer/budget-check/limit-reset는 행 `subdomain`에서 신규 롤명 구성; subdomain 없으면 fail-safe skip.
- **전환기 sub 출처 = 사용자별 `USER#{email}/LIMIT#` 레코드의 `sub` 속성**(usage 행 origin에 비의존 — P2-R3-R3 CRITICAL). dual-name-write가 구 롤명 `local-user-{sub}`을 구성할 때 행이 아니라 **이 안정 레코드**에서 sub를 읽는다. backfill(§4)이 기존 전 사용자의 LIMIT# 레코드에 sub를 채움(없으면 default LIMIT# 생성). cleanup PR(§5.6)에서 제거. **신규 사용자는 구 sub-롤이 없으므로 sub 불필요**(subdomain 단일 롤명).
- **전체 email을 롤명에 안 씀**: 64자 한도(prefix 25 + 39자 초과 email 깨짐)·롤↔DNS 불일치·`@`/`.` 파싱 위험. 정규화 local-part(=subdomain)만.
- **Local 롤 충돌가드 신설**: EC2 task 롤에 이미 있는 가드(같은 이름·다른 소유자 → raise)를 Local 롤 provisioning에도 적용(`john.doe@a`·`john_doe@b`→`john-doe` 공유 대신 거부).
- 이메일·subdomain 출처: **인프라 태그**. EC2=인스턴스 태그 `cc:user`/`username`(=email, Dashboard가 전 경로 부착 — 확인됨) + `subdomain` 태그, Local=롤 `email`·`subdomain` 태그(sts-issuer 추가). 쓰기 시점 Cognito 조회 없음.
- **마이그레이션(재생성 승인됨, blue-green — §5)**: 배포된 `local-user-{sub}` 롤 → **먼저 `local-user-{subdomain}` 신규 생성**(전체 구성+active Deny 복제, 구롤 유지) → writer 전환·검증 → **검증 후에만 구롤 삭제**(cleanup PR). IAM rename 불가 → 신규생성+검증후 구롤삭제(즉시삭제 아님 — 집행·AssumeRole 공백 0). sts-issuer AssumeRole 타깃 subdomain 전환(전환기 dual-name).

## 3. 컴포넌트 변경 (전 consumer 열거 — P2 보강)

### 3.1 트래커 `bedrock-usage-tracker.py`
- PK=`USER#{email_lower}`. 깨진 `_resolve_sub_from_subdomain`(custom 필터)·subdomain fallback·`_sub_cache`·sub 관련 코드 **전면 제거**.
- **EC2 경로**: describe-instances(이미 dept 조회에 사용)로 `cc:user`/`username` 태그=email + `subdomain` 태그 획득. email 없으면(예외) **레코드 skip+경고**(잘못된 키로 안 씀).
- **Local 경로**: 롤 `email`·`subdomain` 태그 사용. (구 롤엔 T8이 email/subdomain 태그를 부착해 트래커가 구세션 사용자를 skip하지 않음 — P2-R3-R2.)
- 행 속성: `email`,`subdomain`,`department` (**EC2·Local 공통, sub 없음**). 전환기 sub는 행이 아니라 §3.3대로 LIMIT# 레코드에서 해석(P2-R3-R3 — 하이브리드 사용자 EC2-행이 sub 없어 dual-name 못 만드는 우회 차단).

### 3.2 sts-issuer `sts-issuer.py`
- Local 롤 AssumeRole Tags에 `email`·`subdomain` 추가. **AssumeRole 타깃 dual-name(P2-R3-R2 C2)**: `local-user-{subdomain}` **먼저 시도 → NoSuchEntity/AccessDenied면 `local-user-{sub}` fallback**(payload.sub 존재 시; 전환기 한정, cleanup PR에서 신롤 단일). 신롤은 §5 step2에서 이미 생성돼 있으므로 정상 경로는 subdomain. `_get_limit_status`도 §3.8.

### 3.3 token-limit-enforcer `token-limit-enforcer.py` (Local 집행)
- 한도 조회 `USER#{email}/LIMIT#`. **전환기 dual-read**: email 미스 시 행 `subdomain`으로 구 `USER#{subdomain}/LIMIT#` 및(legacy) sub-키 fallback(backfill 완료 후 제거). 집행 공백 방지(CRITICAL #1).
- **dual-name-write(P2-R3 C1)**: Deny 부착 대상 = `local-user-{행.subdomain}` + (전환기) `local-user-{LIMIT#.sub}` **둘 다**(NoSuchEntity면 해당 이름 skip). **전환기 sub는 usage 행이 아니라 `USER#{email}/LIMIT#` 레코드에서 읽는다**(origin 비의존 — 하이브리드 사용자가 EC2-행으로 트리거돼도 구 Local 롤 Deny 가능, P2-R3-R3). **enforcer는 전환기에 sub 없는 LIMIT#를 auto-create하지 않음**(backfill이 채운 sub를 보존 — 그러면 구 롤 우회, P2-R3-R4 불변식). `subdomain` 없으면 **전체 skip+경고**(fail-safe).
- **owner-tag 검증(P2-R3 M4)**: 부착 전 롤의 `email` 태그가 행 email과 **일치할 때만** 부착 — subdomain 충돌로 타 사용자 롤에 Deny 거는 것 방지.
- **DENY#active/COUNTER#/WARN#** 키도 email 기준 기록 + `subdomain`(+전환기 `sub`) 속성 동반(budget-check/limit-reset가 롤명 재구성에 사용).
- 변경 사이트: `_get_user_limit`(123), PK 파싱(159), `_attach_deny`(222 — `role_names=[local-user-{subdomain}, local-user-{sub}]` 전환기), 카운터/DENY 쓰기 — **전부 열거·수정**.

### 3.4 budget-check `budget-check.py` (CRITICAL #5 — 집행, audit 아님)
- USD/토큰 한도 초과 시 IAM Deny 부착(EC2 task 롤 + Local 롤). PK→email로, 롤명은 **행 `subdomain` 속성**에서 `task-{subdomain}`·`local-user-{subdomain}` + (전환기) `local-user-{sub}` 구성(현재 `local-user-{user}`=PK-sub 직접은 깨짐; `_subdomain_by_sub` 맵 제거하고 subdomain 직접 사용). **dual-read·dual-name·owner-tag 검증**(§3.3) 동일 적용.

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
- DENY#active/COUNTER#/WARN# 스캔·삭제·Deny detach를 email 키로. **detach 롤명은 행 `subdomain`에서 `local-user-{subdomain}`·`task-{subdomain}` + (전환기) `local-user-{sub}`** 재구성(dual-name). backfill이 이들도 re-key(§4).
- **PK-suffix fallback 금지(P2-R3 C3)**: 식별자는 행 `subdomain`(end) / `sub`(전환기) **속성에서만** 얻는다. **email-키 PK의 suffix를 subdomain/롤명으로 절대 쓰지 않음**(suffix=email → `local-user-{email}`은 오롤 → Deny no-op/detach 불가). PK-suffix 추출은 **legacy `USER#{subdomain}` 행에만** 허용(PK가 email 형태(`@` 포함)면 regime=email로 판정해 suffix 사용 안 함). 속성 없고 legacy도 아니면 fail-safe skip.

### 3.9 provisioner `user-role-provisioner.py` (롤명 sub→subdomain — NEW)
- Local 롤 생성 `cc-on-bedrock-local-user-{sub}`(L524) → **`cc-on-bedrock-local-user-{subdomain}`**.
- **subdomain 유니크 보장(disambiguation)**: `derive_subdomain` 후보가 **다른 email 소유자**로 이미 존재하면(롤 태그/Cognito custom:subdomain 조회) **suffix로 유니크 확보**(`john-doe`→`john-doe-2`→…, 30자 한도). 배정값을 `custom:subdomain`에 저장해 결정적 재사용. **중복 이름 0**(공유 금지). 기존 배정 사용자는 그대로.
- 충돌·예외는 클린 에러로 surface(직접-invoke=구조화 에러, Dashboard=명시 메시지) — Lambda 미처리 크래시 금지.
- deprovision 경로(L644 등) 롤명 derivation을 sub→subdomain으로(전환기엔 sub명도 정리 대상). subdomain 복구 블록은 그대로(롤 태그/Cognito **ListUsers-by-username**에서 복구 — 깨진 custom-filter 경로 아님).

## 4. Backfill `scripts/migrate-usage-to-email.py` (+ IAM 롤 생성, blue-green)
1. Cognito **ListUsers 전수**(페이지네이션) → `{sub→email_lower, subdomain→email_lower, sub→subdomain}`. **`subdomain→owners` 사전계산**: 동일 subdomain에 둘 이상 email이 매핑되면 **충돌**(P2-R3 M4) — 해당 사용자 **abort·로그·admin 알림**(공유 금지, 임의 병합 금지).
2. **usage re-key**: `USER#{sub}`·`USER#{subdomain}` → `USER#{email}`를 **delete-old + put-new**(copy 아님 — 두 PK 동시존재로 dual-read 이중합산 방지, P2-R3 M5/M6). SK 충돌 시 **모든 수치 카운터 ADD**(input/output/total/requests/cost).
3. **limits 테이블 전 SK 종류 re-key**(delete-old+put-new): `LIMIT#*`, `DENY#active`, `COUNTER#*`, `WARN#*` (CRITICAL #2) → `USER#{email}`. COUNTER/usage만 ADD; **LIMIT/DENY/WARN prefer-new(overwrite, ADD 금지)**. **default LIMIT# 생성은 §4.1 Cognito ListUsers 전수 명단 기준**(DynamoDB scan 아님 — 사용/한도 이력 0인데 활성 구세션 보유 사용자도 누락 없이 sub 확보, P2-R3-R4 불변식). 전 사용자 `USER#{email}/LIMIT#`에 전환기 `sub`·`subdomain` 기록. DENY#active는 활성 deny 보존 + `subdomain`(+전환기 `sub`) 속성 채움. cc-user-budgets도 re-key(M-R2.3).
4. **IAM 롤 생성(승인됨, blue-green)**: 배포된 `local-user-{sub}` 열거 → `local-user-{subdomain}` **신규 생성 — 전체 구성 복제**(trust·inline·**managed policies·permissions boundary·tags·path·max-session-duration**, P2-R3 M-codex) + **active Deny 복제** + `email`/`subdomain` 태그. **구롤에도 `email`/`subdomain` 태그 부착**(트래커 skip 방지). **구롤 삭제는 안 함**(§5 cleanup PR로 연기 — 두 이름 동시존재로 enforcement·AssumeRole 공백 0). 충돌 subdomain은 §4.1대로 skip.
5. **migration_done 플래그**: §5 step5(신규 writer **검증 통과 후**) 세팅 → enforcer/budget-check가 COUNTER dual-sum 중단(step3 즉시 아님 — 구키 누락 방지, P2-R3-R2; over-count 방지, P2-R3 M5).
6. **검증**: 전 카운터 합계 보존(±0). 미매핑(sub/subdomain→email 미발견) 키·롤 **로그·보존**(삭제 금지).
7. dry-run 기본 + `--apply`. (구롤 삭제는 별도 cleanup 스크립트/PR, 신규 writer 검증 후.)

## 5. Cutover (집행·AssumeRole 공백 0 — blue-green 롤 마이그레이션, P2-R3 CRITICAL 반영)
**원칙: 신규 롤을 "구롤 삭제 없이" 먼저 만들어 두 이름이 동시 존재하게 한 뒤 writer를 전환한다. 구롤 삭제는 신규 writer 검증 후 cleanup PR에서만.** (writer가 없는 롤에 Deny/AssumeRole 시도하는 창을 원천 제거 — P2-R3 C1/C2.)

1. **provisioner 배포**(T4b): 신규 사용자 → `local-user-{subdomain}` + 충돌가드. (collision은 409로 surface, Lambda 크래시 금지.)
2. **IAM 롤 생성 backfill**(T8-IAM, `--apply`): 배포된 각 `local-user-{sub}`마다 `local-user-{subdomain}`를 **전체 구성 복제**(trust·inline·managed·permissions boundary·tags·path·max-session) + **active Deny 복제** 후 **생성만**(구롤 삭제 안 함). **구 `local-user-{sub}` 롤에도 `email`·`subdomain` 태그 부착**(트래커가 구세션 사용자 skip 방지, P2-R3-R2). `subdomain→owner` 사전계산해 **충돌(동일 subdomain·다른 email) 발견 시 해당 사용자 abort·로그·admin 알림**(공유 금지). 이 시점 모든 사용자가 **두 이름 다 보유** → 어느 enforcer(구=sub명/신=subdomain명)든 부착 성공.
3. **DynamoDB re-key backfill**(T8-DDB, `--apply`): usage/limits/budgets를 `USER#{email}`로 **delete-old + put-new**(copy 아님 — 두 PK 동시존재로 인한 dual-read 이중합산 방지, P2-R3 M5/M6). COUNTER/usage만 ADD, LIMIT/DENY/WARN prefer-new(overwrite). **전 사용자 LIMIT# 레코드에 전환기 `sub`·`subdomain` 기록**(없으면 default 생성 — dual-name sub 출처, P2-R3-R3).
4. **신규 writer 배포**(T1·T3·T4·T7·sts-issuer): email-키 + `local-user-{subdomain}` 타깃 + **dual-name-write/assume**(구 `local-user-{sub}`도 부착/시도, 행 sub 존재 시). 신규 롤이 모두 존재하므로 정상 경로 안전.
5. **검증**: 샘플 사용자 AssumeRole(신롤) + Deny 부착/detach 왕복 + 한도 카운터 합계 일치. **검증 통과 후 `migration_done` 플래그 세팅**(step3 아님 — 구 writer가 step3→4 창에 쓰는 구키 COUNTER를 신 enforcer가 누락하지 않도록, P2-R3-R2). 이후 COUNTER dual-sum 중단.
6. **cleanup PR**(검증 후): 구 `local-user-{sub}` 롤 삭제 + 전환기 코드·상태(dual-read·dual-name·LIMIT#/DENY# 전환기 `sub` 속성·COUNTER dual-sum) 제거.

> **전환기 안전망**: (a) sts-issuer·enforcer·budget-check·limit-reset는 `{subdomain}` 롤 시도 → NoSuchEntity면 `{sub}` 롤 fallback(**dual-name on write/assume**, 구롤이 아직 존재하는 1–6단계 동안). dual-name 구 이름 구성을 위한 전환기 `sub`는 **사용자별 `USER#{email}/LIMIT#`·`DENY#active` 레코드**에서 읽음(usage 행 origin 비의존 — P2-R3-R3; cleanup PR에서 제거). (b) COUNTER dual-sum은 **`migration_done` 플래그로 게이트**(step5 검증 후 set — over-count·구키 누락 방지).

## 6. 변경 파일
tracker · sts-issuer · token-limit-enforcer · **budget-check** · limit-reset · **user-role-provisioner(롤명)** · admin/limits · **admin/budgets** · **api/local/limits** · api/usage · api/user/usage · usage-client.ts · cloudwatch-client.ts · `scripts/migrate-usage-to-email.py`(신규, 롤 재생성 포함) · ADR-029(신규)·ADR-025(superseded) · 테스트.

## 7. 비범위
DEPT# 키 불변. 이메일 변경(불변 전제). dual-read/dual-name 제거는 backfill 후 후속. subdomain 개념 자체의 rename(DNS/routing 등 전면)은 비범위 — subdomain은 유지하되 Local 롤명만 정렬.

## 8. 보안
- 한도 집행 키·롤명 변경(HIGH): **blue-green 롤 마이그레이션(신규 생성→writer 전환→cleanup 삭제) + dual-read/dual-name-write + backfill-first**로 집행·AssumeRole 공백 0(P2-R3 C1/C2). enforcer/budget-check는 행 `subdomain` 누락 시 **fail-safe skip**(오롤 Deny 금지).
- **PK-suffix를 식별자로 쓰지 않음**(P2-R3 C3): email-키 PK suffix=email이라 롤명에 쓰면 우회/락아웃 — 식별자는 속성에서만, suffix는 legacy subdomain-PK에만.
- **owner-tag 검증**(P2-R3 M4): Deny 부착 전 롤 `email` 태그==행 email 확인 — subdomain 충돌 시 타 사용자 롤 오부착 방지.
- **Local 롤 충돌가드**(§3.9): subdomain 충돌 시 공유 대신 provisioning 거부(409 surface, 크래시 금지) + backfill도 충돌 abort — privilege-bridging 방지.
- backfill dry-run+전카운터 합계검증+미매핑 보존(무손실); 롤 생성도 dry-run+전체 구성+active Deny 복제; re-key는 delete+put(이중합산 방지).
- email 소문자 정규화로 대소문자 분할 방지.
- ADR-029 `verification_required: true` → 불변식: (a) usage/limits 신규 쓰기에 `USER#{sub}`/`USER#{subdomain}` 키 부재(email만), (b) 신규 IAM 롤명에 sub-UUID 부재(subdomain만), (c) enforcer/budget-check가 행 subdomain 없을 때 Deny 미부착, (d) end-state(cleanup 후) 행에 `sub` 속성·구 sub-롤 부재. CI/테스트로 검증.

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
