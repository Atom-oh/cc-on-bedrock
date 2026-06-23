# Runbook: ADR-025 식별자 cutover (subdomain → Cognito sub)

> **⛔ SUPERSEDED — [ADR-031](../decisions/ADR-031-usage-email-canonical-key.md) (2026-06-14):**
> 이 런북이 기술한 `subdomain → Cognito sub` cutover 는 ADR-031 이 **되돌렸다**(canonical 키 =
> `email`, IAM 롤명 = `{subdomain}`, sub 완전 제거). 이 절차와 `migrate-adr025-usage-to-sub.py` 는
> **실행하지 말 것** — 현재 backfill/네이밍은 ADR-031 을 따른다. 아래 내용은 역사적 기록으로만 보존.

> ⚠️ **이 브랜치는 정적 검증(py_compile/tsc)만 거쳤고 실데이터로 테스트되지 않았습니다.**
> billing/governance 핵심 코드이므로 **반드시 리뷰 + 비프로덕션 테이블 backfill 리허설 + 스테이징**
> 후 배포하세요. **자동 배포 금지.**

ADR: [ADR-025](../decisions/archive/ADR-025-usage-pipeline-canonical-identifier.md)

## 무엇이 바뀌었나 (이 브랜치에 구현됨)
사용량/한도 파이프라인의 PK 를 `USER#{subdomain}` → `USER#{sub}`(Cognito sub) 로 통일.

| 파일 | 변경 |
|------|------|
| `cdk/lib/lambda/bedrock-usage-tracker.py` | `resolve_user_from_arn` → `(sub, subdomain, dept)` 반환. EC2 는 Cognito 로 subdomain→sub 조회(`_resolve_sub_from_subdomain`, 캐시·실패 시 subdomain 폴백), Local 은 역할명 suffix 가 sub. `upsert_usage` PK=`USER#{sub}` + `subdomain` 속성 저장. |
| `cdk/lib/lambda/token-limit-enforcer.py` | `_attach_deny` 가 `cc-on-bedrock-local-user-{sub}` 직접 구성(역할 태그 역인덱스 제거). 카운터·`DENY#active` 는 `USER#{sub}`. |
| `cdk/lib/lambda/budget-check.py` | `_candidate_role_names(sub)` = local(sub 직접) + task(`_subdomain_by_sub` 맵의 subdomain). scans 가 sub→subdomain 맵 채움. `set_cognito_budget_flag` 가 `sub=` 필터(custom 속성 필터 미지원 버그도 수정). token-backup 도 sub 기반. |
| `cdk/lib/lambda/limit-reset.py` | `_detach` 가 `cc-on-bedrock-local-user-{sub}` 직접 구성. |
| `scripts/migrate-adr025-usage-to-sub.py` | usage/limits 테이블 backfill(dry-run 기본). |

**읽기 측은 무변경** — `local/limits`(`USER#{session.user.id}`)·`sts-issuer._get_limit_status(sub)` 는 이미 sub 기반이라 이제 쓰기 측과 정렬됨.

## ⛔ 아직 안 된 surface (리뷰어가 완료해야 함)
1. **admin 한도/예산 UI 키잉** — `admin/limits`·`admin/budgets` 가 한도/예산을 저장할 때 **sub** 를 키로 보내야 enforcer 가 찾는다. 현재 UI 가 subdomain 을 보내면 한도/예산이 매칭 안 됨.
   - `shared/nextjs-app/src/app/api/admin/limits/route.ts` (PK `${entity}#${key}`) + `limit-management.tsx`
   - `shared/nextjs-app/src/app/api/admin/budgets/route.ts` + `cc-user-budgets` `user_id`
2. **대시보드 표시** — usage 행 PK 가 sub(UUID)가 되므로 per-user 그래프/테이블이 UUID 로 보임. 저장된 `subdomain` 속성으로 표시 매핑 필요.
   - `shared/nextjs-app/src/lib/usage-client.ts`, 관련 차트/테이블 컴포넌트
3. **user-budgets 테이블 backfill** — admin 이 per-user 예산을 subdomain 으로 설정했다면 `user_id` 를 sub 로 재키잉(backfill 스크립트의 별도 패스).
4. **`cdk/lib/lambda/iam_role_lookup.py`** — 이제 import 하는 모듈 없음(dead). 삭제 가능.

## 배포 순서 (안전 cutover)
1. **리뷰** — 위 4개 surface 까지 완료/판단.
2. **비프로덕션 리허설** — 테스트 테이블에 backfill 스크립트 `--apply` 후 검증.
3. **Lambda 배포** — tracker/enforcer/budget-check/limit-reset. (EC2 task 경로는 `COGNITO_USER_POOL_ID` 환경변수가 tracker 에 설정돼 있어야 subdomain→sub 조회 가능 — 확인.)
4. **backfill (프로덕션)**:
   ```bash
   # dry-run → 검증
   python3 scripts/migrate-adr025-usage-to-sub.py --user-pool-id <POOL_ID>
   # sub 행 생성(구 행 유지)
   python3 scripts/migrate-adr025-usage-to-sub.py --user-pool-id <POOL_ID> --apply
   # 검증 후 구 subdomain 행 제거
   python3 scripts/migrate-adr025-usage-to-sub.py --user-pool-id <POOL_ID> --apply --delete-old
   ```
5. **검증 (verification_required)**:
   - 동일 유저의 EC2·Local 사용량이 단일 `USER#{sub}` 로 합산되는가
   - `/local` 게이지·한도 상태가 enforcer 기록과 일치하는가
   - 예산 초과 시 EC2 task 역할 + Local 역할 **둘 다** Deny 부착되는가
   - 한도 reset cron 이 Deny 를 정상 detach 하는가

## 전환기 주의
- 배포~backfill 사이 당일분은 일부 `USER#{subdomain}`(구) + `USER#{sub}`(신)로 분리되어 그날 부서 합계가 잠시 어긋날 수 있음. backfill 을 배포 직후 빠르게 수행.
- tracker 의 EC2 sub 조회 실패(Cognito throttle) 시 일시적으로 subdomain 키로 폴백(드롭 방지) — backfill 재실행으로 정리.

## 롤백
- Lambda 4종을 이전 버전으로 되돌리면 다시 subdomain 키로 기록. sub 로 옮긴 행은 남지만 무해(읽기 측이 다시 갈림). 롤백 후 표시 불일치가 재발하므로, 가능하면 forward-fix 권장.
