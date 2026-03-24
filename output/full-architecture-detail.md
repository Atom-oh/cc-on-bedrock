> **Language / 언어**: [한국어](#ko) | [English](#en)

---

<a id="ko"></a>

<a id="ko-system-overview"></a>

# CC-on-Bedrock 전체 아키텍처 상세

## 1. 전체 시스템 구성도

```
                                    ┌─────────────────────────────────────┐
                                    │         Internet / Users            │
                                    └──────────┬──────────┬───────────────┘
                                               │          │
                                    ┌──────────▼──┐  ┌────▼──────────┐
                                    │ CloudFront  │  │  CloudFront   │
                                    │ Dashboard   │  │  DevEnv       │
                                    │ (HTTPS)     │  │  (HTTPS)      │
                                    └──────┬──────┘  └─────┬─────────┘
                                           │               │
                                    X-Custom-Secret    X-Custom-Secret
                                           │               │
                              ┌────────────▼───┐    ┌──────▼──────────┐
                              │  ALB           │    │  ALB            │
                              │  (Dashboard)   │    │  (DevEnv)       │
                              │  Prefix List   │    │  Host Routing   │
                              └───────┬────────┘    └──────┬──────────┘
                                      │                    │
                   ┌──────────────────▼────────┐    ┌──────▼──────────────────┐
                   │  Stack 05: Dashboard       │    │  Stack 04: ECS DevEnv   │
                   │  ┌──────────────────────┐  │    │  ┌────────────────────┐ │
                   │  │  EC2 ASG (t4g.xl)    │  │    │  │  ECS Cluster       │ │
                   │  │  Next.js Standalone   │  │    │  │  EC2 Mode (x8)     │ │
                   │  │  PM2 Process Manager  │  │    │  │  m7g.4xlarge       │ │
                   │  │  Port 3000            │  │    │  │                    │ │
                   │  └──────────┬───────────┘  │    │  │  ┌──────────────┐  │ │
                   │             │               │    │  │  │ Task: admin01│  │ │
                   │  ┌──────────▼───────────┐  │    │  │  │ Task: ds01   │  │ │
                   │  │  7 Pages:            │  │    │  │  │ Task: eng04  │  │ │
                   │  │  Home, AI, Analytics │  │    │  │  │ ... (15개)   │  │ │
                   │  │  Monitoring, Security│  │    │  │  └──────┬───────┘  │ │
                   │  │  Users, Containers   │  │    │  │         │          │ │
                   │  └──────────────────────┘  │    │  │  ┌──────▼───────┐  │ │
                   └────────────────────────────┘    │  │  │ code-server  │  │ │
                                                     │  │  │ Claude Code  │  │ │
                                                     │  │  │ Kiro CLI     │  │ │
                                                     │  │  └──────┬───────┘  │ │
                                                     │  └─────────│──────────┘ │
                                                     │            │            │
                                                     │  ┌─────────▼──────────┐ │
                                                     │  │  EFS               │ │
                                                     │  │  /users/{subdomain}│ │
                                                     │  └────────────────────┘ │
                                                     └────────────────────────┘
```

---

<a id="ko-network-architecture"></a>

## 2. 네트워크 아키텍처

```
┌──────────────────────────────────────────────────────────────────────┐
│  VPC: 10.100.0.0/16 (cc-on-bedrock-vpc)                            │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │  Public Subnets (2 AZ)                                       │    │
│  │                                                               │    │
│  │  ┌─────────────┐  ┌─────────────┐  ┌────────┐  ┌────────┐  │    │
│  │  │ ALB DevEnv  │  │ ALB Dashboard│  │ NAT GW │  │ NAT GW │  │    │
│  │  │             │  │              │  │  AZ-a  │  │  AZ-c  │  │    │
│  │  └─────────────┘  └─────────────┘  └────────┘  └────────┘  │    │
│  └──────────────────────────────────────────────────────────────┘    │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │  Private Subnets (2 AZ)                                      │    │
│  │                                                               │    │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐       │    │
│  │  │ ECS Host x8  │  │ Dashboard EC2│  │ EFS Mount    │       │    │
│  │  │ (m7g.4xl)    │  │ (t4g.xl)     │  │ Targets      │       │    │
│  │  └──────────────┘  └──────────────┘  └──────────────┘       │    │
│  └──────────────────────────────────────────────────────────────┘    │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │  VPC Endpoints (8개) — Private Link                          │    │
│  │                                                               │    │
│  │  Bedrock Runtime  │  ECR API  │  ECR DKR  │  S3             │    │
│  │  SSM              │  SSM Messages │  CloudWatch Logs         │    │
│  │  ec2messages                                                  │    │
│  └──────────────────────────────────────────────────────────────┘    │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │  DNS Firewall                                                │    │
│  │  5개 AWS 관리 위협 리스트 + 커스텀 차단                        │    │
│  └──────────────────────────────────────────────────────────────┘    │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

---

<a id="ko-ai-assistant-architecture"></a>

## 3. AI Assistant 하이브리드 아키텍처

```
┌─────────────────────────────────────────────────────────────────────────┐
│                                                                         │
│  ┌─── Dashboard (빠른 실시간 스트리밍) ──────────────────────────────┐  │
│  │                                                                     │  │
│  │  Browser                                                            │  │
│  │    │                                                                │  │
│  │    │ POST /api/ai (SSE)                                             │  │
│  │    ▼                                                                │  │
│  │  Next.js API Route                                                  │  │
│  │    │                                                                │  │
│  │    ├─── ConverseStreamCommand ──────────────────→ Bedrock          │  │
│  │    │    (토큰 단위 실시간 스트리밍)                   Sonnet 4.6    │  │
│  │    │                                                                │  │
│  │    ├─── Tool Use (최대 5회 루프)                                    │  │
│  │    │    ├── get_container_status  → ECS API (직접)                  │  │
│  │    │    ├── get_container_metrics → CloudWatch API (직접)           │  │
│  │    │    └── get_platform_summary  → ECS + CW 조합                  │  │
│  │    │                                                                │  │
│  │    └─── SSE: data: {"text":"..."} (실시간)                         │  │
│  │                                                                     │  │
│  │  응답 시간: 1~5초 | Tool: 3개 | 스트리밍: 실시간                    │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
│                                                                         │
│  ┌─── Slack/외부 (멀티 클라이언트 공유) ─────────────────────────────┐  │
│  │                                                                     │  │
│  │  Slack Bot / CLI / API Client                                       │  │
│  │    │                                                                │  │
│  │    │ POST /api/ai/runtime (JSON)                                    │  │
│  │    ▼                                                                │  │
│  │  Next.js API Route                                                  │  │
│  │    │                                                                │  │
│  │    │ InvokeAgentRuntimeCommand                                      │  │
│  │    ▼                                                                │  │
│  │  AgentCore Runtime (cconbedrock_assistant_v2)                       │  │
│  │    │  Strands Agent + BedrockModel (Sonnet 4.6)                     │  │
│  │    │  PUBLIC network mode                                           │  │
│  │    │                                                                │  │
│  │    │ MCPClient (SigV4 signed)                                       │  │
│  │    ▼                                                                │  │
│  │  AgentCore Gateway (cconbedrock-gateway)                            │  │
│  │    │  MCP Protocol                                                  │  │
│  │    │                                                                │  │
│  │    ├──→ Lambda: cconbedrock-ecs-mcp                                │  │
│  │    │    ├── get_container_status (ECS API)                          │  │
│  │    │    └── get_efs_info (EFS API)                                  │  │
│  │    │                                                                │  │
│  │    ├──→ Lambda: cconbedrock-cloudwatch-mcp                         │  │
│  │    │    └── get_container_metrics (CloudWatch API)                  │  │
│  │    │                                                                │  │
│  │    └──→ Lambda: cconbedrock-dynamodb-mcp                           │  │
│  │         ├── get_spend_summary (DynamoDB)                            │  │
│  │         ├── get_budget_status (DynamoDB)                            │  │
│  │         ├── get_system_health (DynamoDB + ECS)                      │  │
│  │         ├── get_user_usage (DynamoDB)                               │  │
│  │         └── get_department_usage (DynamoDB)                         │  │
│  │                                                                     │  │
│  │  응답 시간: 10~20초 | Tool: 8개 | 멀티 클라이언트 공유              │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
│                                                                         │
│  ┌─── AgentCore Memory (공유) ───────────────────────────────────────┐  │
│  │                                                                     │  │
│  │  POST /api/ai/memory (저장)                                         │  │
│  │  GET  /api/ai/memory (조회)                                         │  │
│  │                                                                     │  │
│  │  Memory ID: cconbedrock_memory-pHqYq73dKd                          │  │
│  │  Session: session_{sanitized_email}                                 │  │
│  │  Actor: {sanitized_email}                                           │  │
│  │                                                                     │  │
│  │  CreateEventCommand / ListEventsCommand                             │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

<a id="ko-usage-tracking-pipeline"></a>

## 4. 사용량 추적 파이프라인

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  ECS Task    │     │  CloudTrail  │     │  EventBridge │     │   Lambda     │
│  (Claude     │────>│  (API 로그)  │────>│  (이벤트     │────>│  (usage-     │
│   Code)      │     │              │     │   라우팅)    │     │   tracker)   │
└──────────────┘     └──────────────┘     └──────────────┘     └──────┬───────┘
                                                                      │
                     ┌──────────────┐                          ┌──────▼───────┐
                     │  Lambda      │     5분마다              │  DynamoDB    │
                     │  (budget-    │◄─────────────────────────│  (cc-on-     │
                     │   check)     │                          │   bedrock-   │
                     └──────┬───────┘                          │   usage)     │
                            │                                  └──────▲───────┘
                     ┌──────▼───────┐                                 │
                     │  80% 경고    │                          ┌──────┘
                     │  → SNS 알림  │                          │ 조회
                     │              │                   ┌──────┴───────┐
                     │  100% 초과   │                   │  Dashboard   │
                     │  → IAM Deny  │                   │  Analytics   │
                     │  → Cognito   │                   │  페이지      │
                     │    플래그    │                   └──────────────┘
                     └──────────────┘
```

---

<a id="ko-auth-access-control"></a>

## 5. 인증 및 접근 제어

```
┌──────────────────────────────────────────────────────────────────────┐
│  인증 흐름                                                           │
│                                                                      │
│  ┌──── Dashboard 로그인 (OAuth 2.0) ────────────────────────────┐   │
│  │                                                                │   │
│  │  Browser → CloudFront → Dashboard (Next.js)                    │   │
│  │    │                                                           │   │
│  │    │ NextAuth "Sign in with Cognito"                           │   │
│  │    ▼                                                           │   │
│  │  Cognito Hosted UI (cc-on-bedrock.auth.amazoncognito.com)      │   │
│  │    │                                                           │   │
│  │    │ Authorization Code Grant                                  │   │
│  │    ▼                                                           │   │
│  │  Callback → JWT Token                                          │   │
│  │    │                                                           │   │
│  │    │ Cookie: next-auth.session-token (secure:false for ALB)    │   │
│  │    ▼                                                           │   │
│  │  Middleware: getToken() → 그룹 기반 라우팅                      │   │
│  │    ├── admin 그룹 → 전체 7페이지                                │   │
│  │    └── user 그룹  → Home, AI, Analytics                        │   │
│  └────────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  ┌──── DevEnv 접속 (code-server) ────────────────────────────────┐   │
│  │                                                                │   │
│  │  Browser → CloudFront → ALB (Host 라우팅) → ECS Task           │   │
│  │    │                                                           │   │
│  │    │ code-server 패스워드: CcOnBedrock2026!                    │   │
│  │    ▼                                                           │   │
│  │  VS Code 개발환경 (code-server:8080)                           │   │
│  │    │                                                           │   │
│  │    │ Claude Code → CLAUDE_CODE_USE_BEDROCK=1                   │   │
│  │    │ → ECS Task Role → IMDS → Bedrock VPC Endpoint             │   │
│  │    ▼                                                           │   │
│  │  Amazon Bedrock (Sonnet 4.6 / Opus 4.6)                       │   │
│  └────────────────────────────────────────────────────────────────┘   │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

---

<a id="ko-iam-role-mapping"></a>

## 6. IAM 역할 매핑

```
┌─────────────────────────────────────────────────────────────────────┐
│                                                                     │
│  ┌─────────────────────────────┐  ┌──────────────────────────────┐ │
│  │  ECS Task Role              │  │  ECS Task Execution Role     │ │
│  │  (cc-on-bedrock-ecs-task)   │  │  (cc-on-bedrock-ecs-task-    │ │
│  │                             │  │   execution)                 │ │
│  │  bedrock:InvokeModel     ✓  │  │                              │ │
│  │  bedrock:Converse        ✓  │  │  ecr:GetDownloadUrlForLayer ✓│ │
│  │  bedrock:ConverseStream  ✓  │  │  ecr:BatchGetImage         ✓│ │
│  │  s3:GetObject/PutObject  ✓  │  │  logs:CreateLogGroup       ✓│ │
│  │  logs:CreateLogStream    ✓  │  │  secretsmanager:GetSecret  ✓│ │
│  └─────────────────────────────┘  └──────────────────────────────┘ │
│                                                                     │
│  ┌─────────────────────────────┐  ┌──────────────────────────────┐ │
│  │  Dashboard EC2 Role         │  │  AgentCore Lambda Role       │ │
│  │  (cc-on-bedrock-dashboard-  │  │  (cc-on-bedrock-agentcore-   │ │
│  │   ec2)                      │  │   lambda)                    │ │
│  │                             │  │                              │ │
│  │  ecs:RunTask/StopTask    ✓  │  │  ecs:ListTasks/Describe   ✓│ │
│  │  ecs:TagResource         ✓  │  │  cloudwatch:GetMetricData ✓│ │
│  │  cognito-idp:Admin*      ✓  │  │  dynamodb:Scan/Query      ✓│ │
│  │  dynamodb:Scan/Query     ✓  │  │  efs:DescribeFileSystems  ✓│ │
│  │  bedrock:InvokeModel     ✓  │  │  kms:Decrypt              ✓│ │
│  │  bedrock-agentcore:*     ✓  │  └──────────────────────────────┘ │
│  │  elasticloadbalancing:*  ✓  │                                   │
│  │  cloudwatch:GetMetric    ✓  │  ┌──────────────────────────────┐ │
│  │  cloudtrail:LookupEvents ✓  │  │  AgentCore Gateway Role     │ │
│  │  iam:PassRole            ✓  │  │  (cc-on-bedrock-agentcore-   │ │
│  └─────────────────────────────┘  │   gateway)                   │ │
│                                    │                              │ │
│  ┌─────────────────────────────┐  │  lambda:InvokeFunction    ✓│ │
│  │  AgentCore Runtime Role     │  │  (cconbedrock-* functions)  │ │
│  │  (AWSopsAgentCoreRole)      │  └──────────────────────────────┘ │
│  │                             │                                   │
│  │  bedrock:InvokeModel     ✓  │  ┌──────────────────────────────┐ │
│  │  ecr:*                   ✓  │  │  Budget Check Lambda Role    │ │
│  │  lambda:InvokeFunction   ✓  │  │  (in UsageTracking stack)    │ │
│  └─────────────────────────────┘  │                              │ │
│                                    │  dynamodb:Scan             ✓│ │
│                                    │  ecs:StopTask              ✓│ │
│                                    │  cognito-idp:AdminUpdate   ✓│ │
│                                    │  sns:Publish               ✓│ │
│                                    └──────────────────────────────┘ │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

<a id="ko-security-7layers"></a>

## 7. 보안 7계층

```
Layer 1  ┌────────────────────────────────────────────────┐
         │  CloudFront                                     │
         │  HTTPS (TLS 1.2+), AWS Shield DDoS 방어         │
         │  ACM *.whchoi.net 와일드카드 인증서              │
         └────────────────────┬───────────────────────────┘
                              │
Layer 2  ┌────────────────────▼───────────────────────────┐
         │  ALB                                            │
         │  CloudFront Prefix List (직접 접근 차단)         │
         │  X-Custom-Secret 헤더 검증                       │
         │  Host 기반 라우팅 (*.dev.whchoi.net)             │
         └────────────────────┬───────────────────────────┘
                              │
Layer 3  ┌────────────────────▼───────────────────────────┐
         │  Cognito OAuth 2.0                              │
         │  Hosted UI (cc-on-bedrock.auth.amazoncognito)   │
         │  admin/user 그룹 기반 접근 제어                  │
         │  JWT 세션 토큰 (8시간)                           │
         └────────────────────┬───────────────────────────┘
                              │
Layer 4  ┌────────────────────▼───────────────────────────┐
         │  Security Groups (3-tier DLP)                   │
         │  Open: 0.0.0.0/0 (전체 아웃바운드)              │
         │  Restricted: VPC CIDR + 화이트리스트             │
         │  Locked: VPC CIDR only (인터넷 차단)            │
         └────────────────────┬───────────────────────────┘
                              │
Layer 5  ┌────────────────────▼───────────────────────────┐
         │  VPC Endpoints (Private Link)                   │
         │  Bedrock, ECR, SSM, CloudWatch, S3              │
         │  인터넷 경유 없는 AWS 서비스 접근                │
         └────────────────────┬───────────────────────────┘
                              │
Layer 6  ┌────────────────────▼───────────────────────────┐
         │  DNS Firewall                                   │
         │  5개 AWS 관리 위협 도메인 리스트                  │
         │  커스텀 차단 도메인                               │
         │  VPC 레벨 DNS 쿼리 필터링                        │
         └────────────────────┬───────────────────────────┘
                              │
Layer 7  ┌────────────────────▼───────────────────────────┐
         │  IAM + Application                              │
         │  Bedrock 모델별 접근 제어 (Opus/Sonnet/Haiku)   │
         │  사용자별 Task Role                              │
         │  예산 초과 → IAM Deny Policy 동적 부착           │
         │  code-server DLP (파일 업/다운로드 제한)         │
         │  IMDSv2 강제                                    │
         └────────────────────────────────────────────────┘
```

---

<a id="ko-stack-dependencies"></a>

## 8. 스택 구성 및 의존성

```
┌─────────────────────────────────────────────────────────────────────┐
│                                                                     │
│  Stack 01: Network                                                  │
│  ├── VPC (10.100.0.0/16)                                           │
│  ├── Public Subnets (2 AZ)                                         │
│  ├── Private Subnets (2 AZ)                                        │
│  ├── NAT Gateway (x2)                                              │
│  ├── VPC Endpoints (8)                                              │
│  ├── Route 53 Hosted Zone                                           │
│  └── DNS Firewall                                                   │
│       │                                                             │
│       ▼                                                             │
│  Stack 02: Security                                                 │
│  ├── Cognito User Pool + Hosted UI (cc-on-bedrock)                 │
│  ├── Cognito User Pool Client (OAuth)                               │
│  ├── ACM Certificates (*.whchoi.net)                               │
│  ├── KMS Encryption Key                                             │
│  ├── Secrets Manager (NextAuth, CloudFront)                        │
│  ├── IAM: ECS Task Role + Execution Role                           │
│  ├── IAM: Dashboard EC2 Role                                       │
│  └── Cognito Groups: admin, user                                    │
│       │                                                             │
│       ├─────────────────────────┐                                   │
│       ▼                         ▼                                   │
│  Stack 03: Usage Tracking  Stack 04: ECS DevEnv                     │
│  ├── DynamoDB Table        ├── ECS Cluster (EC2 mode)               │
│  │   (cc-on-bedrock-usage) ├── EC2 ASG (m7g.4xlarge x8)            │
│  ├── Lambda: usage-tracker ├── Task Definitions (6종)               │
│  ├── Lambda: budget-check  │   ├── ubuntu-light/standard/power      │
│  ├── EventBridge Rules     │   └── al2023-light/standard/power      │
│  ├── SNS Topic (알림)      ├── EFS File System                      │
│  └── CloudTrail 연동       ├── ALB + CloudFront                     │
│       │                    ├── Security Groups (3종 DLP)             │
│       │                    └── Route 53 Wildcard (*.dev)             │
│       │                         │                                   │
│       └─────────┬───────────────┘                                   │
│                 ▼                                                    │
│  Stack 05: Dashboard                                                │
│  ├── EC2 ASG (t4g.xlarge, Min:1 Max:2)                             │
│  ├── Next.js Standalone (PM2)                                       │
│  ├── ALB + CloudFront                                               │
│  ├── S3 Deploy Bucket                                               │
│  └── Route 53 (cconbedrock-dashboard)                              │
│                                                                     │
│  ── AgentCore (별도 관리, CDK 외부) ──                              │
│  ├── Runtime: cconbedrock_assistant_v2 (PUBLIC mode)                │
│  ├── Gateway: cconbedrock-gateway (MCP)                             │
│  ├── Lambda: cconbedrock-ecs-mcp                                    │
│  ├── Lambda: cconbedrock-cloudwatch-mcp                             │
│  ├── Lambda: cconbedrock-dynamodb-mcp                               │
│  ├── Memory: cconbedrock_memory                                     │
│  └── IAM: AWSopsAgentCoreRole, agentcore-lambda, agentcore-gateway  │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

<a id="ko-container-lifecycle"></a>

## 9. 컨테이너 라이프사이클

```
┌──── 생성 ────────────────────────────────────────────────────────┐
│                                                                    │
│  Admin → Dashboard Containers 메뉴 → Start Container              │
│    │                                                               │
│    ├── 1. 중복 검사 (username/subdomain RUNNING 태스크 존재?)       │
│    ├── 2. RunTask (enableExecuteCommand: true)                     │
│    │   ├── Task Definition 선택 ({OS}-{Tier})                      │
│    │   ├── Security Group 선택 (Open/Restricted/Locked)            │
│    │   └── 환경변수 주입 (SECURITY_POLICY, USER_SUBDOMAIN, PW)     │
│    ├── 3. 태그 부착 (username, subdomain, department)              │
│    └── 4. ALB 타겟 등록 (비동기, stale IP 제거 → 새 IP 등록)      │
│                                                                    │
├──── 실행 ────────────────────────────────────────────────────────┤
│                                                                    │
│  entrypoint.sh 실행:                                               │
│    ├── EFS 사용자별 디렉토리 생성 (/users/{subdomain}/)            │
│    ├── Kiro/Claude Code 설정                                       │
│    ├── MCP Server 설정                                             │
│    ├── DLP 보안 정책 적용                                          │
│    ├── idle-monitor.sh 백그라운드 시작                              │
│    └── code-server 시작 (port 8080)                                │
│                                                                    │
│  Bedrock 호출 경로:                                                │
│    Claude Code → IMDS (Task Role) → Bedrock VPC Endpoint           │
│                                                                    │
├──── 중지 ────────────────────────────────────────────────────────┤
│                                                                    │
│  Admin → Dashboard → Stop Container                                │
│    ├── 1. ALB 타겟 해제 (deregisterContainerFromAlb)              │
│    ├── 2. StopTask (SIGTERM → SIGKILL)                             │
│    └── 3. EFS 데이터 보존 (/users/{subdomain}/ 유지)              │
│                                                                    │
│  자동 중지 (미구현):                                                │
│    idle-monitor.sh → /tmp/idle-status 기록 → 외부 Lambda 필요     │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

---

<a id="ko-deployment-pipeline"></a>

## 10. 배포 파이프라인

```
┌──── Dashboard 배포 ───────────────────────────────────────────────┐
│                                                                    │
│  npm run build                                                     │
│    ↓                                                               │
│  cp -r .next/standalone/. /tmp/stage/  (주의: .next 숨김 디렉토리) │
│  cp -r .next/static /tmp/stage/.next/static                       │
│    ↓                                                               │
│  tar czf dashboard-app.tar.gz .                                    │
│    ↓                                                               │
│  aws s3 cp → s3://cc-on-bedrock-deploy-061525506239/dashboard/     │
│    ↓                                                               │
│  SSM RunCommand → EC2:                                             │
│    pm2 kill → tar extract → pm2 start server.js                   │
│                                                                    │
├──── Agent 배포 ───────────────────────────────────────────────────┤
│                                                                    │
│  docker buildx build --platform linux/arm64 -t ECR_URI .           │
│    ↓                                                               │
│  docker push ECR_URI:latest                                        │
│    ↓                                                               │
│  update-agent-runtime (자동 롤아웃)                                │
│                                                                    │
├──── Lambda 배포 ──────────────────────────────────────────────────┤
│                                                                    │
│  python3 agent/lambda/create_targets.py                            │
│  (Lambda 생성/업데이트 + Gateway Target 등록)                      │
│                                                                    │
├──── CDK 배포 ─────────────────────────────────────────────────────┤
│                                                                    │
│  cd cdk && npx cdk deploy --all                                    │
│  (5 stacks: Network → Security → UsageTracking → EcsDevenv → Dashboard) │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

---

<a id="ko-resource-ids"></a>

## 11. 주요 리소스 ID

| 리소스 | ID / ARN |
|--------|----------|
| **VPC** | vpc-0dfa5610180dfa628 |
| **ECS Cluster** | cc-on-bedrock-devenv |
| **Dashboard EC2** | i-0e694c8dc4d2cf6df |
| **Cognito Pool** | ap-northeast-2_fqzT5ZOPa |
| **Cognito Client** | 18hc19ba59oo1d09ubaen9bbjr |
| **EFS** | fs-09ba32e6a7788fc79 |
| **DynamoDB** | cc-on-bedrock-usage |
| **CloudFront (Dashboard)** | d2gbag0sqd0ada.cloudfront.net |
| **AgentCore Runtime** | cconbedrock_assistant_v2-Rpg8UUGdQt |
| **AgentCore Gateway** | cconbedrock-gateway-u1p3qlbsz6 |
| **AgentCore Memory** | cconbedrock_memory-pHqYq73dKd |
| **Dashboard URL** | https://cconbedrock-dashboard.whchoi.net |
| **Cognito Login** | https://cc-on-bedrock.auth.ap-northeast-2.amazoncognito.com |
| **Gateway MCP** | https://cconbedrock-gateway-u1p3qlbsz6.gateway.bedrock-agentcore.ap-northeast-2.amazonaws.com/mcp |

---

<a id="en"></a>

<a id="en-system-overview"></a>

# CC-on-Bedrock Full Architecture Detail

## 1. Overall System Diagram

```
                                    ┌─────────────────────────────────────┐
                                    │         Internet / Users            │
                                    └──────────┬──────────┬───────────────┘
                                               │          │
                                    ┌──────────▼──┐  ┌────▼──────────┐
                                    │ CloudFront  │  │  CloudFront   │
                                    │ Dashboard   │  │  DevEnv       │
                                    │ (HTTPS)     │  │  (HTTPS)      │
                                    └──────┬──────┘  └─────┬─────────┘
                                           │               │
                                    X-Custom-Secret    X-Custom-Secret
                                           │               │
                              ┌────────────▼───┐    ┌──────▼──────────┐
                              │  ALB           │    │  ALB            │
                              │  (Dashboard)   │    │  (DevEnv)       │
                              │  Prefix List   │    │  Host Routing   │
                              └───────┬────────┘    └──────┬──────────┘
                                      │                    │
                   ┌──────────────────▼────────┐    ┌──────▼──────────────────┐
                   │  Stack 05: Dashboard       │    │  Stack 04: ECS DevEnv   │
                   │  ┌──────────────────────┐  │    │  ┌────────────────────┐ │
                   │  │  EC2 ASG (t4g.xl)    │  │    │  │  ECS Cluster       │ │
                   │  │  Next.js Standalone   │  │    │  │  EC2 Mode (x8)     │ │
                   │  │  PM2 Process Manager  │  │    │  │  m7g.4xlarge       │ │
                   │  │  Port 3000            │  │    │  │                    │ │
                   │  └──────────┬───────────┘  │    │  │  ┌──────────────┐  │ │
                   │             │               │    │  │  │ Task: admin01│  │ │
                   │  ┌──────────▼───────────┐  │    │  │  │ Task: ds01   │  │ │
                   │  │  7 Pages:            │  │    │  │  │ Task: eng04  │  │ │
                   │  │  Home, AI, Analytics │  │    │  │  │ ... (15 ea)  │  │ │
                   │  │  Monitoring, Security│  │    │  │  └──────┬───────┘  │ │
                   │  │  Users, Containers   │  │    │  │         │          │ │
                   │  └──────────────────────┘  │    │  │  ┌──────▼───────┐  │ │
                   └────────────────────────────┘    │  │  │ code-server  │  │ │
                                                     │  │  │ Claude Code  │  │ │
                                                     │  │  │ Kiro CLI     │  │ │
                                                     │  │  └──────┬───────┘  │ │
                                                     │  └─────────│──────────┘ │
                                                     │            │            │
                                                     │  ┌─────────▼──────────┐ │
                                                     │  │  EFS               │ │
                                                     │  │  /users/{subdomain}│ │
                                                     │  └────────────────────┘ │
                                                     └────────────────────────┘
```

---

<a id="en-network-architecture"></a>

## 2. Network Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│  VPC: 10.100.0.0/16 (cc-on-bedrock-vpc)                            │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │  Public Subnets (2 AZ)                                       │    │
│  │                                                               │    │
│  │  ┌─────────────┐  ┌─────────────┐  ┌────────┐  ┌────────┐  │    │
│  │  │ ALB DevEnv  │  │ ALB Dashboard│  │ NAT GW │  │ NAT GW │  │    │
│  │  │             │  │              │  │  AZ-a  │  │  AZ-c  │  │    │
│  │  └─────────────┘  └─────────────┘  └────────┘  └────────┘  │    │
│  └──────────────────────────────────────────────────────────────┘    │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │  Private Subnets (2 AZ)                                      │    │
│  │                                                               │    │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐       │    │
│  │  │ ECS Host x8  │  │ Dashboard EC2│  │ EFS Mount    │       │    │
│  │  │ (m7g.4xl)    │  │ (t4g.xl)     │  │ Targets      │       │    │
│  │  └──────────────┘  └──────────────┘  └──────────────┘       │    │
│  └──────────────────────────────────────────────────────────────┘    │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │  VPC Endpoints (8) — Private Link                            │    │
│  │                                                               │    │
│  │  Bedrock Runtime  │  ECR API  │  ECR DKR  │  S3             │    │
│  │  SSM              │  SSM Messages │  CloudWatch Logs         │    │
│  │  ec2messages                                                  │    │
│  └──────────────────────────────────────────────────────────────┘    │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │  DNS Firewall                                                │    │
│  │  5 AWS-managed threat lists + custom block list              │    │
│  └──────────────────────────────────────────────────────────────┘    │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

---

<a id="en-ai-assistant-architecture"></a>

## 3. AI Assistant Hybrid Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                                                                         │
│  ┌─── Dashboard (fast real-time streaming) ──────────────────────────┐  │
│  │                                                                     │  │
│  │  Browser                                                            │  │
│  │    │                                                                │  │
│  │    │ POST /api/ai (SSE)                                             │  │
│  │    ▼                                                                │  │
│  │  Next.js API Route                                                  │  │
│  │    │                                                                │  │
│  │    ├─── ConverseStreamCommand ──────────────────→ Bedrock          │  │
│  │    │    (token-level real-time streaming)             Sonnet 4.6    │  │
│  │    │                                                                │  │
│  │    ├─── Tool Use (up to 5 loop iterations)                          │  │
│  │    │    ├── get_container_status  → ECS API (direct)                │  │
│  │    │    ├── get_container_metrics → CloudWatch API (direct)         │  │
│  │    │    └── get_platform_summary  → ECS + CW combined              │  │
│  │    │                                                                │  │
│  │    └─── SSE: data: {"text":"..."} (real-time)                      │  │
│  │                                                                     │  │
│  │  Response time: 1~5s | Tools: 3 | Streaming: real-time              │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
│                                                                         │
│  ┌─── Slack/External (multi-client shared) ──────────────────────────┐  │
│  │                                                                     │  │
│  │  Slack Bot / CLI / API Client                                       │  │
│  │    │                                                                │  │
│  │    │ POST /api/ai/runtime (JSON)                                    │  │
│  │    ▼                                                                │  │
│  │  Next.js API Route                                                  │  │
│  │    │                                                                │  │
│  │    │ InvokeAgentRuntimeCommand                                      │  │
│  │    ▼                                                                │  │
│  │  AgentCore Runtime (cconbedrock_assistant_v2)                       │  │
│  │    │  Strands Agent + BedrockModel (Sonnet 4.6)                     │  │
│  │    │  PUBLIC network mode                                           │  │
│  │    │                                                                │  │
│  │    │ MCPClient (SigV4 signed)                                       │  │
│  │    ▼                                                                │  │
│  │  AgentCore Gateway (cconbedrock-gateway)                            │  │
│  │    │  MCP Protocol                                                  │  │
│  │    │                                                                │  │
│  │    ├──→ Lambda: cconbedrock-ecs-mcp                                │  │
│  │    │    ├── get_container_status (ECS API)                          │  │
│  │    │    └── get_efs_info (EFS API)                                  │  │
│  │    │                                                                │  │
│  │    ├──→ Lambda: cconbedrock-cloudwatch-mcp                         │  │
│  │    │    └── get_container_metrics (CloudWatch API)                  │  │
│  │    │                                                                │  │
│  │    └──→ Lambda: cconbedrock-dynamodb-mcp                           │  │
│  │         ├── get_spend_summary (DynamoDB)                            │  │
│  │         ├── get_budget_status (DynamoDB)                            │  │
│  │         ├── get_system_health (DynamoDB + ECS)                      │  │
│  │         ├── get_user_usage (DynamoDB)                               │  │
│  │         └── get_department_usage (DynamoDB)                         │  │
│  │                                                                     │  │
│  │  Response time: 10~20s | Tools: 8 | Multi-client shared            │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
│                                                                         │
│  ┌─── AgentCore Memory (shared) ─────────────────────────────────────┐  │
│  │                                                                     │  │
│  │  POST /api/ai/memory (save)                                         │  │
│  │  GET  /api/ai/memory (retrieve)                                     │  │
│  │                                                                     │  │
│  │  Memory ID: cconbedrock_memory-pHqYq73dKd                          │  │
│  │  Session: session_{sanitized_email}                                 │  │
│  │  Actor: {sanitized_email}                                           │  │
│  │                                                                     │  │
│  │  CreateEventCommand / ListEventsCommand                             │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

<a id="en-usage-tracking-pipeline"></a>

## 4. Usage Tracking Pipeline

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  ECS Task    │     │  CloudTrail  │     │  EventBridge │     │   Lambda     │
│  (Claude     │────>│  (API logs)  │────>│  (event      │────>│  (usage-     │
│   Code)      │     │              │     │   routing)   │     │   tracker)   │
└──────────────┘     └──────────────┘     └──────────────┘     └──────┬───────┘
                                                                      │
                     ┌──────────────┐                          ┌──────▼───────┐
                     │  Lambda      │     every 5 min          │  DynamoDB    │
                     │  (budget-    │◄─────────────────────────│  (cc-on-     │
                     │   check)     │                          │   bedrock-   │
                     └──────┬───────┘                          │   usage)     │
                            │                                  └──────▲───────┘
                     ┌──────▼───────┐                                 │
                     │  80% warning │                          ┌──────┘
                     │  → SNS alert │                          │ query
                     │              │                   ┌──────┴───────┐
                     │  100% exceed │                   │  Dashboard   │
                     │  → IAM Deny  │                   │  Analytics   │
                     │  → Cognito   │                   │  page        │
                     │    flag      │                   └──────────────┘
                     └──────────────┘
```

---

<a id="en-auth-access-control"></a>

## 5. Authentication and Access Control

```
┌──────────────────────────────────────────────────────────────────────┐
│  Authentication Flow                                                 │
│                                                                      │
│  ┌──── Dashboard Login (OAuth 2.0) ─────────────────────────────┐   │
│  │                                                                │   │
│  │  Browser → CloudFront → Dashboard (Next.js)                    │   │
│  │    │                                                           │   │
│  │    │ NextAuth "Sign in with Cognito"                           │   │
│  │    ▼                                                           │   │
│  │  Cognito Hosted UI (cc-on-bedrock.auth.amazoncognito.com)      │   │
│  │    │                                                           │   │
│  │    │ Authorization Code Grant                                  │   │
│  │    ▼                                                           │   │
│  │  Callback → JWT Token                                          │   │
│  │    │                                                           │   │
│  │    │ Cookie: next-auth.session-token (secure:false for ALB)    │   │
│  │    ▼                                                           │   │
│  │  Middleware: getToken() → group-based routing                   │   │
│  │    ├── admin group → all 7 pages                                │   │
│  │    └── user group  → Home, AI, Analytics                        │   │
│  └────────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  ┌──── DevEnv Access (code-server) ─────────────────────────────┐   │
│  │                                                                │   │
│  │  Browser → CloudFront → ALB (Host routing) → ECS Task          │   │
│  │    │                                                           │   │
│  │    │ code-server password: CcOnBedrock2026!                    │   │
│  │    ▼                                                           │   │
│  │  VS Code Development Environment (code-server:8080)            │   │
│  │    │                                                           │   │
│  │    │ Claude Code → CLAUDE_CODE_USE_BEDROCK=1                   │   │
│  │    │ → ECS Task Role → IMDS → Bedrock VPC Endpoint             │   │
│  │    ▼                                                           │   │
│  │  Amazon Bedrock (Sonnet 4.6 / Opus 4.6)                       │   │
│  └────────────────────────────────────────────────────────────────┘   │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

---

<a id="en-iam-role-mapping"></a>

## 6. IAM Role Mapping

```
┌─────────────────────────────────────────────────────────────────────┐
│                                                                     │
│  ┌─────────────────────────────┐  ┌──────────────────────────────┐ │
│  │  ECS Task Role              │  │  ECS Task Execution Role     │ │
│  │  (cc-on-bedrock-ecs-task)   │  │  (cc-on-bedrock-ecs-task-    │ │
│  │                             │  │   execution)                 │ │
│  │  bedrock:InvokeModel     ✓  │  │                              │ │
│  │  bedrock:Converse        ✓  │  │  ecr:GetDownloadUrlForLayer ✓│ │
│  │  bedrock:ConverseStream  ✓  │  │  ecr:BatchGetImage         ✓│ │
│  │  s3:GetObject/PutObject  ✓  │  │  logs:CreateLogGroup       ✓│ │
│  │  logs:CreateLogStream    ✓  │  │  secretsmanager:GetSecret  ✓│ │
│  └─────────────────────────────┘  └──────────────────────────────┘ │
│                                                                     │
│  ┌─────────────────────────────┐  ┌──────────────────────────────┐ │
│  │  Dashboard EC2 Role         │  │  AgentCore Lambda Role       │ │
│  │  (cc-on-bedrock-dashboard-  │  │  (cc-on-bedrock-agentcore-   │ │
│  │   ec2)                      │  │   lambda)                    │ │
│  │                             │  │                              │ │
│  │  ecs:RunTask/StopTask    ✓  │  │  ecs:ListTasks/Describe   ✓│ │
│  │  ecs:TagResource         ✓  │  │  cloudwatch:GetMetricData ✓│ │
│  │  cognito-idp:Admin*      ✓  │  │  dynamodb:Scan/Query      ✓│ │
│  │  dynamodb:Scan/Query     ✓  │  │  efs:DescribeFileSystems  ✓│ │
│  │  bedrock:InvokeModel     ✓  │  │  kms:Decrypt              ✓│ │
│  │  bedrock-agentcore:*     ✓  │  └──────────────────────────────┘ │
│  │  elasticloadbalancing:*  ✓  │                                   │
│  │  cloudwatch:GetMetric    ✓  │  ┌──────────────────────────────┐ │
│  │  cloudtrail:LookupEvents ✓  │  │  AgentCore Gateway Role     │ │
│  │  iam:PassRole            ✓  │  │  (cc-on-bedrock-agentcore-   │ │
│  └─────────────────────────────┘  │   gateway)                   │ │
│                                    │                              │ │
│  ┌─────────────────────────────┐  │  lambda:InvokeFunction    ✓│ │
│  │  AgentCore Runtime Role     │  │  (cconbedrock-* functions)  │ │
│  │  (AWSopsAgentCoreRole)      │  └──────────────────────────────┘ │
│  │                             │                                   │
│  │  bedrock:InvokeModel     ✓  │  ┌──────────────────────────────┐ │
│  │  ecr:*                   ✓  │  │  Budget Check Lambda Role    │ │
│  │  lambda:InvokeFunction   ✓  │  │  (in UsageTracking stack)    │ │
│  └─────────────────────────────┘  │                              │ │
│                                    │  dynamodb:Scan             ✓│ │
│                                    │  ecs:StopTask              ✓│ │
│                                    │  cognito-idp:AdminUpdate   ✓│ │
│                                    │  sns:Publish               ✓│ │
│                                    └──────────────────────────────┘ │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

<a id="en-security-7layers"></a>

## 7. Security 7 Layers

```
Layer 1  ┌────────────────────────────────────────────────┐
         │  CloudFront                                     │
         │  HTTPS (TLS 1.2+), AWS Shield DDoS protection   │
         │  ACM *.whchoi.net wildcard certificate           │
         └────────────────────┬───────────────────────────┘
                              │
Layer 2  ┌────────────────────▼───────────────────────────┐
         │  ALB                                            │
         │  CloudFront Prefix List (block direct access)   │
         │  X-Custom-Secret header validation               │
         │  Host-based routing (*.dev.whchoi.net)           │
         └────────────────────┬───────────────────────────┘
                              │
Layer 3  ┌────────────────────▼───────────────────────────┐
         │  Cognito OAuth 2.0                              │
         │  Hosted UI (cc-on-bedrock.auth.amazoncognito)   │
         │  admin/user group-based access control           │
         │  JWT session token (8 hours)                     │
         └────────────────────┬───────────────────────────┘
                              │
Layer 4  ┌────────────────────▼───────────────────────────┐
         │  Security Groups (3-tier DLP)                   │
         │  Open: 0.0.0.0/0 (full outbound)                │
         │  Restricted: VPC CIDR + whitelist                │
         │  Locked: VPC CIDR only (no internet)             │
         └────────────────────┬───────────────────────────┘
                              │
Layer 5  ┌────────────────────▼───────────────────────────┐
         │  VPC Endpoints (Private Link)                   │
         │  Bedrock, ECR, SSM, CloudWatch, S3              │
         │  AWS service access without internet transit     │
         └────────────────────┬───────────────────────────┘
                              │
Layer 6  ┌────────────────────▼───────────────────────────┐
         │  DNS Firewall                                   │
         │  5 AWS-managed threat domain lists               │
         │  Custom block domains                            │
         │  VPC-level DNS query filtering                   │
         └────────────────────┬───────────────────────────┘
                              │
Layer 7  ┌────────────────────▼───────────────────────────┐
         │  IAM + Application                              │
         │  Per-model Bedrock access control (Opus/Sonnet/Haiku) │
         │  Per-user Task Role                              │
         │  Budget exceeded → dynamic IAM Deny Policy attachment │
         │  code-server DLP (file upload/download restriction)   │
         │  IMDSv2 enforced                                 │
         └────────────────────────────────────────────────┘
```

---

<a id="en-stack-dependencies"></a>

## 8. Stack Structure and Dependencies

```
┌─────────────────────────────────────────────────────────────────────┐
│                                                                     │
│  Stack 01: Network                                                  │
│  ├── VPC (10.100.0.0/16)                                           │
│  ├── Public Subnets (2 AZ)                                         │
│  ├── Private Subnets (2 AZ)                                        │
│  ├── NAT Gateway (x2)                                              │
│  ├── VPC Endpoints (8)                                              │
│  ├── Route 53 Hosted Zone                                           │
│  └── DNS Firewall                                                   │
│       │                                                             │
│       ▼                                                             │
│  Stack 02: Security                                                 │
│  ├── Cognito User Pool + Hosted UI (cc-on-bedrock)                 │
│  ├── Cognito User Pool Client (OAuth)                               │
│  ├── ACM Certificates (*.whchoi.net)                               │
│  ├── KMS Encryption Key                                             │
│  ├── Secrets Manager (NextAuth, CloudFront)                        │
│  ├── IAM: ECS Task Role + Execution Role                           │
│  ├── IAM: Dashboard EC2 Role                                       │
│  └── Cognito Groups: admin, user                                    │
│       │                                                             │
│       ├─────────────────────────┐                                   │
│       ▼                         ▼                                   │
│  Stack 03: Usage Tracking  Stack 04: ECS DevEnv                     │
│  ├── DynamoDB Table        ├── ECS Cluster (EC2 mode)               │
│  │   (cc-on-bedrock-usage) ├── EC2 ASG (m7g.4xlarge x8)            │
│  ├── Lambda: usage-tracker ├── Task Definitions (6 types)           │
│  ├── Lambda: budget-check  │   ├── ubuntu-light/standard/power      │
│  ├── EventBridge Rules     │   └── al2023-light/standard/power      │
│  ├── SNS Topic (alerts)    ├── EFS File System                      │
│  └── CloudTrail integration├── ALB + CloudFront                     │
│       │                    ├── Security Groups (3 types DLP)         │
│       │                    └── Route 53 Wildcard (*.dev)             │
│       │                         │                                   │
│       └─────────┬───────────────┘                                   │
│                 ▼                                                    │
│  Stack 05: Dashboard                                                │
│  ├── EC2 ASG (t4g.xlarge, Min:1 Max:2)                             │
│  ├── Next.js Standalone (PM2)                                       │
│  ├── ALB + CloudFront                                               │
│  ├── S3 Deploy Bucket                                               │
│  └── Route 53 (cconbedrock-dashboard)                              │
│                                                                     │
│  ── AgentCore (managed separately, outside CDK) ──                  │
│  ├── Runtime: cconbedrock_assistant_v2 (PUBLIC mode)                │
│  ├── Gateway: cconbedrock-gateway (MCP)                             │
│  ├── Lambda: cconbedrock-ecs-mcp                                    │
│  ├── Lambda: cconbedrock-cloudwatch-mcp                             │
│  ├── Lambda: cconbedrock-dynamodb-mcp                               │
│  ├── Memory: cconbedrock_memory                                     │
│  └── IAM: AWSopsAgentCoreRole, agentcore-lambda, agentcore-gateway  │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

<a id="en-container-lifecycle"></a>

## 9. Container Lifecycle

```
┌──── Creation ────────────────────────────────────────────────────┐
│                                                                    │
│  Admin → Dashboard Containers menu → Start Container               │
│    │                                                               │
│    ├── 1. Duplicate check (RUNNING task with same username/subdomain?) │
│    ├── 2. RunTask (enableExecuteCommand: true)                     │
│    │   ├── Select Task Definition ({OS}-{Tier})                    │
│    │   ├── Select Security Group (Open/Restricted/Locked)          │
│    │   └── Inject env vars (SECURITY_POLICY, USER_SUBDOMAIN, PW)  │
│    ├── 3. Attach tags (username, subdomain, department)            │
│    └── 4. Register ALB target (async, remove stale IP → register new IP) │
│                                                                    │
├──── Running ─────────────────────────────────────────────────────┤
│                                                                    │
│  entrypoint.sh execution:                                          │
│    ├── Create per-user EFS directory (/users/{subdomain}/)         │
│    ├── Kiro/Claude Code configuration                              │
│    ├── MCP Server configuration                                    │
│    ├── Apply DLP security policy                                   │
│    ├── Start idle-monitor.sh in background                         │
│    └── Start code-server (port 8080)                               │
│                                                                    │
│  Bedrock invocation path:                                          │
│    Claude Code → IMDS (Task Role) → Bedrock VPC Endpoint           │
│                                                                    │
├──── Stopping ────────────────────────────────────────────────────┤
│                                                                    │
│  Admin → Dashboard → Stop Container                                │
│    ├── 1. Deregister ALB target (deregisterContainerFromAlb)       │
│    ├── 2. StopTask (SIGTERM → SIGKILL)                             │
│    └── 3. Preserve EFS data (/users/{subdomain}/ retained)         │
│                                                                    │
│  Auto-stop (not yet implemented):                                  │
│    idle-monitor.sh → write /tmp/idle-status → external Lambda needed │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

---

<a id="en-deployment-pipeline"></a>

## 10. Deployment Pipeline

```
┌──── Dashboard Deployment ────────────────────────────────────────┐
│                                                                    │
│  npm run build                                                     │
│    ↓                                                               │
│  cp -r .next/standalone/. /tmp/stage/  (note: .next hidden dir)    │
│  cp -r .next/static /tmp/stage/.next/static                       │
│    ↓                                                               │
│  tar czf dashboard-app.tar.gz .                                    │
│    ↓                                                               │
│  aws s3 cp → s3://cc-on-bedrock-deploy-061525506239/dashboard/     │
│    ↓                                                               │
│  SSM RunCommand → EC2:                                             │
│    pm2 kill → tar extract → pm2 start server.js                   │
│                                                                    │
├──── Agent Deployment ────────────────────────────────────────────┤
│                                                                    │
│  docker buildx build --platform linux/arm64 -t ECR_URI .           │
│    ↓                                                               │
│  docker push ECR_URI:latest                                        │
│    ↓                                                               │
│  update-agent-runtime (automatic rollout)                          │
│                                                                    │
├──── Lambda Deployment ───────────────────────────────────────────┤
│                                                                    │
│  python3 agent/lambda/create_targets.py                            │
│  (Lambda create/update + Gateway Target registration)              │
│                                                                    │
├──── CDK Deployment ──────────────────────────────────────────────┤
│                                                                    │
│  cd cdk && npx cdk deploy --all                                    │
│  (5 stacks: Network → Security → UsageTracking → EcsDevenv → Dashboard) │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

---

<a id="en-resource-ids"></a>

## 11. Key Resource IDs

| Resource | ID / ARN |
|----------|----------|
| **VPC** | vpc-0dfa5610180dfa628 |
| **ECS Cluster** | cc-on-bedrock-devenv |
| **Dashboard EC2** | i-0e694c8dc4d2cf6df |
| **Cognito Pool** | ap-northeast-2_fqzT5ZOPa |
| **Cognito Client** | 18hc19ba59oo1d09ubaen9bbjr |
| **EFS** | fs-09ba32e6a7788fc79 |
| **DynamoDB** | cc-on-bedrock-usage |
| **CloudFront (Dashboard)** | d2gbag0sqd0ada.cloudfront.net |
| **AgentCore Runtime** | cconbedrock_assistant_v2-Rpg8UUGdQt |
| **AgentCore Gateway** | cconbedrock-gateway-u1p3qlbsz6 |
| **AgentCore Memory** | cconbedrock_memory-pHqYq73dKd |
| **Dashboard URL** | https://cconbedrock-dashboard.whchoi.net |
| **Cognito Login** | https://cc-on-bedrock.auth.ap-northeast-2.amazoncognito.com |
| **Gateway MCP** | https://cconbedrock-gateway-u1p3qlbsz6.gateway.bedrock-agentcore.ap-northeast-2.amazonaws.com/mcp |
