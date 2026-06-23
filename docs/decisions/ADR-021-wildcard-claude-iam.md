---
status: Accepted
date: 2026-05-13
verification_required: true
---

# ADR-021: Wildcard Claude-Family IAM (Remove Per-Model-ID Restriction)

## Status
Accepted (2026-05-13)

## Context

이전까지 모든 Bedrock InvokeModel IAM 정책 (Permission Boundary, 사용자 role inline policy, Dashboard/ECS/EC2 role policy)은 `config.opusModelId` / `config.sonnetModelId`에 박힌 **구체적인 모델 ID**로 ARN 매칭을 시도했다. STS Issuer Lambda는 `ALLOWED_MODELS` env var에서 받은 model ID로 inline policy ARN을 합성했다.

이 설계는 다음 문제로 인해 **사용자의 Bedrock 호출이 전부 AccessDenied 처리되어 토큰 사용량이 추적되지 않는 상태**가 됐다:

1. **모델 ID family/version 불일치**
   - `cdk/config/default.ts`의 `opusModelId = 'global.anthropic.claude-opus-4-6-v1[1m]'`, `sonnetModelId = 'global.anthropic.claude-sonnet-4-6[1m]'`
   - 그러나 사용자 PC에 설치되는 CLI 디폴트(`tools/cc-bedrock-local.sh`, `shared/.../api/install/route.ts`)는 `claude-opus-4-7`, `claude-haiku-4-5-...`
   - STS Issuer가 발급하는 inline policy의 명시적 Allow 대상에 사용자가 실제 호출하는 모델이 없음 → IAM Deny
2. **Permission Boundary의 region-prefix 미커버**
   - 패턴 `arn:aws:bedrock:*::foundation-model/anthropic.claude-*`는 `anthropic.`로 시작해야 하지만 사용자는 `global.anthropic.*`, `us.anthropic.*` 호출
   - foundation-model path가 boundary와 미스매치 → effective permission = ∅
3. **`[1m]` suffix가 ARN의 일부로 들어감**
   - `arn:...:foundation-model/global.anthropic.claude-opus-4-6-v1[1m]`은 ARN-syntax illegal 문자 포함. 실제 호출 시의 resource ARN과 매칭 실패
4. **결과적 추적 실패**
   - Bedrock Invocation Logging은 success-only → 거부된 호출은 CloudWatch Log에 안 들어옴 → `bedrock-usage-tracker` Lambda가 토큰을 볼 일이 없음
   - CloudTrail EventBridge fallback은 잡지만 token count = 0
   - `cc-on-bedrock-usage` DynamoDB 테이블의 `inputTokens` / `outputTokens` 가 0으로 고정 → Dashboard 추적 차트 빈 상태

## Decision

**Bedrock InvokeModel IAM resource는 모든 Claude family를 와일드카드로 매치한다. Per-model spend control은 IAM이 아니라 런타임 enforcer (token-limit-enforcer, budget-check)가 담당한다.**

### 새 IAM Resource 패턴 (모든 stack 공통)

```
arn:aws:bedrock:*::foundation-model/*anthropic.claude-*
arn:aws:bedrock:*:{ACCOUNT_ID}:inference-profile/*anthropic.claude-*
arn:aws:bedrock:*:{ACCOUNT_ID}:application-inference-profile/*
```

각 패턴이 커버하는 식별자:
- `*anthropic.claude-*` (foundation-model / inference-profile) — `anthropic.claude-*`, `global.anthropic.claude-*`, `us.anthropic.claude-*`, `apac.anthropic.claude-*`, `eu.anthropic.claude-*`, 그리고 미래 region prefix
- `application-inference-profile/*` — 모든 dept별 App Inference Profile (ADR-011 cost allocation 기존 사용처)

### 적용 위치
- `terraform/modules/security/main.tf` — `bedrockPolicy` (Dashboard role) + `taskPermissionBoundary` (Permission Boundary)
- `terraform/modules/ecs-devenv/main.tf` — `ecsTaskRole` Bedrock 권한
- `terraform/modules/dashboard/main.tf` — `dashboardPolicy` BedrockAccess statement
- `terraform/modules/ec2-devenv/main.tf` — `devenvRole` BedrockAccess statement
- `lambda/role_factory.py` — `allowed_model_arns()` 와일드카드 반환으로 단순화 (sts-issuer.py는 `from role_factory import ensure_role`), `ALLOWED_MODELS` env var 제거
- `terraform/modules/local-governance/main.tf` — `ALLOWED_MODELS` env / `allowedModels` prop 제거
- `cdk/bin/app.ts` — `LocalGovernanceStack`의 `allowedModels` prop 전달 제거
- `terraform/modules/security/main.tf` — `data.aws_iam_policy_document.bedrock` 동기화

### 무엇이 사라졌나
- `ALLOWED_MODELS` env var (STS Issuer Lambda)
- `allowedModels` prop (LocalGovernanceStack)
- `allowed_model_arns()` (`role_factory.py`) 내부의 model ID iteration / ARN 합성 로직
- STS Issuer inline policy의 per-dept `application-inference-profile/{prefix}-{dept}-*` 제약 (와일드카드 `application-inference-profile/*`로 통합)

### 무엇이 유지되나
- `INFERENCE_PROFILE_PREFIX` env var — STS Issuer 응답의 `inferenceProfileArn` 표시 용도로만 유지
- `config.opusModelId`, `config.sonnetModelId` — 모델 family 정보로 코드 다른 곳에서 사용. IAM과 무관
- Role-level IAM Deny (ADR-014 token-limit-enforcer, ADR-015 budget-check) — 한도 초과 시 동적 부착. 그대로 작동

## Rationale

| 차원 | Per-model-ID 허용 | Wildcard family 허용 |
|---|---|---|
| 새 Claude version 출시 (4-7, 4-8…) | 매번 config 갱신 + 재배포 + 기존 사용자 role inline policy 갱신 필요 | 자동 적용 (재배포 불필요) |
| Region prefix 추가 (eu., me., …) | ARN 패턴 매번 추가 | 와일드카드가 흡수 |
| `[1m]` 같은 variant suffix | ARN 매칭 실패 위험 | 와일드카드가 흡수 |
| 토큰 추적 가능 여부 | 호출 거부 시 Invocation Log 없음 → 추적 불가 | 호출 성공 → Invocation Log 발생 → tracker가 토큰/비용 집계 |
| Per-model spend gating | IAM 정책으로 사전 차단 (rigid) | 런타임 enforcer가 한도 초과 시 Deny 부착 (flexible) |
| 정책 코드 복잡도 | model ID iteration + ARN 분기 로직 | 3줄 정적 list |
| Cognito custom attribute 의존 | 없음 | 없음 |

핵심 trade-off: **사전 IAM 차단 → 사후 런타임 차단**. 사용자가 한도 내에서는 어떤 Claude family든 호출 가능하고, 한도를 넘으면 `cc-bedrock-local-token-deny` 정책이 동적 부착돼 차단됨. 이는 ADR-014/015가 이미 구현하고 있는 정책 부착 메커니즘과 자연스럽게 일치한다.

## Consequences

### Positive
- **토큰 추적 복구**: 사용자 호출이 IAM Allow → Bedrock Invocation Log 생성 → `bedrock-usage-tracker` Lambda 정상 동작 → DynamoDB row 입력 토큰/출력 토큰 정상 집계
- **모델 출시 추종성**: 새 Claude 4-7/4-8 출시 시 코드 변경 없음. CLI 디폴트만 변경하면 즉시 사용 가능
- **Region prefix 흡수**: cross-region inference profile, multi-region 호출이 모두 동작
- **정책 코드 단순화**: `role_factory.py`의 `allowed_model_arns()`가 ~15줄 → 3줄. 8개 파일에서 model ID 분기 로직 제거
- **per-dept App Inference Profile 사용 자유**: 사용자가 dept profile / 직접 model ID 둘 다 사용 가능. dept attribution은 IAM role tag(ADR-011) + role name prefix로 보장됨
- **Permission Boundary와 inline policy의 효력 일치**: 양쪽 다 같은 wildcard로 단순화되어 `effective = inline ∩ boundary` mismatch 위험 제거

### Negative
- **IAM 차원 사전 차단 상실**: 예를 들어 잘못 배포된 새 모델을 임시로 차단하려면 IAM 정책 직접 patch가 아니라 별도 Deny 정책 부착이 필요 (그러나 이건 token-limit-enforcer가 이미 부착 mechanism 보유)
- **Anthropic 외 vendor 모델은 여전히 IAM 미허용**: `*anthropic.claude-*` 패턴이라 Cohere, Mistral 등 호출은 거부됨. 의도된 제약 (Claude Code 전용 플랫폼)
- **모델 식별이 코드 분기점에서만 일어남**: `bedrock-usage-tracker.py`의 `normalize_model()` (ADR-019) 이 유일한 model ID 파싱 지점. 새 family 출시 시 PRICING dict 업데이트는 여전히 수동

### Migration / Backward Compat
- 기존 cc-on-bedrock-local-user-* role은 STS Issuer Lambda 다음 호출 시 `_ensure_role()`이 `put_role_policy`로 새 wildcard inline policy를 덮어쓰므로 자동 마이그레이션됨 (사용자가 `cc-bedrock-local refresh` 또는 `claude` 호출 시 적용)
- 기존 cc-on-bedrock-task-* role도 Permission Boundary CDK 재배포 후 효력 자동 갱신 (boundary는 ManagedPolicy 갱신만으로 모든 attach된 role에 적용)
- ALLOWED_MODELS env var를 외부에서 set 했더라도 Lambda 코드가 더 이상 읽지 않으므로 안전하게 무시됨

### Validation
- Synth 시 IAM JSON에 `*anthropic.claude-*` 패턴과 `application-inference-profile/*` 패턴이 포함됐는지 확인
  ```bash
  cd cdk && npx cdk synth CcOnBedrock-Security 2>&1 | grep -A1 "foundation-model\|inference-profile"
  ```
- 배포 후 사용자가 `claude` 호출 시 CloudWatch Logs `/aws/lambda/cc-on-bedrock-usage-tracker`에 `Tracked: <username>(<dept>) <model> in:N out:N $X` 라인이 생기는지 확인
- `aws iam get-role-policy --role-name cc-on-bedrock-local-user-<sub> --policy-name BedrockInvokeInline` 결과의 `Resource` 배열이 와일드카드 3개로 구성되는지 확인
- `tests/integration/test-local-governance.sh` 통과 (ListFoundationModels + Converse + token-limit-enforcer 부착까지 검증)

## Out of Scope
- Anthropic 외 vendor model 허용 — 의도된 제약 유지
- Bedrock 외 LLM provider (OpenAI, Google Vertex) — 별도 인프라 필요
- Pre-deployment "kill switch" — 필요 시 token-limit-enforcer가 부착하는 Deny 정책으로 emergency block 가능

## References
- ADR-011: Bedrock IAM Cost Allocation (role tag 기반 dept 귀속)
- ADR-014: Local Governance Mode (token-limit-enforcer가 한도 초과 시 IAM Deny 부착)
- ADR-015: Dollar Budget × Normalized Token Limit Integration (dept-budget deny)
- ADR-019: Bedrock Model ID Normalization (호출 후 model ID parsing, 와일드카드 흡수의 사후 정규화 layer)
- ADR-020: Runtime IAM Policy Upsert (`_ensure_role()` 매 호출 시 inline policy 덮어쓰기 — wildcard 마이그레이션도 이 경로로 자동 적용)
- 코드: `terraform/modules/security/main.tf`, `lambda/role_factory.py` (`allowed_model_arns()`), `lambda/sts-issuer.py` (`from role_factory import ensure_role`), `terraform/modules/local-governance/main.tf`

## Addendum (2026-06-13) — Embedding models added to the governed ceiling

원안의 천장은 **Claude 패밀리(`*anthropic.claude-*`)** 전용이라, Bedrock 임베딩 모델
(`amazon.titan-embed-*`, `cohere.embed-*` 등)은 `bedrock:InvokeModel`이 boundary에서
silent deny 됐다. IAM 신청 시스템(ADR-026)의 `DEFAULT_SERVICE_ALLOWLIST`에도 `bedrock`이
없어 셀프서비스 신청 대상도 아니었다.

**결정:** governed 모델 천장을 임베딩 패밀리까지 확장한다 — Claude가 허용되는 **모든 grant
지점**에 `*embed*` ARN 쌍을 추가(천장이자 실권한):
- `arn:aws:bedrock:*::foundation-model/*embed*`
- `arn:aws:bedrock:*:{account}:inference-profile/*embed*`

적용 지점: **CDK 8곳** — boundary + base bedrockPolicy(`02-security-stack.ts`), per-user 역할
(`role_factory.py`, `user-role-provisioner.py`, `ec2-clients.ts`, `07-ec2-devenv-stack.ts`),
ecsTaskRole(`04-ecs-devenv-stack.ts`), dashboard 역할(`05-dashboard-stack.ts`). **Terraform 2곳**
(IaC parity, CLAUDE.md 3-way 규정) — `terraform/modules/security/main.tf`,
`terraform/modules/ec2-devenv/main.tf`. (CloudFormation은 per-model bedrock ARN grant이 없어 해당 없음.)
즉 임베딩은 이제 Claude와 동일하게 "거버넌스 허용 모델 패밀리"로 취급된다.

**비용:** 임베딩은 input-only 과금(output 토큰 없음)이라 `bedrock-usage-tracker.py`
`FAMILY_PRICING`에 `"embed"`(input 0.10/1M, output 0) 추가 — 없으면 Sonnet 기본가($3/$15)로
잘못 계산돼 예산이 부풀려짐. 대표값(Titan v2 $0.02 / Cohere·Titan v1 $0.10)이라 모델별 정밀
과금이 필요하면 `PRICING`에 정확한 버전 엔트리를 추가.

**범위 주의:** `*embed*` 와일드카드는 신규/모든 임베딩 모델을 자동 허용한다(유지보수 0,
대신 천장이 넓음). 특정 임베딩만 허용하려면 패턴을 좁힐 것. ADR-026 신청 UI에는 여전히
미노출(Bedrock 모델은 신청이 아니라 천장 정책으로 관리).

## Verification

```yaml
# Tier 1: Static
files:
  # NOTE (ADR-033): evidence for the *anthropic.claude-* ceiling is the boundary (security/main.tf)
  # + the live per-user role (ec2-devenv) + lambda role_factory — all claude-scoped. KNOWN GAP:
  # the still-deployed ecs_task role (terraform/modules/ecs-devenv/main.tf) grants bedrock:InvokeModel
  # Resource="*" — a ceiling BYPASS to be scoped to *anthropic.claude-* as an ADR-021 follow-up.
  # modules/dashboard has no Bedrock grant, so it is not evidence here.
  - path: terraform/modules/security/main.tf
    must_contain:
      - "*anthropic.claude-*"
      - "application-inference-profile/*"
  - path: terraform/modules/ec2-devenv/main.tf
    must_contain:
      - "*anthropic.claude-*"
  - path: lambda/role_factory.py
    must_contain:
      - "*anthropic.claude-*"
  - path: lambda/user-role-provisioner.py
    must_contain:
      - "*anthropic.claude-*"
      - "application-inference-profile/*"
  - path: shared/nextjs-app/src/lib/ec2-clients.ts
    must_contain:
      - "*anthropic.claude-*"
      - "application-inference-profile/*"
  # Regression guard: the narrow pattern that caused the original drift
  # Regex (slash-wrapped) — the literal substring "foundation-model/anthropic.claude-*"
  # almost never appears in source (the `*` is a glob char, not literal). The
  # regression we actually want to catch is per-model-ID narrowing like
  # `foundation-model/anthropic.claude-3-haiku-20240307-v1:0`, which the regex
  # below matches while leaving the correct wildcard `foundation-model/*anthropic.claude-*`
  # untouched (no contiguous `foundation-model/anthropic.claude-…` substring).
  - path: terraform/modules/**/*.tf
    must_not_contain:
      - "/foundation-model/anthropic\\.claude-[a-z0-9-]+/"
  - path: shared/nextjs-app/src/**/*.ts
    must_not_contain:
      - "/foundation-model/anthropic\\.claude-[a-z0-9-]+/"

# Tier 2: Semantic
semantic:
  - claim: "Permission Boundary와 Bedrock-using stack(02/04/05/07) 모두 동일한 wildcard *anthropic.claude-* 패턴 사용"
    context_files:
      - terraform/modules/security/main.tf
      - terraform/modules/ecs-devenv/main.tf
      - terraform/modules/dashboard/main.tf
      - terraform/modules/ec2-devenv/main.tf
  - claim: "STS Issuer Lambda가 ALLOWED_MODELS env var를 더 이상 받지 않으며 role_factory가 wildcard ARN을 반환"
    context_files:
      - lambda/sts-issuer.py
      - lambda/role_factory.py
      - terraform/modules/local-governance/main.tf
```
