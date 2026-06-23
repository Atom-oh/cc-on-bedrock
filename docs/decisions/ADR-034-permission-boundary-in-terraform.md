---
status: Accepted
date: 2026-06-22
verification_required: true
amends: ADR-030
---

# ADR-034: 권한 boundary를 Terraform에서 생성 (ADR-030 §T3 "CDK-only" 대체)

## Status: Accepted

## Date: 2026-06-22

## Amends
- [ADR-030: tiered IAM grant + boundary X](ADR-030-tiered-iam-grant.md) — §T3의 "boundary는 **의도적 CDK-only**, TF/CFN은 ARN만 소비(tfvars)" 입장을 대체한다. ADR-030의 **설계**(grant 계층 + DenyEscalation deny-floor)는 유효; 바뀌는 것은 **boundary의 생성 위치**뿐이다.
- 전제: [ADR-033](ADR-033-cdk-to-terraform-migration.md) — CDK 폐기, Terraform 단일 IaC.

## Context

ADR-030 §T3은 `cc-on-bedrock-task-boundary`(≈4000개 per-user 역할의 보안 floor)를 **CDK Stack 02에서 단일 생성**하고 TF/CFN은 `task_permission_boundary_arn`(tfvars)로 ARN만 소비한다고 결정했다. 이유: 63-action DenyEscalation floor를 손으로 TF에 복제하면 silent drift가 나고, CI 불변식(`scripts/check-policyset-boundary.py`)이 CDK synth만 검증하기 때문.

그러나 **ADR-033이 CDK를 완전히 삭제**(`cdk/` 제거, Terraform 단일 IaC)하면서 §T3의 전제가 무너졌다 — boundary를 author할 CDK가 더는 없다. ADR-033 머지(#80) 후 boundary 생성 주체가 사라지면 TF-only 신규 배포의 per-user 역할이 **권한 상한 없이** 생성되는 CRITICAL 공백이 발생한다(PR #80 리뷰에서 제기·검증됨).

## Decision

**`cc-on-bedrock-task-boundary`를 Terraform `security` 모듈에서 생성한다.**

- `terraform/modules/security/main.tf` — `aws_iam_policy.task_permission_boundary` (name=`${var.project_prefix}-task-boundary`). ADR-026 service-ceiling statements를 포팅(BedrockClaude·S3·KMS·CW·ECR·SSM·Secrets·AgentCore·MCP-config + GrantCeiling*).
- 소비: `terraform/main.tf`가 `module.security.task_permission_boundary_arn`(**항상 non-empty**)을 **ec2-devenv·local-governance** 모듈에 전달 → per-user/Local 역할이 boundary와 함께 생성됨. (ec2-devenv 모듈은 `task_permission_boundary_arn != "" ? ... : null` 방어적 fallback을 유지하나, root가 항상 실 ARN을 주입하므로 boundary 없는 역할은 생성되지 않는다. `arn==""`일 때 배포를 막는 `precondition` hardening은 후속으로 추적.)
- 단일 출처는 이제 **CDK가 아니라 TF**다. ADR-030 §T3은 본 ADR로 대체된다.

### 미완(추적): ADR-030 boundary-X deny-floor의 TF 포팅
현재 TF boundary는 **ADR-026 ceiling**을 구현한 것이다. ADR-030의 **boundary-X DenyEscalation 63-action floor**(escalation hard-floor)는 아직 TF boundary에 반영되지 않았다 — **후속 작업으로 추적**(`terraform/CLAUDE.md`). 그때까지 boundary는 service-ceiling만 강제하고 deny-floor는 미적용.

### CI 불변식
`scripts/check-policyset-boundary.py`는 CDK synth template 기반이었다. CDK 삭제로 `tests/run-all.sh`는 `--self-test`(coverage 로직)만 돌린다. **TF plan/show 기반 boundary ⊇ allowlist 재검증**은 후속(boundary-X 포팅과 함께).

## Consequences

### 긍정
- TF-only 배포에서 per-user 역할이 boundary와 함께 생성됨 — CRITICAL 보안 공백 제거.
- boundary 단일 출처 유지(이제 TF) — ADR-030의 anti-drift 의도를 TF 안에서 보존.

### 부정 / 위험
- TF boundary가 아직 ADR-026 ceiling만 구현 — ADR-030 deny-floor 미반영(추적 중). 그동안 escalation hard-floor 부재.
- CI 불변식이 `--self-test`로 약화(synth template 검증 소멸) — TF 기반 재구현 전까지 boundary↔allowlist drift를 자동 검증 못 함.

### 보안
- boundary `Encrypted`/태그 정책은 ADR-026 유지. 0.0.0.0/0·Principal:"*"·평문 시크릿 도입 없음.

## Verification

```yaml
# Tier 1: Static
files:
  - path: terraform/modules/security/main.tf
    must_contain:
      - "task_permission_boundary"
      - "${var.project_prefix}-task-boundary"
      - "BedrockClaude"
  - path: terraform/main.tf
    must_contain:
      - "task_permission_boundary_arn"
```
