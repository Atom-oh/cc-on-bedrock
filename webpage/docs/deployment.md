---
sidebar_position: 5
---

# 배포 가이드 (Deployment Guide)

import DeploymentFlow from '@site/src/components/diagrams/DeploymentFlow';
import Screenshot from '@site/src/components/Screenshot';

CC-on-Bedrock을 AWS 계정에 배포하기 위한 전체 과정과 아키텍처 원리를 설명합니다.

<DeploymentFlow />

## Prerequisites (요구사항)

| 항목 | 요구사항 |
|------|----------|
| **AWS 계정** | AdministratorAccess 권한이 있는 IAM 사용자/역할 |
| **Region** | `ap-northeast-2` (Seoul) — 다른 리전 사용 시 inference profile ID도 함께 변경 필요 |
| **Node.js** | v20 이상 (CDK + Next.js dashboard) |
| **AWS CDK CLI** | `npm install -g aws-cdk` |
| **Docker** | 컨테이너 이미지 빌드용 (ARM64 build host 권장) |
| **Domain (Optional)** | Route 53 hosted zone — CloudFront 사용자 정의 도메인 + ACM 인증서 |

## 배포 프로파일 선택

| 프로파일 | 명령 | 포함되는 스택 |
|---|---|---|
| **EC2 + Local 공존 (기본)** | `cdk deploy --all` | 1~8 전체 |
| **Local Governance Only** | `cdk deploy --all -c governanceOnly=true` | 1~6, 8 (7 EC2 DevEnv 스킵) |

배포 후 같은 클러스터에 두 모드를 동시에 운영할 수 있습니다 — 사용자별로
EC2 인스턴스 또는 본인 PC `cc-bedrock-local` 둘 다 골라 쓸 수 있게 두는 게
일반적인 패턴입니다.

## 배포 단계 상세

### Step 1: Network (01-Network)

VPC와 보안의 기초가 되는 네트워크 환경.

- **VPC**: `10.100.0.0/16` 대역, 2개 AZ (Public + Private + Isolated subnet)
- **NAT Gateway**: Private subnet의 outbound 트래픽
- **VPC Endpoints**: S3, DynamoDB, Bedrock Runtime, KMS, Secrets Manager (인터넷 경유 X) — EC2 DevEnv 트래픽 한정. Local Governance Mode는 사용자 PC에서 public AWS API endpoint로 직접 호출하므로 VPC Endpoint 경로를 타지 않습니다.
- **DNS Firewall**: AWS Managed + 사용자 정의 차단 목록
- **Route 53**: hosted zone (있으면 import, 없으면 hosted zone 별도 생성 후 NS 위임)

### Step 2: Security (02-Security)

인증 / 암호화 / 권한 경계.

- **Cognito**: User Pool + App Client (`USER_PASSWORD_AUTH` 활성화), custom 속성
  (`custom:department`, `custom:project`)
- **ACM**: Dashboard용 + DevEnv용 wildcard 인증서 (`*.{domain}`, `*.dev.{domain}`).
  CloudFront WAF용은 us-east-1에 별도 발급 (ADR-016)
- **KMS**: 모든 DynamoDB / SQS / Logs에 사용하는 customer-managed CMK
- **Secrets Manager**: code-server 비밀번호, NextAuth 시크릿, CloudFront secret
- **IAM**: Dashboard role, Permission Boundary (`cc-on-bedrock-task-boundary`)

### Step 3: Usage Tracking (03-Usage Tracking)

서버리스 방식의 사용량 추적 + 예산/한도 자동 집행.

- **Bedrock invocation logging** → CloudWatch Logs (`textDataDeliveryEnabled: false`로
  비용 ~99% 절감)
- **Subscription Filter** — `bedrock-usage-tracker` Lambda가 IAM role prefix
  (`cc-on-bedrock-task-*`, `cc-on-bedrock-local-user-*`) 기준 필터링 (ADR-019)
- **DynamoDB**: `cc-on-bedrock-usage` (Streams enabled), `cc-user-budgets`,
  `cc-on-bedrock-cli-tokens`, `cc-approval-requests`, `cc-prompt-audit`,
  `cc-mcp-catalog`, `cc-dept-mcp-config`
- **budget-check Lambda** — 5분 주기, USD 예산 80% / 100% 도달 시 SNS + IAM Deny
- **ec2-idle-stop Lambda** — 유휴 EC2 자동 Stop (CloudWatch 메트릭 기반)
- **audit-logger Lambda** — Bedrock 호출 prompt audit
- **gateway-manager Lambda** — `dept_mcp_config` Streams → MCP Gateway 동기화

### Step 4: ECS DevEnv 라우팅 (04-ECS, ADR-016)

DevEnv 트래픽 경로 + DevEnv CloudFront.

- **NLB** (internal) — DevEnv CloudFront origin (CloudFront prefix list만 허용, port 80)
- **Nginx Fargate** — 2 task HA, DynamoDB routing table → S3 → 5초 hot-reload pipeline
- **Lambda nginx-config-gen** — routing table 변경 감지 → nginx config 재생성
- **DevEnv CloudFront** (`*.dev.<domain>`) — viewer-request Lambda@Edge
  `session-validator`가 NextAuth JWE 쿠키 검증 후 NLB origin으로 전달

### Step 5: Dashboard (05-Dashboard, ADR-016)

중앙 집중식 관리 + AI 비서.

- **Next.js Standalone** — ECS task (rolling deployment + circuit breaker, ADR-017)
- **ALB** — Dashboard CloudFront origin (CloudFront prefix list만 허용)
- **Dashboard CloudFront** (`<dashboardSubdomain>.<domain>`) — ALB origin 직결
- ADR-016 split 이후 host 기반 origin 분기용 `devenv-origin-router` Lambda@Edge는
  더 이상 사용되지 않습니다 (각 distribution이 단일 origin만 가짐)

### Step 6: WAF (06-WAF)

CloudFront-scope WebACL (`us-east-1`):
- AWS Managed Common Rule Set
- 사용자 정의 rate limit / IP allowlist 추가 가능

:::note 배포 순서 vs 스택 번호
스택 번호와 실제 의존성 순서는 다릅니다. WAF(06)는 DevEnv CF(Stack 04)와
Dashboard CF(Stack 05)가 참조하므로 **WAF가 먼저 배포돼야** 합니다 — 즉
실제 순서는 `01 → 02 → 03 → 06 → 04 → 05 → 07 → 08`. `cdk deploy --all`은
`Stack.addDependency()` 그래프로 자동 정렬하므로 사용자가 신경 쓸 필요는
없습니다.
:::

### Step 7: EC2 DevEnv (07-EC2 DevEnv)

(`governanceOnly=true`로 배포 시 이 단계 스킵)

- **Launch Template** — ARM64 t4g.large, Ubuntu 24.04 또는 AL2023 (ADR-018)
  - User-data가 부팅 시 SSM Parameter Store에서 Cognito Client ID/Secret 로드
  - cloud-init이 code-server + Claude Code CLI + Kiro CLI 설치 / 시작
- **DLP Security Groups** (ADR-005) — open / restricted / locked 3-tier
- **Hibernation 지원** (ADR-010) — 60일 rotation 한도 내에서 ~5초 resume
- **per-user IAM role + Instance Profile** — Dashboard API가 RunInstances 직전 생성

### Step 8: Local Governance (08-Local Governance, ADR-014)

EC2 없이 사용자가 본인 PC에서 `claude` 직접 실행할 수 있도록 함:

- **STS Issuer Lambda + Function URL** (IAM auth) — Dashboard만 호출 가능
- **`cc-on-bedrock-limits` DynamoDB** — per-user / per-dept normalized-token 상태
- **token-limit-enforcer Lambda** — usage table Stream 소비, 한도 초과 시
  `DENY#active` row + IAM Deny policy attach
- **limit-reset Lambda** — daily / weekly / monthly cron (KST)
- **UserRoleProvisioner Lambda + EventBridge** (ADR-022) — Cognito 사용자
  AdminCreateUser 즉시 per-user role 사전 생성 (race condition 제거)
- **SNS** — 한도 도달 알림

설정 / 사용은 [Local Governance Mode](./local-mode.md) 문서.

## 배포 후 검증

```bash
# 도메인 기반 검증
bash scripts/verify-deployment.sh {your-domain}

# 컨테이너 통합 테스트
bash tests/docker/test-devenv.sh

# E2E
bash tests/integration/test-e2e.sh
```

## 아키텍처 작동 원리 (How it works)

### 1. EC2 모드 사용자 접속 흐름

1. 사용자가 `{subdomain}.dev.{domain}` 접속
2. **DevEnv CloudFront** → viewer-request Lambda@Edge `session-validator`가
   NextAuth JWE 쿠키 검증. 없으면 Dashboard 로그인으로 redirect
3. **DevEnv CloudFront** → 단일 NLB origin으로 직접 전달 (ADR-016 split 이후
   host-based origin 분기 Lambda@Edge 없음)
4. **NLB** → **Nginx Fargate** → 사용자 EC2 (`{subdomain}` → IP 매핑은 DynamoDB
   routing table에서 5초 단위 hot-reload)
5. 사용자는 브라우저에서 **code-server**로 개발 진행

### 2. Local 모드 사용자 접속 흐름

1. 사용자가 본인 PC `cc-bedrock-local login`
2. CLI가 Cognito `USER_PASSWORD_AUTH` → JWT 획득
3. CLI가 `/api/local/credentials` 호출 (Bearer)
4. Dashboard가 STS Issuer Lambda invoke (IAM auth)
5. Lambda가 `ensure_role` + AssumeRole 1h → STS 자격증명 반환
6. CLI가 `~/.aws/credentials [cc-bedrock]`에 기록, `claude` 실행 시 자동 사용

### 3. AI 비서 호출 흐름

1. **대시보드 `/ai`**: Browser → Next.js API → Bedrock Converse API
2. **Claude Code (EC2)**: terminal → Instance Profile credentials → Bedrock InvokeModel
3. **Claude Code (Local)**: terminal → STS credentials → Bedrock InvokeModel
4. **사용량 기록**: Bedrock invocation logging → CloudWatch Logs → Subscription
   filter → `bedrock-usage-tracker` Lambda → DynamoDB

:::tip 인프라 선택
본 프로젝트는 **CDK, Terraform, CloudFormation** 세 가지 방식을 모두 지원합니다.
각 폴더 (`cdk/`, `terraform/`, `cloudformation/`)의 CLAUDE.md를 참고하여
선호하는 도구로 배포하세요. 세 가지 모두 동일한 인프라를 만들어냅니다 (parity).
:::

:::warning Terraform parity 주의
현재 `terraform/modules/` 디렉토리에는 `network / security / ecs-devenv / dashboard`
4개만 구현되어 있고 root `main.tf`에서 사용 중입니다. 나머지 4개
(`usage-tracking / local-governance / ec2-devenv / waf`)는 **모듈 자체가
아직 추가되지 않은 상태**이며 후속 PR에서 모듈 작성 + root wiring을 함께
진행합니다. 그 때까지 전 기능을 쓰려면 CDK 또는 CloudFormation을 사용하세요.
:::
