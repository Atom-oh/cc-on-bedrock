# 소개 (Introduction)

**CC-on-Bedrock**은 AWS Bedrock을 활용한 멀티유저 Claude Code 개발 플랫폼입니다.

두 가지 배포 프로파일을 지원합니다.

| 모드 | 사용 방식 | 인프라 비용 | 거버넌스 |
|---|---|---|---|
| **EC2-per-user DevEnv** (ADR-004) | 사용자별 전용 EC2 (ARM64) + 브라우저 code-server | EC2 + EBS 시간당 | 동일 |
| **Local Governance** (ADR-014) | 사용자 PC에서 `claude` 직접 실행, Dashboard에서 8h STS 자격증명 발급 | 0 (Bedrock 호출만 과금) | 동일 |

두 모드는 같은 클러스터에 **공존 가능**합니다. 인프라는 CDK(TypeScript) /
Terraform(HCL) / CloudFormation(YAML) 세 가지 IaC 도구로 동일하게 구현되어
있습니다.

## 주요 특징

- **Bedrock Direct Mode**: Claude Code가 per-user IAM Role(EC2) 또는 STS
  자격증명(Local)으로 Bedrock을 직접 호출 (LiteLLM 같은 proxy 없음)
- **사용자별 IAM 역할 (ADR-022)**: Cognito 사용자 가입 시 EventBridge로
  IAM role과 Cognito custom 속성을 사전 프로비저닝. 첫 로그인 race condition 제거
- **하이브리드 AI**: 대시보드는 Converse API(빠른 스트리밍 + 5개 tool),
  Slack/외부 채널은 AgentCore Runtime + per-department MCP Gateway 사용
- **7계층 보안**: CloudFront → ALB/NLB → Cognito → Security Groups (DLP 3단계) →
  VPC Endpoints → DNS Firewall → IAM Permission Boundary + Bedrock model 제어
- **이중 거버넌스 모델 (ADR-015)**: USD 예산(`budget-check` Lambda 5분 주기) +
  Normalized 토큰 한도(`token-limit-enforcer` Lambda, usage table Stream 소비)
- **서버리스 사용량 추적**: Bedrock invocation logging → CloudWatch Logs →
  Subscription Filter → `bedrock-usage-tracker` Lambda → DynamoDB (ADR-019)

## Bedrock 모델

기본 inference profile (ap-northeast-2):

| 모델 | Inference Profile ID |
|---|---|
| **Claude Opus 4.7** | `global.anthropic.claude-opus-4-7` |
| **Claude Opus 4.6** | `global.anthropic.claude-opus-4-6-v1[1m]` |
| **Claude Sonnet 4.6** | `global.anthropic.claude-sonnet-4-6` |
| **Claude Haiku 4.5** | `us.anthropic.claude-haiku-4-5-20251001-v1:0` |

IAM은 ADR-021의 wildcard Claude family ARN으로 부여돼 신규 Claude 모델이
추가되면 IAM 변경 없이 즉시 사용 가능합니다.

## 시스템 아키텍처 요약

![Architecture](/img/cconbedrock_arch.png)

시스템은 8개 스택으로 구성됩니다 (CDK Stack 번호 기준):

1. **Network (01)** — VPC, Subnets, NAT, VPC Endpoints, DNS Firewall, Route 53
2. **Security (02)** — Cognito User Pool, ACM, KMS, Secrets Manager, IAM 기반 role
3. **Usage Tracking (03)** — Bedrock invocation logging + DynamoDB usage table + tracker/budget-check Lambdas + EventBridge crons (ADR-019)
4. **ECS Dashboard 인프라 (04)** — NLB + Nginx Fargate + DynamoDB routing table (사용자별 라우팅)
5. **Dashboard (05)** — Next.js Standalone + ECS task + 통합 CloudFront + Lambda@Edge (ADR-013)
6. **WAF (06)** — CLOUDFRONT-scope WebACL (us-east-1)
7. **EC2 DevEnv (07)** — Launch Template + DLP Security Groups (3-tier: open/restricted/locked) + Hibernation 지원 (ADR-004/010)
8. **Local Governance (08)** — STS Issuer Lambda + Function URL, `cc-on-bedrock-limits` table, token-limit-enforcer, limit-reset cron, UserRoleProvisioner Lambda (ADR-014/022/024)

`cdk deploy -c governanceOnly=true`로 배포하면 7번(EC2 DevEnv)은 스킵하고
Local Governance Mode만 띄울 수 있습니다.
