# ADR-014: Local Governance Mode (EC2-less, IAM + Inference Profile)

## Status
Proposed (2026-05-11)

## Context
기존 CC-on-Bedrock은 EC2 per-user DevEnv(ADR-004)를 핵심으로 한다. 그러나 일부 조직은:

- 개발자가 **로컬 PC에서 Claude Code를 직접 사용**하고 싶어 한다 (IDE 통합, 개인 도구체인 유지)
- **EC2 운영 부담**(AMI 관리, 하이버네이션, 비용)을 지지 않고 싶다
- 단, **거버넌스**(사용자별 사용량 추적, 부서 예산, 모델 제한, DLP, 감사)는 그대로 필요하다
- 기존 대시보드(Next.js + DynamoDB)와 사용량 파이프라인은 재사용하고 싶다

거버넌스 적용점으로 두 가지 선택지가 존재한다:

1. **IAM + Application Inference Profile** — Claude Code가 사용자 단기 STS 자격증명으로 Bedrock을 직접 호출
2. **LLM Gateway** (LiteLLM/Portkey 또는 자체) — 게이트웨이가 인증·쿼터·DLP를 처리하고 Bedrock에 재서명

## Decision
**Local Governance Mode**를 새로운 배포 프로파일로 도입하며, **(1) IAM + Application Inference Profile 방식**을 채택한다.

### Rationale

| 차원 | IAM + Inference Profile | LLM Gateway |
|---|---|---|
| 추가 인프라 | 없음 (Lambda/STS만) | Fargate/Lambda 게이트웨이 + DB |
| Claude Code 통합 | 네이티브 (`CLAUDE_CODE_USE_BEDROCK=1`) | Anthropic 호환 endpoint 필요 |
| 실시간 쿼터 | 5분 사이클 (IAM Deny) | 즉시 |
| DLP/프롬프트 검증 | Bedrock Guardrails | 게이트웨이 미들웨어 |
| 비용 attribute | IAM principal + Inference Profile 태그 → CUR 2.0 (ADR-011) | 게이트웨이 로그 → 자체 집계 |
| 감사 | CloudTrail 네이티브 | 게이트웨이 로그 의존 |
| 운영 부담 | 낮음 | 중간~높음 (SPOF, 패치, 인증) |
| Bedrock 신기능 호환 | 즉시 | 게이트웨이 업데이트 대기 |

핵심 판단: "EC2 제거" 목표와 게이트웨이 인프라 추가는 정신적으로 충돌한다. ADR-011에서 이미 IAM principal 기반 비용 할당과 5분 단위 예산 강제(`budget-check.py` + IAM Deny)를 검증했으므로, 동일 메커니즘이 로컬 PC 호출에도 그대로 적용된다 — Bedrock Invocation Logging은 호출 위치와 무관하게 IAM principal로 기록되기 때문이다.

게이트웨이는 **실시간(<1초) 쿼터 강제** 또는 **고급 DLP**가 비즈니스 요구로 명확히 등장한 시점에 ADR로 별도 도입한다 (Phase 2).

## Architecture

```
[로컬 PC]
  Claude Code (CLAUDE_CODE_USE_BEDROCK=1)
    │
    │ AWS SigV4 (단기 STS 자격증명, TTL 1h)
    ▼
[AWS]
  Cognito 로그인 → Dashboard → STS Issuer Lambda
    │                              │
    │                              └─ AssumeRole → cc-on-bedrock-local-user-{username}
    │                                              (Bedrock 모델 제한 + Guardrail + IAM tags)
    ▼
  Bedrock InvokeModel (Application Inference Profile)
    │
    ├─ Bedrock Invocation Logging → CloudWatch Logs
    │     └─ Subscription → bedrock-usage-tracker.py → DynamoDB
    │                                                    └─ Dashboard
    ├─ CloudTrail → 감사
    └─ Application Inference Profile 태그 → CUR 2.0 → 부서별 청구
```

## Changes

### 새로 추가
- **`cdk/lib/08-local-governance-stack.ts`** — STS Issuer Lambda, per-user role factory, Application Inference Profile per dept
- **STS Issuer Lambda** (`cdk/lib/lambda/sts-issuer.py`) — Cognito ID 토큰 검증 → `sts:AssumeRole` → 1h 자격증명 반환
- **Dashboard 페이지** `shared/nextjs-app/app/local/page.tsx` — "Get Credentials" 버튼, `aws configure` 스니펫 출력
- **CLI 도우미** `tools/cc-bedrock-local.sh` — 자격증명 갱신 + `claude` 실행 wrapper

### 재사용 (변경 없음)
- `bedrock-usage-tracker.py` — Invocation Logging 기반이므로 호출 출처 무관
- `budget-check.py` — IAM Deny 부착 메커니즘 동일
- DynamoDB 스키마, 대시보드 차트, ADR-011 태그 정책

### 비활성화 (Local 프로파일에서)
- `04-ecs-devenv-stack.ts`, `07-ec2-devenv-stack.ts` — deploy context flag `governanceOnly=true` 시 skip
- ECS/EC2 의존 대시보드 페이지(컨테이너 시작/중지)는 숨김 처리

### IAM Role per user
- 이름: `cc-on-bedrock-local-user-{cognito_sub}` (기존 `cc-on-bedrock-task-{subdomain}`과 분리)
- 신뢰 정책: STS Issuer Lambda role만 AssumeRole 가능
- 권한: 특정 Bedrock 모델 ARN + 부서 Application Inference Profile만 InvokeModel
- 태그: `username`, `department`, `project`, `mode=local` (ADR-011 정책 준수)
- Guardrail: 부서 Guardrail ID 강제 (IAM condition `bedrock:GuardrailIdentifier`)

## Security
- 자격증명 TTL: 1시간 (단기 강제), Cognito refresh로 갱신
- Local PC 도난 대비: 부서 관리자 콘솔에서 즉시 role disable 가능
- VPN/IP 제한 옵션: IAM condition `aws:SourceIp` 부서 정책에 따라
- 모델 제한: 승인된 모델 ARN 외 호출 시 IAM Deny
- 감사: 모든 호출 CloudTrail에 기록, principal = user role

## Limitations
- **실시간 쿼터 강제 불가** — 5분 단위 IAM Deny가 최단 (ADR-011과 동일)
- **프롬프트 단위 DLP** — Bedrock Guardrails에 의존 (커스텀 룰 한계)
- **자격증명 유출 시** — 최대 1시간 노출, role disable로 즉시 차단

## Future Work
- Phase 2: LLM Gateway 옵션 (Fargate Serverless) — 실시간 쿼터/고급 DLP 필요 조직 대상 별도 ADR
- 로컬 CLI에 사용량 실시간 표시 (DynamoDB 쿼리 API 추가)
- SSO Federation (ADR-008)과 통합한 SAML/OIDC 자격증명 발급

## References
- ADR-004: EC2 per-user DevEnv (대비)
- ADR-011: Bedrock IAM Cost Allocation (재사용 정책)
- ADR-006: Department Budget Management (재사용)
- ADR-008: Enterprise SSO Federation
