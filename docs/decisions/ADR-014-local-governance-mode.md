# ADR-014: Local Governance Mode (EC2-less, IAM + Inference Profile)

## Status
Accepted (2026-05-12) — implemented in Stack 08 (`cdk/lib/08-local-governance-stack.ts`), referenced as binding dependency by ADR-015 and ADR-016

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

자격증명 발급은 **Cognito + STS Issuer Lambda** 방식을 사용한다. 핵심 거버넌스 메커니즘은 **합산 normalized 토큰 한도 초과 시 IAM Deny policy 부착으로 차단**이다.

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
  Claude Code (CLAUDE_CODE_USE_BEDROCK=1, AWS_PROFILE=cc-bedrock)
    │
    │ AWS SigV4 (STS 자격증명, TTL 8h, MaxSessionDuration 12h)
    ▼
[AWS]
  Cognito 로그인 → Dashboard → STS Issuer Lambda
    │                              │
    │                              └─ AssumeRole → cc-on-bedrock-local-user-{sub}
    │                                              ├─ Bedrock 모델 제한
    │                                              ├─ Guardrail 강제
    │                                              ├─ IAM 태그 (username/dept/project)
    │                                              └─ Deny policy (한도 초과 시 동적 부착)
    ▼
  Bedrock InvokeModel (Application Inference Profile)
    │
    ├─ Bedrock Invocation Logging → CloudWatch Logs
    │     └─ Subscription → bedrock-usage-tracker.py → DynamoDB
    │                                                    ├─ Dashboard
    │                                                    └─ Stream → token-limit-enforcer
    │                                                                  ↓
    │                                                          Deny policy 부착
    ├─ CloudTrail → 감사
    └─ Application Inference Profile 태그 → CUR 2.0 → 부서별 청구
```

## Token Limit Enforcement (핵심)

### Normalized Token 정의
서로 다른 모델의 비용 부담을 한 축으로 합산하기 위해 **normalized tokens** 사용:

| 모델 | input weight | output weight | 근거 |
|---|---|---|---|
| Opus 4.6 | 1.0 | 5.0 | $15/$75 per 1M |
| Sonnet 4.6 | 0.2 | 1.0 | $3/$15 per 1M |
| Haiku 4.5 | 0.053 | 0.267 | $0.80/$4 per 1M |

`normalized = input_tokens * w_in + output_tokens * w_out`

### 한도 정책 (DynamoDB `cc-on-bedrock-limits`)
- 사용자 단위: `PK=USER#{sub}` × `period={daily|weekly|monthly}` × `max_normalized_tokens`
- 부서 단위: `PK=DEPT#{dept}` × `period` × `max_normalized_tokens`
- 호출은 **사용자 한도 AND 부서 한도 둘 다** 통과해야 허용 (AND 조건)
- 부서 한도는 ADR-006 부서 예산과 독립적인 축 (달러 vs 토큰)

### 강제 메커니즘
1. **Real-time path** (1-3분 지연): Invocation Logging → tracker Lambda → DynamoDB → **Stream** → `token-limit-enforcer` Lambda → 합산 조회 → 한도 도달 시 user role에 `BedrockLocalLimitExceeded` Deny policy attach
2. **Backup path** (5분 cycle): 기존 `budget-check.py` 확장 — 토큰 한도도 함께 검사 (Stream 실패 대비)
3. **Reset**: EventBridge 스케줄러
   - 일일: 매일 00:00 KST
   - 주간: 월요일 00:00 KST
   - 월간: 매월 1일 00:00 KST
   - 동작: Deny policy detach + DynamoDB 카운터 TTL 만료/리셋

### 차단 latency 한계 (명시)
Invocation Logging 자체가 1-3분 지연되므로 **이 방식의 최단 차단 latency는 약 1-3분**. 한도 직전까지 사용한 사용자는 한도를 약간 초과해 호출이 성공할 수 있음(over-shoot). 이를 방지하려면 LLM Gateway 방식이 필요하나 본 ADR 범위 밖. 한도 설정 시 ~5% 마진을 두는 운영 가이드 적용.

### UX
- 대시보드: 남은 normalized token, 사용률 % 게이지, reset 까지 남은 시간
- 임계값 알림: 80%, 95% 도달 시 SNS → 이메일/Slack
- 차단 시: Claude Code가 받는 `AccessDeniedException` 메시지에 reset 시각·대시보드 링크 포함

## Changes

### 새로 추가
- **`cdk/lib/08-local-governance-stack.ts`** — STS Issuer Lambda, per-user role factory(MaxSessionDuration=12h), Application Inference Profile per dept, `cc-on-bedrock-limits` 테이블, `token-limit-enforcer` Lambda (DynamoDB Stream consumer)
- **STS Issuer Lambda** (`cdk/lib/lambda/sts-issuer.py`) — Cognito ID 토큰 검증 → `sts:AssumeRole`(DurationSeconds=28800) → 8h 자격증명 반환
- **Token Limit Enforcer Lambda** (`cdk/lib/lambda/token-limit-enforcer.py`) — DynamoDB Stream에서 usage 업데이트 수신 → 합산 normalized tokens 조회 → 한도 초과 시 user role에 Deny policy attach
- **Limit Reset Lambda** (`cdk/lib/lambda/limit-reset.py`) — EventBridge cron(일/주/월) → Deny detach + 카운터 리셋
- **Dashboard 페이지** `shared/nextjs-app/app/local/page.tsx` — "Get Credentials" 버튼, `aws configure` 스니펫, 남은 토큰 게이지
- **Dashboard 관리 페이지** `shared/nextjs-app/app/admin/limits/page.tsx` — 사용자/부서 normalized token 한도 CRUD
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
- 자격증명 TTL: **8시간**, `MaxSessionDuration=12h`. IAM은 호출 시점 평가이므로 Deny 부착은 이미 발급된 세션에도 즉시 적용됨
- Local PC 도난 대비: 부서 관리자 콘솔에서 즉시 role disable 가능
- VPN/IP 제한 옵션: IAM condition `aws:SourceIp` 부서 정책에 따라
- 모델 제한: 승인된 모델 ARN 외 호출 시 IAM Deny
- 감사: 모든 호출 CloudTrail에 기록, principal = user role
- 한도 초과 차단: `token-limit-enforcer`가 부착하는 Deny policy는 reset 스케줄까지 유지

## Consequences

### Positive
- **EC2 운영 부담 제거** — AMI 관리, 하이버네이션, 디스크 lifecycle, idle 비용 없음 (governanceOnly 프로파일)
- **사용자 도구체인 유지** — 개발자가 본인 IDE/플러그인/디버거를 그대로 쓰면서 Bedrock만 회사 자격으로 호출
- **기존 추적 파이프라인 재사용** — `bedrock-usage-tracker.py` + DynamoDB + dashboard 그대로. 신규 인프라는 STS Issuer Lambda + per-user IAM role 팩토리 + limits 테이블만 추가
- **즉각 차단 가능** — IAM이 호출 시점 평가이므로 Deny policy 부착이 이미 발급된 세션에도 즉시 적용
- **부서별 cost attribution** — Application Inference Profile + IAM role 태그(`username`/`department`/`project`)로 CUR 2.0에 부서별 청구 분리
- **EC2 모드와 공존** — 동일 계정에서 두 프로파일 병행 운영 가능 (기본 배포), 또는 `governanceOnly=true`로 Local 단독 배포

### Negative
- **차단 latency 1-3분** — Bedrock Invocation Logging 지연이 하한 (게이트웨이 없이 단축 불가). 한도 ~5% 안전 마진 운영 필요
- **프롬프트 단위 DLP** — Bedrock Guardrails에 의존, 커스텀 inline 룰 한계
- **자격증명 유출 노출창 8h** — Deny policy 또는 role disable로 즉시 차단은 가능하나 노출창 자체는 STS TTL에 종속
- **IAM role 인플레이션** — 사용자당 1개 role 누적. AWS 계정 IAM role 한도(기본 1,000)에 근접 시 페이즈드 cleanup 필요
- **개발자 PC가 신뢰 경계** — 멀티유저 PC, 키체인 미사용 환경에서는 추가 통제(VPN, MFA on STS Issuer endpoint) 필요

### Out of Scope
- **실시간(<1초) 쿼터 enforcement** — 필요 시 ADR-014 Phase 2 (LLM Gateway, Fargate) 별도 검토
- **프롬프트 텍스트 감사 저장** — 비용/PII 관점에서 의도적 미포함 (`textDataDeliveryEnabled=false`)

## Limitations
- **차단 latency 1-3분** — 위 Negative 항목 참조
- **프롬프트 단위 DLP** — 위 Negative 항목 참조
- **자격증명 유출 시** — 위 Negative 항목 참조

## Future Work
- Phase 2: LLM Gateway 옵션 (Fargate Serverless) — 실시간 쿼터/고급 DLP 필요 조직 대상 별도 ADR
- 로컬 CLI에 사용량 실시간 표시 (DynamoDB 쿼리 API 추가)
- SSO Federation (ADR-008)과 통합한 SAML/OIDC 자격증명 발급

## References
- ADR-004: EC2 per-user DevEnv (대비)
- ADR-011: Bedrock IAM Cost Allocation (재사용 정책)
- ADR-006: Department Budget Management (재사용)
- ADR-008: Enterprise SSO Federation
- ADR-015: Dollar Budget × Normalized Token Limit Integration (두 축 통합)
