# Per-user Claude Code usability rollup via native OTEL (P1: data pipeline)

- **Date:** 2026-06-26 (rewritten — correctness-first native-OTEL pivot)
- **Status:** Approved (brainstorming) → ready for implementation plan
- **Owner:** atomoh
- **Supersedes:** the earlier "option Y / custom cc.* emitter" draft of this file.
- **Related:** ADR-009 (OTel 코드활동 관측), ADR-005 (사용량 집계 · email key — 권위 cost), ADR-029 (email key), ADR-008 (예산/제한). Reference vision: `whchoi98/claude-code-dashboard` (1P Analytics-API based; we replicate its KPIs on Bedrock via OTEL).

## 1. Problem / Context

목표는 참조 대시보드(`whchoi98/claude-code-dashboard`) 수준의 **사용성·생산성 평가 데이터**를 **사용자별로** 확보하는 것이다. 그 참조는 Anthropic 1P **Analytics/Admin/Compliance API**를 쓰지만, 우리는 **Bedrock**이라 그 API가 없다(ADR-009의 전제). 따라서 동일 KPI를 **Claude Code 네이티브 OpenTelemetry + 005 invocation-log**로 재현한다.

**correctness-first (dev 단계):** 비용 최적화보다 정확한 동작·정확한 측정이 우선. #94의 커스텀 `cc.*` shell-wrapper 접근(git/session만, tool/skill/agent 불가)을 **네이티브 `claude_code.*` metrics + `tool_result` 이벤트**로 전환한다.

핵심 제약(claude-code-guide 공식 docs 조사, 2026-06-25):
- skill/agent/tool **사용량은 metric에 없고 OTEL log event(`claude_code.tool_result`)에만** 있다. `OTEL_LOGS_EXPORTER=otlp` + `OTEL_LOG_TOOL_DETAILS=1` 필요 → `tool_parameters.skill_name`(Skill tool)·`subagent_type`(Agent tool).
- `user.email`은 OAuth일 때만 → **Bedrock에선 부재 가능**. 해결: `OTEL_RESOURCE_ATTRIBUTES`로 우리 `USER_EMAIL`을 `enduser.id`로 직접 스탬프(신뢰 가능).
- `OTEL_LOG_TOOL_DETAILS=1`은 bash·파일경로·입력까지 로깅 → **collector에서 scrub**(ADR-009 no-content 유지).

## 2. Goal / Non-goals

**Goal (P1 = 데이터 파이프라인 + KPI 적재):** 네이티브 OTEL(metrics + scrub된 tool 이벤트) → S3 → rollup Lambda → DynamoDB `cc-on-bedrock-usage`에 사용자(email)별 일일 KPI 적재.

**수락 기준:** atomoh devenv에서 네이티브 OTEL을 켜고 Claude로 작업 1회(편집+커밋+스킬/서브에이전트 사용) 후, 1–2분 내:
- `USER#atomoh@example.com / PROD#<date>#<model>` 에 loc/commits/sessions/active/edit_accept 적재
- `SKILL#<date>#<skill_name>`, `AGENT#<date>#<subagent_type>`, `TOOL#<date>#<tool_name>` 카운트 적재
- `ACTIVE#<date>` presence 생성
- CloudWatch/로그 어디에도 bash 명령·파일경로·프롬프트 내용 없음(scrub 검증)

**Non-goals (후속 P2/P3):** Productivity/Economic Score 계산(P2), 7-day 트렌드 read API(P2), AI 진단(`/api/ai` 확장)·대시보드 UI·이메일 마스킹(P3), messages count(user_prompt 이벤트 유도, 후속), audit/compliance(CloudTrail, 후속), devenv 재프로비저닝(운영).

## 3. Decisions

| # | 결정 | 근거 |
|---|------|------|
| D1 | **소스 = Claude Code 네이티브 OTEL** (metrics `claude_code.*` + `tool_result` 이벤트). #94 커스텀 `cc.*` emitter는 productivity 측정에서 은퇴 | 정확도·tool/skill/agent 가시성. 원래 rollup 스키마가 `claude_code.*`였음 |
| D2 | **식별자 = `OTEL_RESOURCE_ATTRIBUTES`로 `enduser.id=<USER_EMAIL 소문자>` 스탬프** (+ `cc.department`, `cc.mode`) | Bedrock에서 native `user.email` 부재 가능. /etc/environment USER_EMAIL은 신뢰 가능. ADR-029 email 키 |
| D3 | **skill/agent/tool 사용량 = `tool_result` 이벤트에서 collector-scrub 후 집계** | metric엔 없음. `OTEL_LOG_TOOL_DETAILS=1` + scrub로 no-content 유지 |
| D4 | **collector = usage-tracking의 기존 ECS collector(:4317)로 통일(Y1)**. devenv를 여기로 repoint, **ecs-devenv awsemf collector 폐기** | 중복 collector 제거. S3 경로(otel_raw+rollup)는 이미 이 collector에 붙어 있음 |
| D5 | **저장소 = 기존 DynamoDB `cc-on-bedrock-usage`** (PROD#/SKILL#/AGENT#/TOOL#/ACTIVE#/OTELOBJ#) | 005·대시보드와 동일 테이블. on-demand |
| D6 | **cost/token은 005(invocation-log)가 권위**, rollup은 productivity/usage만 | ADR-009. 예산/제한(ADR-008) 무손상 |
| D7 | **DLP = collector scrub**: keep skill_name/subagent_type/tool_name/success/duration_ms/enduser.id/session.id; drop bash_command/full_command/file paths/tool input/prompt | ADR-009 counter/no-content 불변식 + skill/agent 측정 양립 |

## 4. Architecture / Data flow

```
Claude Code (devenv) — native OTEL
  env: CLAUDE_CODE_ENABLE_TELEMETRY=1, OTEL_METRICS_EXPORTER=otlp, OTEL_LOGS_EXPORTER=otlp,
       OTEL_LOG_TOOL_DETAILS=1, OTEL_EXPORTER_OTLP_PROTOCOL=grpc,
       OTEL_EXPORTER_OTLP_ENDPOINT=<collector NLB:4317>,
       OTEL_RESOURCE_ATTRIBUTES="enduser.id=<email>,cc.department=<dept>,cc.mode=ec2"
  │  OTLP/gRPC  (metrics signal + logs signal)
  ▼
ADOT/otel-collector (usage-tracking ECS, docker image cc-on-bedrock/otel-collector)
  pipelines:
    metrics: [memory_limiter, cumulativetodelta, batch] → awss3 (otel_raw/metrics/…)
    logs:    [memory_limiter, transform(SCRUB), filter(tool_result/tool_decision only), batch]
                                                          → awss3 (otel_raw/logs/…)
        │  S3 ObjectCreated (metrics/ and logs/ prefixes)
        ▼
  otel-metrics-rollup Lambda (otel_rollup.py + handler)
        ▼
  DynamoDB cc-on-bedrock-usage  (PK=USER#{email})
    PROD#{date}#{model}      loc_added/removed, commits, prs, sessions, active_seconds, edit_accept/reject
    SKILL#{date}#{skill}     count
    AGENT#{date}#{subagent}  count
    TOOL#{date}#{tool}       count, accept, reject
    ACTIVE#{date}            presence (DAU/WAU/MAU, gsi_day)
    OTELOBJ#{key}            dedup marker (TTL 7d)
```

**폐기:** `ecs-devenv` 모듈의 awsemf collector + `CCOnBedrock/CodeMetrics` namespace + `/cc-on-bedrock/otel/code-metrics` 로그그룹.
**무관/유지:** 005 invocation-log → DynamoDB → 예산/제한(ADR-005/008).

## 5. Component changes

### 5.1 Devenv native OTEL config — `terraform/modules/ec2-devenv` (launch template userdata / managed settings) + `shared/nextjs-app/src/lib/ec2-clients.ts` (boot script가 env 주입 시)
- Claude Code managed-settings `env` 블록(사용자 override 불가)에 §4 env 주입. `OTEL_RESOURCE_ATTRIBUTES`의 email/dept는 `/etc/environment`(USER_EMAIL/USER_DEPARTMENT)에서 합성.
- 엔드포인트 = usage-tracking collector NLB(:4317). (ecs-devenv :4318 endpoint 참조 제거.)
- #94 `cc-otel-code-metrics.sh` wrapper/타이머 설치 **중단(은퇴)**.

### 5.2 Collector — `docker/otel-collector/config.yaml` + `terraform/modules/usage-tracking` (task def)
- **logs 파이프라인 추가** + `transform`/`filter` 프로세서로 D7 scrub. metrics 파이프라인 유지(awss3).
- 컨테이너 `OTEL_S3_BUCKET`/`AWS_REGION` env는 **이미 존재**(usage-tracking main.tf:1316-1318) — 확인만.
- s3 prefix를 metrics/ 와 logs/ 로 분리(또는 marshaler가 신호별 분리). 4317(grpc) 수신 유지.

### 5.3 Rollup — `lambda/otel_rollup.py` + `lambda/otel-metrics-rollup.py`
- **metrics 파싱: `claude_code.*` 스키마로 복원**(앞서 cc.*로 바꾼 T1/T2 되돌림): `lines_of_code.count`(type added/removed, model), `commit.count`, `pull_request.count`, `session.count`, `active_time.total`(seconds), `code_edit_tool.decision`(accept/reject). → PROD#{date}#{model} (loc_added/removed, commits, prs, sessions, active_seconds, edit_accept, edit_reject).
- **logs 파싱(신규)**: `parse_otlp_logs(payload)` → `tool_result`/`tool_decision` 레코드. `aggregate_tool_events(records)` → counts by (email,date,'skill',skill_name) / ('agent',subagent_type) / ('tool',tool_name, accept/reject).
- 핸들러: 객체가 metrics인지 logs인지 판별(resourceMetrics vs resourceLogs) 후 각각 집계 → SKILL#/AGENT#/TOOL# rows ADD + PROD#/ACTIVE# + OTELOBJ# TTL.
- identity: `normalize_identity`(enduser.id→소문자 email) 유지; 미검증 → unattributed.
- cost/token 추출 없음(D6).

### 5.4 Terraform 버그/마무리 — `terraform/modules/usage-tracking`
- **rollup lambda IAM에 `dynamodb:TransactWriteItems` 추가** (현재 누락 → 핸들러 transact_write_items가 AccessDenied 날 실버그).
- `otel_metrics_raw_bucket_arn` output(필요 시).
- archive가 `otel-metrics-rollup.py` + `otel_rollup.py` 둘 다 포함(이미 그러함 — 확인).
- ecs-devenv collector 폐기에 따른 `main.tf` otel_collector_endpoint 와이어링을 usage-tracking collector로 전환.

## 6. Data model (DynamoDB `cc-on-bedrock-usage`, PK=USER#{email})

```
PROD#{date}#{model}   ADD loc_added, loc_removed, commits, prs, sessions, active_seconds, edit_accept, edit_reject
SKILL#{date}#{name}   ADD count
AGENT#{date}#{type}   ADD count
TOOL#{date}#{name}    ADD count, accept, reject
ACTIVE#{date}         Put presence (gsi_day_pk=DAY#{date}, gsi_day_sk=USER#{email})
OTELOBJ#{s3key}       Put dedup (attribute_not_exists, ttl=+7d)
```
- 날짜 = event/datapoint timeUnixNano UTC.
- user별 1 TransactWriteItems(100-item 한도 회피; 한 user가 한 객체에서 100 SK 초과 시 청크 분할 — 신규 가드).

## 7. Edge cases / invariants
1. 식별자 누락·비이메일 → unattributed(보존).
2. 중복/재시도 → OTELOBJ# attribute_not_exists + TTL.
3. metrics: gauge/sum/delta 모두 합산(cumulativetodelta 방어). active_time 단위 seconds.
4. logs: `tool_result`만 성공콜 → accept; `tool_decision`로 reject 보강.
5. **DLP**: scrub 후 S3엔 skill_name/subagent_type/tool_name/success/duration/enduser.id/session.id만. bash/path/input/prompt 없음(테스트로 보장).
6. 멀티유저 객체 → user별 트랜잭션. SK 100 초과 → 청크.
7. cost/token 비귀속(005 권위).
8. Bedrock에서 native user.email 부재해도 enduser.id 스탬프로 식별(검증 태스크 포함).

## 8. ADR / docs (anti-drift, 같은 PR)
- **ADR-009 대개정**: 소스를 #94 커스텀 emitter → 네이티브 OTEL(metrics+events)로 전환, skill/agent 측정, collector scrub(no-content 유지), 식별자 스탬프, collector 통일(Y1, ecs-devenv awsemf 폐기). `BASELINE.md` §3 동시 갱신.
- `docs/architecture.md` pillar 3 재작성. `lambda/`·`terraform/`·`docker/` CLAUDE.md 갱신.

## 9. Testing
- pytest `test_otel_rollup.py`(metrics, claude_code.* 복원) + `test_otel_rollup_logs.py`(신규: tool_result→skill/agent/tool 집계) + `test_otel_rollup_handler.py`(metrics&logs 객체 분기, SKILL#/AGENT#/TOOL#, TTL, no-cost).
- collector config 테스트: logs 파이프라인 scrub가 bash_command/file paths를 제거(assert) + tool_result만 통과.
- TF assertion: rollup IAM에 TransactWriteItems 포함; devenv env에 CLAUDE_CODE_ENABLE_TELEMETRY/OTEL_LOG_TOOL_DETAILS/enduser.id.
- `tests/run-all.sh` green.
- (수동) acceptance §2: atomoh devenv 네이티브 OTEL on → DynamoDB 행 확인 + scrub 확인.

## 10. Open items (구현계획 초기 검증 태스크)
- **네이티브 OTEL on Bedrock 실증**: atomoh devenv에서 env 켜고 `tool_result` 이벤트 + enduser.id가 실제로 collector/S3에 도달하는지 확인(식별자/이벤트 리스크 해소). plan의 첫 태스크.
- collector docker 이미지 재빌드/푸시 필요 여부(config.yaml 변경 시 ECR push).
- s3 prefix 분리 방식(awss3 marshaler가 metrics/logs를 어떻게 키잉하는지) 확인.
