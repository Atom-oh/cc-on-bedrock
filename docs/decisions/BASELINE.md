# CC-on-Bedrock 결정 베이스라인 (BASELINE) / Decision Baseline

> **이것이 결정의 단일 현행 진실(single source of truth)이다.** AI·사람 모두 여기부터 읽는다.
> 아키텍처 상세는 `../architecture.md`(SSOT), 결정 근거는 같은 디렉토리의 통합 ADR(`0NN-*.md`),
> 옛 이력은 `archive/`·`../history/`(명시 요청 없이는 읽지 않는다 — git tag `adr-legacy-2026-06-23`로도 보존).
> This is the single current-truth for decisions. Read this first.

---

## §0 북극성 (North Star) — 고정 (변경 시 owner 승인)

### 목표 (Goal)
> **CC-on-Bedrock은 AWS Bedrock 위에 안전하고 거버넌스된 멀티유저 Claude Code 개발환경을 제공한다.**
> per-user EC2 DevEnv(브라우저 IDE) 또는 로컬 PC에서 Bedrock 접근을 주되,
> **사용량·예산·IAM 권한을 중앙에서 통제**한다. (Codex on Bedrock은 후속 확장.)

### 가치 (Value)
- **즉시 쓰는 개발환경** — 로그인하면 Bedrock이 붙은 IDE(EC2) 또는 로컬 CLI가 바로 동작.
- **중앙 거버넌스** — 사용량(Invocation Log→DynamoDB)·예산(부서/개인)·권한(셀프서비스+admin 승인)을 한 곳에서 통제.
- **안전 내장** — per-user IAM 격리 + permission boundary + 예산 초과 시 IAM deny 자동 집행.

### 핵심 설계 (Core Design)
1. **Terraform 단일 IaC** — CDK/CloudFormation 폐기 (→ ADR-001).
2. **2개 접근 경로** — EC2 Mode(CloudFront→NLB→nginx ECS→EC2) + Local Mode(STS issuer) (→ ADR-003·006).
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
- **anti-drift** — 새 ADR/flag/status 변경은 **같은 PR에서 이 §3(또는 §2)를 갱신**. 갱신 없으면 "not live". 옛 ADR 본문은 트리에서 제거(git tag + `../history/ADR-MAPPING.md` 보존), **번호 재사용 금지**.

---

## §2 게이트 / 보류 register (Gated / Deferred)

| 상태 | 항목 | 조건 / 비고 | 근거 |
|---|---|---|---|
| **GATED** | Local Governance Mode | `governanceOnly` 동등 변수로 EC2 없이 거버넌스 레이어만 배포 가능 | ADR-006 |
| **LIVE(flag)** | EC2 Hibernation | `HIBERNATE_ENABLED=true`. 유휴 stop/hibernate + 만료 회전, 암호화 root | ADR-002 |
| **GATED** | 셀프서비스 IAM 권한 확장 | UI 신청 → **admin 승인** 필수 + permission boundary 내 | ADR-007 |
| **DEFERRED** | Codex on Bedrock | 후속 확장. 현 타깃은 Claude Code on Bedrock | §0 |
| **DEFERRED** | Enterprise SSO Federation | 외부 IdP 수요·credential 확정 시 재개 (구 ADR-008) | history/brainstorm |
| **OUT-OF-SCOPE** | Department MCP Gateway | 현 베이스라인 범위 밖 (구 ADR-007-MCP) | history/brainstorm |

---

## §3 결정 인덱스 (Decision Index)

> 통합 ADR 11개 (옛 34개 → 통합). 옛 본문 → `../history/ADR-MAPPING.md` + git tag `adr-legacy-2026-06-23`.
> **상태:** 클러스터 맵 확정. 통합 ADR 본문 작성 = Phase 2(진행 예정). 그 전까지 LEGACY 번호가 현행 ADR.

| ADR | 토픽 | 한 줄 | 흡수 LEGACY |
|---|---|---|---|
| 001 | IaC: Terraform 단일 | CDK/CFN 폐기, Terraform 단일 정본 (boundary도 TF에서 생성) | 033·034 |
| 002 | DevEnv 컴퓨트·스토리지 | per-user EC2, dual-OS, **2-볼륨**(ephemeral root + persistent /home/coder EBS), GP3, hibernation | 004·010·018·032 · ~~001·003~~ |
| 003 | 접근 토폴로지·라우팅 | 2 CloudFront(devenv NLB+nginx / dashboard ALB), code-server ?folder= 8080 + custom 포트 | 002·009·016·027 · ~~013~~ |
| 004 | 인증 | Cognito public client + NextAuth, JIT 트리거 fallback, 삭제 cleanup | 024·028 · ~~012~~ |
| 005 | 사용량 집계 | Inference Profile + Invocation Log → DynamoDB, email canonical key, 모델 정규화 | 011·019·031 · ~~025~~ |
| 006 | 공유 자격증명 | EC2·Local 동일 inference profile, Local Mode STS issuer, credential_process 1h 갱신 | 014·029 |
| 007 | IAM 신청·boundary | 셀프서비스 신청 + admin 승인 + boundary X(AllowInAccount+DenyEscalation, TF 생성), runtime upsert, wildcard Claude | 005·020·021·030·034 · ~~026~~ |
| 008 | 예산 집행 | 부서/개인 예산($+normalized token), EventBridge → IAM deny | 006·015·023 |
| 009 | OTel 관측 | EC2 코드활동 메트릭 60초 push → Collector, 생산성 모니터링 | (OTel 파이프라인) |
| 010 | 프로비저닝 | EventBridge pre-provisioning + Cognito JIT fallback | 022·028 |
| 011 | 대시보드 배포 | ECS rolling deployment + circuit breaker | 017 |

> **제외(브레인스토밍/보류) → history/brainstorm:** 구 ADR-007(MCP Gateway), 구 ADR-008(Enterprise SSO).

새 ADR 추가: 최고번호+1, single Status, **같은 PR에서 §3(또는 §2) 갱신 필수**(anti-drift, §1).
