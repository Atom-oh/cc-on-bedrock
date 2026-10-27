# CC-on-Bedrock 결정 베이스라인 (BASELINE) / Decision Baseline

> **이것이 결정의 단일 현행 진실(single source of truth)이다.** AI·사람 모두 여기부터 읽는다.
> 아키텍처 상세는 `../architecture.md`(SSOT), 결정 근거는 같은 디렉토리의 통합 ADR(`ADR-NNN-*.md`),
> 옛 이력은 `archive/`·`../history/`(명시 요청 없이는 읽지 않는다 — git tag `adr-legacy-2026-06-23`로도 보존).
> This is the single current-truth for decisions. Read this first.

---

## §0 북극성 (North Star) — 고정 (변경 시 owner 승인)

### 목표 (Goal)
> **CC-on-Bedrock은 AWS Bedrock 위에 안전하고 거버넌스된 멀티유저 Claude Code 개발환경을 제공한다.**
> per-user EC2 DevEnv(브라우저 IDE) 또는 로컬 PC에서 Bedrock 접근을 주되,
> **사용량·예산·IAM 권한을 중앙에서 통제**한다.
> Claude Code and the **OpenAI Codex CLI** (OpenAI GPT models on Bedrock) are governed identically (→ ADR-014).

### 가치 (Value)
- **즉시 쓰는 개발환경** — 로그인하면 Bedrock이 붙은 IDE(EC2) 또는 로컬 CLI가 바로 동작.
- **중앙 거버넌스** — 사용량(Invocation Log→DynamoDB)·예산(부서/개인)·권한(셀프서비스+admin 승인)을 한 곳에서 통제.
- **안전 내장** — per-user IAM 격리 + permission boundary + 예산 초과 시 IAM deny 자동 집행.

### 핵심 설계 (Core Design)
1. **Terraform 단일 IaC** — CDK/CloudFormation 폐기 (→ ADR-001).
2. **2개 접근 경로** — EC2 Mode(CloudFront→NLB→nginx ECS→EC2) + Local Mode(STS issuer) (→ ADR-003·006). Deployment profile `deployment_mode`: `governance` (default, Local Mode only) or `devenv` (adds EC2 Mode).
3. **사용량/예산은 Inference Profile + Invocation Log 기반** — DynamoDB 집계, EventBridge→IAM deny 집행 (→ ADR-005·008).
4. **per-user 격리** — EC2/Local 동일 inference-profile 귀속, role은 분리(공유 정책·boundary·태그) (→ ADR-006·007).

상세 현행 아키텍처 = `../architecture.md` (9 pillar SSOT).

---

## §1 불변식 / 용어 (Invariants) — 결정론적 판정 기준

- **Terraform-only** — 새 CDK/CloudFormation 배포 경로 추가 금지. Lambda 소스는 `lambda/`(IaC 디렉토리 밖)에서 Terraform이 직접 패키징. permission boundary 등 정책도 Terraform이 정본(ADR-034).
- **자격증명 분리** — EC2와 Local에 동일한 단일 IAM role 금지. 정책 shape·permission boundary·태그·inference-profile 귀속만 공유.
- **STS 1h 한도** — 체이닝 자격증명을 1시간 너머 연장 금지. `credential_process` 갱신 사용.
- **EBS 영속성 (2-볼륨)** — DevEnv는 ephemeral OS root(`DeleteOnTermination=true`) + persistent 데이터 EBS(`/home/coder`, `DeleteOnTermination=false`, subdomain 태그로 재연결). Terminate가 사용자 데이터를 파괴하면 안 됨 (ADR-032).
- **code-server 포트 8080 예약** — custom route 포트는 8080(및 well-known) 사용 금지.
- **Kiro 거버넌스 제외** — Kiro는 IAM Identity Center 구독 라이선스; Cognito/Bedrock 토큰 한도 집행 대상 아님.
- **Codex = bedrock-runtime by default; mantle only when unmetered is accepted** — Codex CLI calls Bedrock via the `amazon-bedrock-runtime` provider (Responses API). `bedrock-mantle:*` escapes invocation-log metering, so it is never in a standing allow-list: only `budget-check` grants it (`cc-bedrock-mantle-unmetered`, own us-east-1 project + web search) to users with no cost cap of any kind, removes it within 5 min of any cap appearing or on a read failure, and every surface says it is not counted. Every per-user Bedrock allow-list copy includes the OpenAI GPT and default-project ARNs (`tests/unit/test_bedrock_iam_codex_parity.py`) (ADR-014 §9).
- **No public ingress, no owned VPC** — Every LB is `internal`, reached only by CloudFront VPC origins, and admits only the CloudFront VPC-origin SG. There are no public IPs on compute. Terraform takes `vpc_id` and subnet IDs and never declares `aws_vpc`. In a shared VPC, SG rules reference SGs instead of the VPC CIDR (interface endpoints excepted) (ADR-015).
- **anti-drift** — 새 ADR/flag/status 변경은 **같은 PR에서 이 §3(또는 §2)를 갱신**. 갱신 없으면 "not live". 옛 ADR 본문은 트리에서 제거(git tag + `../history/ADR-MAPPING.md` 보존), **번호 재사용 금지** (2026-06-23 BASELINE reset의 일괄 재번호는 일회성 예외; 이후 신규 ADR에 적용).

---

## §2 게이트 / 보류 register (Gated / Deferred)

| 상태 | 항목 | 조건 / 비고 | 근거 |
|---|---|---|---|
| **LIVE (default)** | Governance deployment profile | `deployment_mode = "governance"` (default): dashboard + local installer (Cognito → 1h STS, no Bedrock key), no EC2/ECS DevEnv, OTEL collector or EC2 schedules. `deployment_mode = "devenv"` adds EC2 DevEnvs; deprecated `governance_only` overrides when set | ADR-006 (amendment 2026-10-23) |
| **LIVE(flag)** | EC2 Hibernation | `HIBERNATE_ENABLED=true`. 유휴 stop/hibernate + 만료 회전, 암호화 root (`deployment_mode = "devenv"` 전용) | ADR-002 |
| **GATED** | 셀프서비스 IAM 권한 확장 | UI 신청 → **admin 승인** 필수 + permission boundary 내. 신청 API(`/api/user/container-request`)는 `deployment_mode = "devenv"` 전용 (ADR-006 amendment 2026-10-23) | ADR-007 |
| **LIVE** | Codex on Bedrock | Codex CLI preinstalled on EC2 DevEnv + Local plain `codex` via `cc-bedrock-local setup`; bedrock-runtime Responses API sharing usage, budget and audit. Codex OTEL productivity rollup is a follow-up | ADR-014 |
| **DEFERRED** | Enterprise SSO Federation | 외부 IdP 수요·credential 확정 시 재개 (구 ADR-008) | history/brainstorm |
| **OUT-OF-SCOPE** | Department MCP Gateway | 현 베이스라인 범위 밖 (구 ADR-007-MCP) | history/brainstorm |
| **LIVE** | Documentation language | New/substantially rewritten documentation/ADRs/comments use English; existing Korean-only/bilingual content remains until its own maintenance update. Korean conversation/UI remain supported. Review output uses English. | ADR-013 |
| **INACTIVE(flag)** | Specialist review protocol | Retained behind `ROLE_REVIEW=1`; CI runs the simplified `ROLE_REVIEW=0` path since 2026-10-18, revised 2026-10-21 (owner decision, ADR-013 amendment): Codex lens panel L2–L5 → tool-less Claude chair VERDICT; any uncovered lens forces FAIL; diffs over 12,000 lines / 512,000 bytes blocked, never truncated | ADR-013 |
| **LIVE** | PR review roster (CI) | `ROLE_REVIEW=0`: panel Codex `global.openai.gpt-6.1-sol` (one cell per lens); chair Claude Opus 5.5 `global.anthropic.claude-opus-5-5` (fallback `global.anthropic.claude-opus-5`). No Kiro | ADR-013 (amendment 2026-10-21) |
| **INACTIVE(flag)** | Specialist review roster | Codex Astra, Kiro Opus/Sol, Claude Fable; applies only with `ROLE_REVIEW=1` | ADR-013 |
| **REMOVED** | ADR Compliance CI | `adr-verify-pr.yml` / `adr-verify-main.yml` deleted 2026-10-18 (owner decision); ADR `## Verification` blocks remain as documentation | ADR-013 (amendment) |

---

## §3 결정 인덱스 (Decision Index)

> Eleven consolidated ADRs replace the legacy 34; ADR-012 through ADR-015 are subsequent records.
> `../history/ADR-MAPPING.md` maps retired decisions; tag `adr-legacy-2026-06-23` retains their bodies.
> Consolidation is complete. ADR-013's language policy is LIVE; its specialist protocol is retained behind `ROLE_REVIEW=1`.
> The next ADR number is 016; the earlier reset was a one-time exception.

| ADR | 토픽 | 한 줄 | 흡수 LEGACY |
|---|---|---|---|
| 001 | IaC: Terraform 단일 | CDK/CFN 폐기, Terraform 단일 정본 (boundary도 TF에서 생성) | 033·034 |
| 002 | DevEnv 컴퓨트·스토리지 | per-user EC2, dual-OS, **2-볼륨**(ephemeral root + persistent /home/coder EBS), GP3, hibernation, idle-check diagnostics(`checked`/`stopped`/`warned`/`skipped`) | 004·010·018·032 · ~~001·003~~ |
| 003 | 접근 토폴로지·라우팅 | 2 CloudFront(devenv NLB+nginx / dashboard ALB), code-server ?folder= 8080 + custom 포트 | 002·009·016·027 · ~~013~~ |
| 004 | 인증 | Cognito public client + NextAuth, JIT 트리거 fallback, 삭제 cleanup | 024·028 · ~~012~~ |
| 005 | 사용량 집계 | Inference Profile + Invocation Log → DynamoDB, email canonical key, 모델 정규화 | 011·019·031 · ~~025~~ |
| 006 | 공유 자격증명 | EC2·Local 동일 inference profile, Local Mode STS issuer, credential_process 1h 갱신; amendment 2026-10-23: `deployment_mode` profiles, `governance` default | 014·029 |
| 007 | IAM 신청·boundary | 셀프서비스 신청 + admin 승인 + boundary X(AllowInAccount+DenyEscalation, TF 생성), runtime upsert, wildcard Claude; 셀프서비스 신청 UI/API는 devenv 프로파일 전용 | 005·020·021·030·034 · ~~026~~ |
| 008 | 예산 집행 | 부서/개인 예산($+normalized token), EventBridge → IAM deny. Per-user USD = daily / weekly / monthly caps, any one exceeded blocks (amendment 2026-10-18) | 006·015·023 |
| 009 | OTel 관측 | **네이티브 Claude Code OTEL**(metrics `claude_code.*` + `tool_result` 이벤트) → collector(awss3, logs DLP-scrub) → S3 → rollup Lambda → DynamoDB per-user 일일 KPI(PROD#/SKILL#/AGENT#/TOOL#/ACTIVE#). `enduser.id` 스탬프. 비용은 005 권위. 커스텀 emitter 은퇴 (P1 rewrite 2026-06-26) | 005·029 (OTel 파이프라인) |
| 010 | 프로비저닝 | EventBridge pre-provisioning + Cognito JIT fallback | 022·028 |
| 011 | 대시보드 배포 | EC2 ASG + Docker, Terraform-managed ECR, tag-driven instance refresh | 017 |
| 012 | DevEnv 헬스 판정 | 직접 8080 probe 제거(SG 격리로 timeout) → EC2 lifecycle 파생(running+privateIp⇒HEALTHY), 낙관적 false-positive trade-off 수용 | (신규) |
| 013 | Specialist PR review and documentation | Active role protocol and incremental English maintenance policy; preserves remaining security/custody rules | New |
| 014 | Codex on Bedrock | OpenAI Codex CLI → bedrock-runtime Responses API (`global.openai.*`), per-user role attribution; IAM adds OpenAI GPT + default project (mantle only via the §9 budget-check grant); explicit per-model cache rates + corrected Claude prices (Price List API); usage `tool` attribute + per-tool dashboard; audit-logger `Responses` / Local roles / `client_tool`; `/etc/codex/config.toml` system layer; §9 (2026-10-26): `codex -p mantle` (bedrock-mantle, web search, us-east-1) for unlimited-cost users only — NOT metered, CloudTrail data-event audit, `enable_mantle` | New |
| 015 | Existing VPC + internal origins | BYO VPC (`vpc_id` + subnet IDs, no `aws_vpc`), shared public zone as a data source (`removed` for old states), dashboard ALB / DevEnv NLB `internal` behind CloudFront VPC origins, SG-reference rules instead of VPC CIDR; migration = destroy + fresh apply | New |

> **제외(브레인스토밍/보류) → history/brainstorm:** 구 ADR-007(MCP Gateway), 구 ADR-008(Enterprise SSO).

새 ADR 추가: 최고번호+1, single Status, **같은 PR에서 §3(또는 §2) 갱신 필수**(anti-drift, §1).
