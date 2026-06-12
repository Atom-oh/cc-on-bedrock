# usage canonical key = email (ADR-025 supersede) — 설계 (Spec)

- **작성일**: 2026-06-12
- **상태**: Approved (brainstorming) → writing-plans 대기
- **신규 ADR**: **ADR-029** (ADR-025 "canonical=Cognito sub" supersede). ※ 028은 cognito-trigger-fallback이 선점
- **브랜치**: `feat/usage-email-key` (off origin/main `64fde66`)
- **진단 근거**: 이번 세션 usage 매핑 진단 — `cc-on-bedrock-usage`에 `USER#{sub}`·`USER#{subdomain}` 혼재로 동일인 분할 + 한도 집행 undercount.

---

## 1. 문제 (진단 확정)
ADR-025가 canonical 키를 Cognito sub(UUID)로 정했으나:
1. **혼합 키 공존**: EC2 경로의 `_resolve_sub_from_subdomain`이 `Filter='custom:subdomain=...'`를 쓰는데 **Cognito ListUsers는 custom 속성 필터 미지원 → 항상 실패 → `USER#{subdomain}` fallback**. Local 경로만 `USER#{sub}`. 동일인이 `USER#atomoh`(724K) + `USER#{sub}`(159K)로 분할.
2. **한도 집행 undercount(HIGH)**: `token-limit-enforcer`가 PK를 sub로 가정 → `USER#{subdomain}` 사용량은 존재하지 않는 한도에 조회 → 집행 누락(우회 가능).
3. **가독성**: 대시보드가 UUID 노출.

## 2. 결정
- **canonical 키 = email** (`USER#{email}`). 조직 정책상 이메일=사용자 고유·재직 중 불변(퇴사까지). ADR-025 supersede.
- **sub·subdomain은 키가 아니라 usage 행의 속성으로 보존** — enforcer가 Local 롤명(`cc-on-bedrock-local-user-{sub}`) 구성에 sub 필요. IAM 롤 네이밍은 변경하지 않음(sub 유지).
- 이메일은 **양쪽 writer가 인프라 태그에서 직접 획득** → 쓰기 시점 Cognito 조회 불필요.

## 3. 컴포넌트별 변경

### 3.1 usage 트래커 `cdk/lib/lambda/bedrock-usage-tracker.py`
- PK = `USER#{email}` (SK 불변: `{date}#{model}`).
- **EC2 경로**: 깨진 `_resolve_sub_from_subdomain`(custom 필터) + subdomain fallback **제거**. 이메일은 EC2 인스턴스 태그 `username`(=email) 또는 `cc:user`에서 획득(트래커가 이미 describe-instances로 태그 읽음). sub/subdomain도 태그/조회로 함께 채워 행 속성에 기록.
- **Local 경로**: 롤 태그의 `email` 사용(§3.2). sub는 롤명 suffix.
- 행 속성: `email`(키), `sub`, `subdomain`, `department` 기록.

### 3.2 sts-issuer `cdk/lib/lambda/sts-issuer.py`
- Local 롤 AssumeRole 태그에 **`email` 추가**(payload에 이미 email 존재). 기존 username/department 옆에.

### 3.3 token-limit-enforcer `cdk/lib/lambda/token-limit-enforcer.py`
- 한도 조회 키 `USER#{email}/LIMIT#{period}` (PK에서 email 추출).
- Local 롤명은 **PK가 아니라 usage 행(NewImage)의 `sub` 속성**에서 구성 → email→sub Cognito 조회 불필요. NewImage에 `sub` 없으면(구 데이터) skip + 경고.
- DENY#active / 카운터 키도 email 기준.

### 3.4 limits 테이블 + admin UI `cc-on-bedrock-limits`, `api/admin/limits/route.ts`
- PK `USER#{email}/LIMIT#`. 표시/입력 키를 email로. (DEPT#는 불변.)
- 기존 `USER#{sub}/LIMIT#` → `USER#{email}/LIMIT#` 마이그레이션(§4).

### 3.5 리더 `shared/nextjs-app/src/lib/usage-client.ts` + 대시보드
- PK가 곧 email → 그대로 표시(가독성 해결). 행 속성 `subdomain` 동반 표시.
- 집계는 email 기준 단일 키 → 분할 해소.

### 3.6 limit-reset / budget-check (감사)
- `limit-reset.py`(카운터 리셋·Deny detach): email 키 정렬.
- `budget-check.py`(EC2 backup path): usage 키 소비 시 email 정렬(EC2 모드 영향 점검).

## 4. Backfill (1회 마이그레이션 스크립트 `scripts/migrate-usage-to-email.py`)
1. Cognito **ListUsers 전수 1회**(페이지네이션) → `{sub→email, subdomain→email}` 맵 (custom 필터 불가 → 전수 스캔).
2. **usage**: 각 `USER#{sub}`·`USER#{subdomain}` 행을 `USER#{email}`로 re-key. SK(`date#model`) 충돌 시 토큰 카운터 `ADD` 병합. 원본 행은 검증 후 삭제.
3. **limits**: `USER#{sub}/LIMIT#` → `USER#{email}/LIMIT#`.
4. **검증**: 병합 전후 totalTokens 합계 동일(±0). 매핑 안 되는 키(sub/subdomain→email 미발견)는 로그·보존(삭제 안 함).
5. dry-run 모드(기본) + `--apply`.

## 5. Cutover 순서 (집행 공백 방지)
1. 트래커·enforcer·limits-UI·리더를 **email-키로 동시 배포** (행에 sub 속성 기록 시작).
2. **backfill** 실행(limits 먼저 → usage). 
3. 잔재 sub/subdomain 키 행은 backfill로 흡수, 이후 미생성.
> 동시성: 배포~backfill 사이 신규 쓰기는 이미 email-키이므로 충돌 없음. 구 sub-키 한도 조회는 backfill 전까지 미스 가능(짧은 윈도우) — 배포 직후 backfill 권장.

## 6. 변경 파일
| 파일 | 변경 |
|---|---|
| `cdk/lib/lambda/bedrock-usage-tracker.py` | PK=email, custom-filter/fallback 제거, sub/subdomain 속성 |
| `cdk/lib/lambda/sts-issuer.py` | Local 롤 email 태그 |
| `cdk/lib/lambda/token-limit-enforcer.py` | email 키 조회, 롤명은 행 sub 속성 |
| `cdk/lib/lambda/limit-reset.py` | email 키 |
| `cdk/lib/lambda/budget-check.py` | email 키 정렬(점검) |
| `shared/nextjs-app/src/app/api/admin/limits/route.ts` | email 키 CRUD |
| `shared/nextjs-app/src/lib/usage-client.ts` | email 표시·집계 |
| `scripts/migrate-usage-to-email.py` | **신규** backfill(dry-run/apply) |
| `docs/decisions/ADR-029-usage-email-canonical-key.md` | **신규** (ADR-025 supersede) |
| `docs/decisions/ADR-025-*.md` | superseded 표기 |
| 테스트 | 트래커/enforcer email-키 단위테스트, backfill 병합 테스트 |

## 7. 비범위 (YAGNI)
- **IAM 롤 네이밍 불변**(`...task-{subdomain}`, `...local-user-{sub}`) — usage/limits 키만 email.
- DEPT# 키 불변.
- 이메일 변경 시나리오(조직상 불변 전제 — 변경 발생 시 수동 reconcile).

## 8. 보안 고려
- **한도 집행 키 변경(HIGH 민감)**: backfill·cutover 동시성, enforcer가 행 sub 속성 누락 시 fail-safe(skip+경고, 잘못된 롤에 Deny 금지). 단위테스트로 email-키 조회·롤 타겟 검증.
- backfill은 dry-run 기본 + 합계 검증 + 미매핑 보존(데이터 손실 방지).
- 다른 세션의 ADR-025 코드와 겹침 → 머지 충돌 가능, 신중.

## 9. 테스트 전략
- 트래커: EC2/Local 경로가 `USER#{email}` + sub/subdomain 속성 기록(태그 mock).
- enforcer: `USER#{email}` 한도 조회, 롤명을 행 sub 속성에서 구성, sub 없으면 skip.
- backfill: sub/subdomain→email re-key + SK 충돌 ADD 병합 + 합계 보존(mock DDB).
- `tests/run-all.sh` green.
