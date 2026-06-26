# Per-user OTEL code-activity rollup → DynamoDB (S3 ingestion path)

- **Date:** 2026-06-26
- **Status:** Approved (brainstorming) → ready for implementation plan
- **Owner:** atomoh
- **Related:** ADR-009 (OTel 코드활동 관측), ADR-005 (사용량 집계 · email canonical key), ADR-029 (email key), ADR-008 (예산/제한)

## 1. Problem / Context

OTEL 코드활동 텔레메트리(#94, `feat(otel)`)가 머지됐지만 **사용자별 가시성**이 동작하지 않는다. 도입 목적 자체가 "사용자별(예: `atomoh@example.com`) 생산성 가시성"인데:

- 실배포 경로 = devenv → ADOT collector → **awsemf → CloudWatch `CCOnBedrock/CodeMetrics`** (dept/mode 차원만, raw user 제외). 사용자별 분해 불가.
- emitter(`cc.*` 메트릭 이름 + `cc.user_hash`)와 미배포 rollup(`otel_rollup.py`, `claude_code.*` + `enduser.id` 기대) 사이에 **스키마 드리프트**.
- ADR-009가 per-user rollup 저장소(DynamoDB vs Timestream)를 "후속 단계로 남긴다"고 **deferred** 상태로 둠.

이 spec은 그 deferred 항목을 **active로 전환**하여, OTEL 코드활동을 **사용자(email)별 일일 집계**로 DynamoDB에 적재하는 파이프라인을 정의한다.

## 2. Goal / Non-goals

**Goal (이번 범위 = 데이터 파이프라인):**
- devenv가 방출한 코드활동 이벤트가 → S3 → rollup Lambda → DynamoDB(`cc-on-bedrock-usage`)에 `USER#{email}`별 일일 집계(commits / loc / pushes / sessions / active)로 적재된다.
- **수락 기준:** atomoh가 commit 1회 후 ~1분 내 `USER#atomoh@example.com / PROD#<date>#_` 행에 `commits≥1, loc_added>0`, `ACTIVE#<date>` presence 행이 생성된다(쿼리로 확인 가능).

**Non-goals (후속):**
- 대시보드 UI(사용자별 생산성 뷰). 이번엔 데이터만.
- Timestream.
- GitHub webhook/PR/CI 지표.
- devenv 재프로비저닝(별도 운영 작업 — emitter가 인스턴스에 실제로 설치되는 것은 AMI/install route 경로).

## 3. Decisions (확정)

| # | 결정 | 근거 |
|---|------|------|
| D1 | **저장소 = 기존 DynamoDB `cc-on-bedrock-usage`** | otel_rollup.py가 이미 이 테이블/스키마 대상; 005·대시보드와 동일 테이블 조인; on-demand라 신규 베이스라인 0 |
| D2 | **식별자 = 내부 경로에 raw email(`enduser.id`)** | ADR-029 canonical email 키; 005와 조인. ADR-009의 "별도 daily aggregate by email" 의도와 일치 |
| D3 | **CloudWatch custom-metric 경로(awsemf) 제거 (옵션 Y)** | 대시보드는 DynamoDB를 읽음; dept/mode 추세는 per-user 행에서 합산 가능; CloudWatch custom metric 비용($20~50/월) 회피. 현재 `CCOnBedrock/CodeMetrics`는 소비자 0·데이터 0이라 제거 위험 낮음 |
| D4 | **collector = 단일 파이프라인, `awss3` exporter** | 옵션 Y로 awsemf 제거 → email이 내부 S3로만 흐름(엣지 strip 프로세서 불필요). 단순·저비용 |
| D5 | **rollup Lambda를 `cc.*` 스키마로 재작성** | #94 emitter가 의도적으로 택한 저cardinality 이벤트 이름. consumer를 producer에 맞춘다(반대 아님) |
| D6 | **예산/제한 파이프라인 무손상** | enforcement는 invocation-log→DynamoDB(ADR-005/008)이며 OTEL과 분리. 코드 확인: `token-limit-enforcer.py`(usage Stream), `budget-check.py`(usage table), `bedrock-usage-tracker.py`(`process_invocation_log`). OTEL `CCOnBedrock/CodeMetrics`를 읽는 enforcement 없음 |

## 4. Architecture / Data flow

```
devenv (claude/git wrapper, 5-min heartbeat timer)
  │  OTLP/HTTP  resource attrs: service.name, cc.mode, cc.department, enduser.id=<email>
  ▼
ADOT Collector (ECS, terraform/modules/ec2-devenv — 인라인 OTEL_CONFIG, 단일 metrics 파이프라인)
  processors: [memory_limiter, cumulativetodelta, batch]
  exporters:  [awss3]   → s3://cc-on-bedrock-otel-metrics-raw-<acct>/otlp-metrics/...  (otlp_json)
        │  S3 ObjectCreated
        ▼
  otel-metrics-rollup Lambda (lambda/otel-metrics-rollup.py + otel_rollup.py, cc.* 스키마)
        ▼
  DynamoDB cc-on-bedrock-usage
     PK=USER#{email}
       SK=PROD#{date}#_     ADD commits, loc_added, loc_removed, pushes, sessions, active_seconds
       SK=ACTIVE#{date}     presence (DAU/WAU/MAU), gsi_day_pk/sk
       SK=OTELOBJ#{s3key}   dedup 마커 (TTL 7d)
```

**제거:** awsemf exporter, CloudWatch namespace `CCOnBedrock/CodeMetrics`, EMF 로그그룹 `/cc-on-bedrock/otel/code-metrics`.
**유지(무관):** invocation-log → DynamoDB → 예산/제한 (ADR-005/008).

## 5. Component changes

### 5.1 Emitter — `tools/cc-otel-code-metrics.sh`
- resource attributes에 `enduser.id = $USER_EMAIL` 추가(항상). `cc.user_hash`는 제거(또는 무시) — rollup은 `enduser.id`만 사용.
- 메트릭 방출은 **Sum / delta temporality**로 보장(각 이벤트 1 또는 line count). gauge면 rollup 합산 의미가 달라지므로 Sum(delta)로 고정.
- 메트릭 이름(`cc.git.*`, `cc.claude.*`)은 #94 그대로.

### 5.2 Collector — `terraform/modules/ec2-devenv/main.tf` (인라인 OTEL_CONFIG)
- exporter를 `awsemf` → `awss3`로 교체. `s3uploader.region=${env:AWS_REGION}`, `s3_bucket=${env:OTEL_S3_BUCKET}`, `s3_prefix=otlp-metrics`, `marshaler=otlp_json`.
- collector task role에 `s3:PutObject`(otel_raw 버킷) 추가. 컨테이너 env `OTEL_S3_BUCKET`, `AWS_REGION` 주입.
- 버킷 이름은 cross-module → SSM Parameter 또는 module output으로 ec2-devenv에 전달(CLAUDE.md 규칙: cross-stack export 금지).
- awsemf 관련 IAM(`otel-cloudwatch-export`), 로그그룹 `/cc-on-bedrock/otel/code-metrics` 제거.
- 미사용 `docker/otel-collector/config.yaml`(awss3 standalone)은 이 인라인 config와 정렬 또는 제거(드리프트 해소).

### 5.3 Rollup — `lambda/otel_rollup.py` + `lambda/otel-metrics-rollup.py`
메트릭 이름 상수를 `cc.*`로 재작성:

| 신규 메트릭 | 필드 |
|---|---|
| `cc.git.commits` | commits |
| `cc.git.lines_added` | loc_added (model `_`) |
| `cc.git.lines_deleted` | loc_removed (model `_`) |
| `cc.git.pushes` | **pushes (신규 필드)** |
| `cc.claude.sessions.started` | sessions |
| `cc.claude.active_minutes` | active_seconds (×60 합산) |

- `_PROD_FIELDS` = `loc_added, loc_removed, commits, pushes, sessions, active_seconds` (소스 없는 `prs`/`edit_*` 제거).
- 비용/토큰(M_COST/M_TOKEN, ATTR# 쓰기) **제거** — 비용은 005 권위(D6).
- `normalize_identity`(enduser.id→소문자 email 검증) 유지; 미검증 → `unattributed`(버리지 않음).
- dedup `OTELOBJ#{key}` 마커 유지 + **TTL 7d 속성** 추가.

### 5.4 Terraform — `terraform/modules/usage-tracking/`
- 이미 정의된 `otel_raw` S3 버킷 + rollup Lambda + S3 notification을 **실제 배포**(현재 미적용). Lambda 패키징이 `otel-metrics-rollup.py`(핸들러) + `otel_rollup.py`(모듈) 둘 다 포함하는지 확인.
- rollup Lambda env `USAGE_TABLE_NAME=cc-on-bedrock-usage`, KMS decrypt 권한.
- OTELOBJ# 마커 TTL을 위해 usage 테이블 TTL 속성 설정 확인(기존 TTL 정책과 충돌 없도록).

## 6. Data model (DynamoDB `cc-on-bedrock-usage`)

```
PK = USER#{email}
  SK = PROD#{YYYY-MM-DD}#_   { commits, loc_added, loc_removed, pushes, sessions, active_seconds }  (ADD)
  SK = ACTIVE#{YYYY-MM-DD}   { gsi_day_pk=DAY#{date}, gsi_day_sk=USER#{email} }                      (Put)
  SK = OTELOBJ#{s3key}       { ttl=<epoch+7d> }                                                       (Put, attribute_not_exists guard)
```
- 날짜는 `timeUnixNano` 기준 **UTC**.
- user별 1 `TransactWriteItems`(100-item 한도 회피).

## 7. Edge cases / invariants

1. **식별자 누락·비이메일** → `unattributed`로 격리(데이터 보존, 플래그).
2. **중복/재시도** → `OTELOBJ#` `attribute_not_exists` 가드로 멱등; TTL로 마커 증식 방지.
3. **temporality** — Sum/delta 보장(§5.1); `cumulativetodelta`는 cumulative가 와도 방어.
4. **멀티유저 객체** — collector batch가 여러 user 혼합 → rollup이 user별 그룹·트랜잭션.
5. **active_seconds** = active_minutes 합 × 60 (근사, ADR-009 "Attributed").
6. **비용 비귀속** — rollup은 PROD#/ACTIVE#만, 비용은 005.
7. **부분 실패** — user별 독립 트랜잭션이라 한 user 실패가 다른 user 커밋을 막지 않음.

## 8. Cost (증분, ap-northeast-2)

| 리소스 | 월 비용 |
|---|---|
| S3 (otel_raw PUT+저장, lifecycle 만료) | ~$0.5 |
| Lambda rollup | ~$0 (프리티어 내) |
| DynamoDB on-demand 쓰기/저장 (일별 집계 ADD) | ~$3–7 |
| **합계** | **~$5–10/월** |
| (제거) CloudWatch custom metric | **−$20~50/월 절감** |

배선 레버: collector batch 30→60s(쓰기 절반), OTELOBJ# TTL.

## 9. ADR / docs (anti-drift, 같은 PR)

- **ADR-009 개정** — per-user rollup deferred → active. 결정: 옵션 Y(awss3-only collector), 내부경로 email, DynamoDB 저장, CloudWatch custom-metric 제거. **`docs/decisions/BASELINE.md` §3 동시 갱신**(CLAUDE.md 규칙). 식별자(내부경로 email) 결정이 충분히 무거우면 신규 ADR 분리 가능 — 기본은 ADR-009 개정.
- `docs/architecture.md`(SSOT, pillar 3 코드활동 OTEL) 갱신.
- `lambda/CLAUDE.md`, `terraform/` CLAUDE.md, `docker/` CLAUDE.md(otel-collector config 정렬/제거 시) 갱신.

## 10. Testing

- **pytest** `lambda/__tests__/test_otel_rollup.py` — 신스키마(`cc.*`)로 갱신 + 신규: 이름 매핑(commits/loc/pushes/sessions/active), identity normalize, `unattributed`, dedup 멱등, 멀티유저 그룹핑, temporality(delta sum).
- **collector config 검증** — awss3 exporter 설정 + IAM s3:PutObject 어설션(TF, `tests/unit/test_terraform_*` 스타일).
- **fast gate** `tests/run-all.sh` (vitest + pytest + ADR invariants) green.
- (수동) 배포 후 acceptance(§2): atomoh commit → DynamoDB 행 확인.

## 11. Open items (구현계획에서 확정)
- emitter가 현재 Sum/delta로 방출하는지 실측(JSON 구조 확인) → 아니면 §5.1 수정 범위 확정.
- usage 테이블 TTL 속성명/기존 정책 확인.
- cross-module 버킷명 전달 방식(SSM param vs module output) 택1.
