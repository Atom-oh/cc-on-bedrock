# CC-on-Bedrock Architecture

## Full Architecture Diagram

```mermaid
graph TB
    subgraph Users["Users (Browser)"]
        AdminUser["Admin User"]
        DevUser["Developer User"]
    end

    subgraph CloudFrontLayer["CloudFront (Split per concern, ADR-016)"]
        CF_Dashboard["Dashboard CF<br/>(dashboard.*)<br/>Stack 05"]
        CF_DevEnv["DevEnv CF<br/>(*.dev.*)<br/>Stack 04<br/>Lambda@Edge: Session Validator"]
    end

    subgraph Stack01["Stack 01: Network"]
        VPC["VPC 10.100.0.0/16"]
        subgraph PublicSubnets["Public Subnets (2 AZ)"]
            PubA["Public Subnet A"]
            PubC["Public Subnet C"]
        end
        subgraph PrivateSubnets["Private Subnets (2 AZ)"]
            PriA["Private Subnet A"]
            PriC["Private Subnet C"]
        end
        NAT_A["NAT GW A"]
        NAT_C["NAT GW C"]
        VPCE["VPC Endpoints<br/>SSM, ECR, Bedrock,<br/>CloudWatch, S3"]
        R53["Route 53<br/>Hosted Zone"]
        DNSFirewall["DNS Firewall<br/>Threat Lists + Custom"]
    end

    subgraph Stack02["Stack 02: Security"]
        Cognito["Cognito User Pool<br/>+ Hosted UI<br/>(cc-on-bedrock)"]
        ACM["ACM Certificates<br/>*.whchoi.net"]
        KMS["KMS<br/>Encryption Keys"]
        Secrets["Secrets Manager<br/>NextAuth, CloudFront Secret"]
        IAM["IAM Roles<br/>Per-user Task Role,<br/>Permission Boundary,<br/>Dashboard EC2"]
    end

    subgraph Stack03["Stack 03: Usage Tracking + MCP Gateway"]
        DDB["DynamoDB<br/>cc-on-bedrock-usage"]
        Lambda1["Lambda<br/>bedrock-usage-tracker"]
        Lambda2["Lambda<br/>budget-check (5min)"]
        EB["EventBridge Rules<br/>CloudTrail → Lambda"]
        CT["CloudTrail<br/>Bedrock API Logs"]
        McpCatalog["DynamoDB<br/>cc-mcp-catalog"]
        McpConfig["DynamoDB<br/>cc-dept-mcp-config<br/>(Streams enabled)"]
        GwManager["Lambda<br/>gateway-manager<br/>(DDB Streams trigger)"]
    end

    subgraph AgentCore["AgentCore (Outside CDK, ADR-007)"]
        CommonGW["Common Gateway<br/>cconbedrock-gateway<br/>(8 MCP tools)"]
        DeptGW["Department Gateways<br/>cconbedrock-{dept}-gateway<br/>(per-dept MCP tools)"]
        McpLambdas["MCP Lambda Targets<br/>ECS / CloudWatch / DDB<br/>+ dept-specific"]
    end

    subgraph Stack04["Stack 04: ECS DevEnv + DevEnv CloudFront (ADR-016)"]
        DevEnv_NLB["NLB<br/>(internet-facing, CloudFront only)"]
        ECS_Cluster["ECS Cluster<br/>cc-on-bedrock-devenv"]
        Nginx["Nginx Service<br/>(Fargate, Reverse Proxy)"]
        DevEnv_SGs["Security Groups<br/>open / restricted / locked"]
        RoutingTable_S4["DynamoDB<br/>cc-routing-table"]
    end

    subgraph Stack05["Stack 05: Dashboard"]
        Dash_ALB["ALB"]
        DashContainer["Dashboard Container<br/>Next.js (ECR, port 3000)"]
    end

    subgraph Stack07["Stack 07: EC2 DevEnv (ADR-004)"]
        EC2_Instances["Per-user EC2<br/>ARM64 (t4g.medium~large)<br/>Hibernation support"]
        EC2_EBS["EBS Root Volume<br/>(state preserved on Stop)"]
        EC2_Profile["Per-user Instance Profile<br/>cc-on-bedrock-task-{subdomain}"]
        RoutingTable["DynamoDB<br/>cc-routing-table"]
    end

    subgraph Stack08["Stack 08: Local Governance (ADR-014)"]
        STSIssuer["STS Issuer Lambda<br/>(Function URL, IAM auth)"]
        TokenEnforcer["Token Limit Enforcer Lambda<br/>(usage table Stream consumer)"]
        LimitReset["Limit Reset Lambda<br/>(EventBridge cron)"]
        LimitsDDB["DynamoDB<br/>cc-on-bedrock-limits"]
        LocalUserRole["Per-user IAM Role<br/>cc-on-bedrock-local-user-{sub}"]
    end

    subgraph AWS_Services["AWS Services"]
        Bedrock["Amazon Bedrock<br/>Opus 4.6 / Sonnet 4.6"]
        Bedrock_VPCE["Bedrock<br/>VPC Endpoint"]
        ECR["Amazon ECR<br/>devenv images"]
        CW["CloudWatch<br/>CloudWatch Agent"]
    end

    %% User Access Flow (ADR-016: separate CloudFront per concern)
    AdminUser -->|HTTPS| CF_Dashboard
    DevUser -->|HTTPS| CF_DevEnv

    %% CloudFront → Origin
    CF_Dashboard -->|origin| Dash_ALB
    CF_DevEnv -->|origin + X-Custom-Secret| DevEnv_NLB
    DevEnv_NLB --> Nginx

    %% Dashboard Flow
    Dash_ALB --> DashContainer
    DashContainer -->|Cognito Admin API| Cognito
    DashContainer -->|EC2 Start/Stop| EC2_Instances
    DashContainer -->|DynamoDB Query| DDB
    DashContainer -->|Bedrock Converse API| Bedrock

    %% Dev Environment Flow (EC2 → Bedrock Direct)
    Nginx -->|Reverse Proxy| EC2_Instances
    EC2_Instances --> EC2_EBS
    EC2_Instances -->|Instance Profile → IMDS| Bedrock_VPCE
    Bedrock_VPCE --> Bedrock

    %% Routing
    Nginx -->|Lookup| RoutingTable
    DashContainer -->|Register IP| RoutingTable

    %% Usage Tracking Flow
    EC2_Instances -.->|API Call| CT
    CT -->|Event| EB
    EB -->|Trigger| Lambda1
    Lambda1 -->|Write| DDB
    Lambda2 -->|Read/Check| DDB

    %% ECS Cluster (Stack 04: Nginx only — Dashboard ECS Ec2Service is in Stack 05)
    ECS_Cluster --> Nginx

    %% MCP Gateway Flow (ADR-007)
    DashContainer -->|Admin MCP Mgmt| McpCatalog
    DashContainer -->|Assign MCP| McpConfig
    McpConfig -->|DDB Streams| GwManager
    GwManager -->|Create/Sync| CommonGW
    GwManager -->|Create/Sync| DeptGW
    CommonGW --> McpLambdas
    DeptGW --> McpLambdas
    EC2_Instances -->|Claude Code<br/>MCP Protocol| CommonGW
    EC2_Instances -->|Claude Code<br/>MCP Protocol| DeptGW

    %% Infrastructure
    EC2_Instances --> CW
    DashContainer --> CW

    %% DNS (each record points to its own CF — ADR-016)
    R53 -->|dashboard.*| CF_Dashboard
    R53 -->|*.dev.*| CF_DevEnv

    %% Network placement
    Dash_ALB -.-> PubA
    DashContainer -.-> PriA
    ECS_Cluster -.-> PriA
    EC2_Instances -.-> PriA

    %% Styles
    classDef stack fill:#f9f,stroke:#333,stroke-width:2px
    classDef aws fill:#ff9900,stroke:#333,color:#fff
    classDef user fill:#4a90d9,stroke:#333,color:#fff
    classDef agentcore fill:#4CAF50,stroke:#333,color:#fff
    class Stack01,Stack02,Stack03,Stack04,Stack05,Stack07,Stack08 stack
    class Bedrock,Bedrock_VPCE,ECR,CW aws
    class AdminUser,DevUser user
    class CommonGW,DeptGW,McpLambdas agentcore
```

## Stack Dependencies

```mermaid
graph LR
    S1["01 Network<br/>VPC, Subnets, NAT,<br/>VPC Endpoints, R53,<br/>DNS Firewall"] --> S2["02 Security<br/>Cognito, ACM, KMS,<br/>Secrets, Per-user IAM"]
    S2 --> S3["03 Usage Tracking<br/>DynamoDB (+ Stream),<br/>Lambda, EventBridge,<br/>MCP Gateway Mgr (ADR-007)"]
    S2 --> S4["04 ECS DevEnv<br/>Nginx (Fargate), NLB,<br/>DevEnv CF (ADR-016)"]
    S2 --> S7["07 EC2 DevEnv<br/>Per-user EC2,<br/>Instance Profile, SG"]
    S2 --> S5["05 Dashboard<br/>ECS Ec2Service, ALB,<br/>Dashboard CF (ADR-016)"]
    S3 --> S5
    S3 --> S8["08 Local Governance<br/>STS Issuer, Token Limit Enforcer,<br/>Limit Reset (ADR-014)"]
    S6["06 WAF (us-east-1)<br/>WebACL for CF"] -.-> S4
    S6 -.-> S5
```

Note: Stack 04 is skipped when `--context governanceOnly=true` (ADR-014 Local Governance Mode).

## Department MCP Gateway (ADR-007)

2-tier AgentCore Gateway architecture for department-isolated MCP tools.

```mermaid
graph LR
    subgraph Admin["Admin Dashboard /admin/mcp"]
        Catalog["MCP Catalog<br/>(cc-mcp-catalog)"]
        Assign["Department<br/>Assignments"]
    end

    subgraph DDB["DynamoDB"]
        McpCfg["cc-dept-mcp-config<br/>(Streams enabled)"]
    end

    subgraph GwMgr["Gateway Manager Lambda"]
        Create["create_gateway"]
        AddTarget["create_target"]
        Sync["synchronize"]
    end

    subgraph Gateways["AgentCore Gateways"]
        CmnGW["Common Gateway<br/>(monitoring, 8 tools)"]
        EngGW["Engineering GW<br/>(github, jira)"]
        DataGW["Data Team GW<br/>(athena, s3)"]
    end

    subgraph Targets["MCP Lambda Targets"]
        EcsMcp["ECS MCP"]
        CwMcp["CloudWatch MCP"]
        DdbMcp["DynamoDB MCP"]
        GhMcp["GitHub MCP"]
        AthMcp["Athena MCP"]
    end

    subgraph EC2Boot["EC2 Boot (systemd)"]
        SyncScript["sync-mcp-config.sh"]
        McpJson["~/.claude/<br/>mcp_servers.json"]
    end

    subgraph ClaudeCode["Claude Code Session"]
        LocalMcp["Local MCP<br/>(awslabs-core, agentcore)"]
        GwMcp["Gateway MCP<br/>(common + dept)"]
    end

    Assign -->|PUT /api/admin/mcp/assignments| McpCfg
    McpCfg -->|DDB Streams| Create
    McpCfg -->|DDB Streams| AddTarget
    AddTarget --> Sync

    Create --> CmnGW
    Create --> EngGW
    Create --> DataGW

    CmnGW --> EcsMcp
    CmnGW --> CwMcp
    CmnGW --> DdbMcp
    EngGW --> GhMcp
    DataGW --> AthMcp

    SyncScript -->|DDB Query| McpCfg
    SyncScript --> McpJson
    McpJson --> LocalMcp
    McpJson --> GwMcp

    style CmnGW fill:#4CAF50,color:#fff
    style EngGW fill:#2196F3,color:#fff
    style DataGW fill:#9C27B0,color:#fff
```

**Security: 3-Layer IAM Isolation**

```mermaid
graph TB
    User["Per-user Role<br/>cc-on-bedrock-task-{subdomain}"]
    Boundary["Permission Boundary<br/>cc-on-bedrock-task-boundary<br/>(InvokeGateway allowed)"]
    Inline["Inline Policy<br/>InvokeGateway on<br/>common-gw + dept-gw ARNs"]
    GwRole["Gateway Role<br/>cc-on-bedrock-agentcore-gateway-{dept}<br/>(Lambda Invoke only)"]
    LambdaRole["Lambda Role<br/>cc-on-bedrock-mcp-lambda-{id}<br/>(scoped AWS resources)"]

    User --> Boundary
    User --> Inline
    Inline -->|Allowed| GwRole
    GwRole -->|Invoke| LambdaRole

    style User fill:#ff9900,color:#fff
    style Boundary fill:#f44336,color:#fff
    style Inline fill:#2196F3,color:#fff
    style GwRole fill:#4CAF50,color:#fff
    style LambdaRole fill:#9C27B0,color:#fff
```

Key resources (Stack 03): `cc-mcp-catalog` DDB, `cc-dept-mcp-config` DDB (Streams), `gateway-manager` Lambda

## User Access Flow

```mermaid
sequenceDiagram
    participant User as Developer
    participant DashCF as Dashboard CF
    participant DevCF as DevEnv CF
    participant Dash as Dashboard<br/>(ECS Ec2Service)
    participant Cognito as Cognito<br/>Hosted UI
    participant EC2 as EC2 Instance
    participant Nginx as Nginx<br/>(ECS, behind NLB)
    participant Bedrock as Amazon Bedrock

    User->>DashCF: 1. Access dashboard.<domain>
    DashCF->>Dash: 2. Forward (X-Custom-Secret)
    Dash->>Cognito: 3. OAuth redirect
    Cognito->>Dash: 4. Auth code → token
    User->>Dash: 5. Start instance (tier select)
    Dash->>EC2: 6. RunInstances / StartInstances
    Note over EC2: Per-user EC2 (ARM64)
    Dash-->>Nginx: 7. Register IP in cc-routing-table
    Dash-->>User: 8. Link: user.dev.<domain>/?folder=/home/coder
    User->>DevCF: 9. Access user.dev.<domain>
    Note over DevCF: Lambda@Edge: validate NextAuth cookie (.atomai.click)
    DevCF->>Nginx: 10. Forward via NLB (X-Custom-Secret)
    Note over Nginx: ?folder= → :8080 (code-server)<br/>/api/ → :8000 (API server)<br/>/ → :3000 (Frontend dev)
    Nginx->>EC2: 11. Reverse proxy to instance port
    Note over EC2: code-server :8080 (password auth)<br/>Frontend :3000 / API :8000 (optional)<br/>EBS root volume preserves state
    EC2->>Bedrock: 12. Claude Code → Instance Profile → Bedrock VPC Endpoint
    Bedrock-->>EC2: 13. Streamed response
    Note over EC2: 45min idle → auto-stop
```

## EC2 Instance Lifecycle (ADR-010: Hibernation)

EC2 Hibernation enables ~5s resume (vs 30-60s cold start) by saving RAM to encrypted EBS.

```mermaid
stateDiagram-v2
    [*] --> Running: Start / Resume
    Running --> Stopping: User Stop / Idle 45min / EOD
    Stopping --> Hibernated: Hibernate=true (RAM→EBS)
    Stopping --> Stopped: Hibernate=false or fallback
    Hibernated --> Running: Resume (~5s, RAM restored)
    Stopped --> Running: Start (~30-60s, cold boot)
    Running --> Stopping: changeTier (force Stop)
    Stopped --> [*]: Terminate
```

Key behaviors:
- **Feature flag** (`HIBERNATE_ENABLED`): per-instance capability check via `HibernationOptions.Configured`
- **Graceful fallback**: hibernate failure → automatic regular Stop
- **changeTier/switchOs**: always uses regular Stop (instance type change requires cold restart)
- **60-day limit**: rotation Lambda auto-restarts instances approaching AWS maximum

## Bedrock Access (Direct Mode)

```mermaid
graph LR
    CC["Claude Code<br/>(in EC2 Instance)"] -->|"Instance Profile → IMDS<br/>cc-on-bedrock-task-{subdomain}"| VPCE["Bedrock<br/>VPC Endpoint"]
    VPCE --> Bedrock["Amazon<br/>Bedrock"]

    Dashboard["Dashboard<br/>(AI Assistant)"] -->|"EC2 Instance Role<br/>Converse API"| Bedrock

    CT["CloudTrail"] -.->|"Logs all<br/>InvokeModel calls"| EB["EventBridge"]
    EB -.->|"Trigger"| Lambda["Lambda<br/>usage-tracker"]
    Lambda -.->|"Write"| DDB["DynamoDB<br/>(per-user usage)"]

    style Bedrock fill:#ff9900,color:#fff
    style VPCE fill:#ff9900,color:#fff
```

## Local Governance Mode (ADR-014)

EC2 DevEnv 없이 거버넌스만 가져가는 배포 프로파일. 사용자는 로컬 PC에서 Claude Code를 실행하고, 대시보드는 Cognito 로그인 후 단기 STS 자격증명을 발급한다.

```mermaid
graph LR
    subgraph LocalPC["로컬 PC"]
        Claude["Claude Code<br/>CLAUDE_CODE_USE_BEDROCK=1<br/>AWS_PROFILE=cc-bedrock"]
        Wrapper["tools/cc-bedrock-local.sh"]
    end

    subgraph AWS["AWS"]
        Dashboard["Next.js Dashboard<br/>(Cognito 인증)"]
        STSIssuer["Lambda<br/>sts-issuer<br/>(Function URL)"]
        UserRole["IAM Role<br/>cc-on-bedrock-local-user-{sub}<br/>MaxSessionDuration=12h"]
        Bedrock["Amazon Bedrock<br/>Application Inference Profile"]
        Logs["CloudWatch Logs<br/>Invocation Logging"]
        Tracker["Lambda<br/>bedrock-usage-tracker"]
        DDB["DynamoDB<br/>cc-on-bedrock-usage<br/>(Streams)"]
        Enforcer["Lambda<br/>token-limit-enforcer"]
        Limits["DynamoDB<br/>cc-on-bedrock-limits"]
        Reset["Lambda<br/>limit-reset<br/>(EventBridge cron)"]
    end

    Wrapper -->|"OIDC login"| Dashboard
    Dashboard -->|"sts:AssumeRole 8h"| STSIssuer
    STSIssuer -->|"creds"| Wrapper
    Wrapper -.->|"~/.aws/credentials"| Claude
    Claude -->|"SigV4 InvokeModel"| Bedrock

    Bedrock -.-> Logs
    Logs -->|"Subscription"| Tracker
    Tracker -->|"normalized tokens"| DDB
    DDB -->|"Stream"| Enforcer
    Enforcer -->|"Read/Update"| Limits
    Enforcer -.->|"한도 초과 시<br/>PutRolePolicy Deny"| UserRole
    Reset -.->|"일/주/월 cron"| Limits
    Reset -.->|"DeleteRolePolicy"| UserRole

    style Bedrock fill:#ff9900,color:#fff
    style DDB fill:#4053d6,color:#fff
    style Limits fill:#4053d6,color:#fff
    style UserRole fill:#d13212,color:#fff
```

**핵심 거버넌스 메커니즘**:
- **합산 normalized token 한도** (Opus 1.0 / Sonnet 0.2 / Haiku 0.053 가중치)
- 사용자 AND 부서 한도 (AND 조건, period = daily/weekly/monthly)
- 한도 도달 시 user role에 IAM Deny policy 동적 부착 — IAM은 호출 시점 평가이므로 8h 세션 중에도 즉시 차단
- 차단 latency 1-3분 (Invocation Logging 지연이 하한, ADR-014 Limitations)
- backup path: 기존 `budget-check.py`(5분 cycle)가 Stream 실패 대비

**배포 프로파일**:
- `cdk deploy --all --context governanceOnly=true` → EC2/ECS DevEnv 스택 skip
- 거버넌스 인프라(Usage Tracking, Limits, Dashboard)만 배포
- EC2 모드와 공존 가능(둘 다 deploy해서 사용자가 선택). 사용량 attribute는 role prefix로 구분 (`task-` vs `local-user-`)

## Network Layout

```mermaid
graph TB
    subgraph VPC["VPC 10.100.0.0/16"]
        subgraph PubSub["Public Subnets"]
            direction LR
            PS_A["10.100.x.0<br/>AZ-a"]
            PS_C["10.100.x.0<br/>AZ-c"]
        end

        subgraph PriSub["Private Subnets"]
            direction LR
            PR_A["10.100.x.0<br/>AZ-a"]
            PR_C["10.100.x.0<br/>AZ-c"]
        end

        ALB1["ALB (DevEnv)"]
        ALB2["ALB (Dashboard)"]
        NAT1["NAT GW"]
        NAT2["NAT GW"]

        ECS_EC2["ECS Cluster<br/>(Nginx Fargate +<br/>Dashboard Ec2Service)"]
        DevEnv_EC2["Per-user EC2<br/>(DevEnv)"]

        ALB1 -.-> PS_A
        ALB2 -.-> PS_A
        NAT1 -.-> PS_A
        NAT2 -.-> PS_C

        ECS_EC2 -.-> PR_A
        DevEnv_EC2 -.-> PR_A
    end

    Internet["Internet<br/>CloudFront"] --> ALB1
    Internet --> ALB2
```

## DLP Security Policies

> See [ADR-005](decisions/ADR-005-security-policy-access-control.md) for the full decision record (DLP + IAM Policy Set + approval workflow).

```mermaid
graph TD
    subgraph Policies["Per-user Security Policy"]
        Open["OPEN<br/>Education/Lab"]
        Restricted["RESTRICTED<br/>General Production"]
        Locked["LOCKED<br/>High Security"]
    end

    subgraph Layers["Enforcement Layers"]
        L1["Layer 1: code-server flags<br/>(file download/upload)"]
        L2["Layer 2: Security Groups<br/>(network egress)"]
        L3["Layer 3: DNS Firewall<br/>(domain-based filtering)"]
        L4["Layer 4: Extension control<br/>(VS Code extensions)"]
    end

    Open --> L1
    Open --> L2
    Restricted --> L1
    Restricted --> L2
    Restricted --> L3
    Restricted --> L4
    Locked --> L1
    Locked --> L2
    Locked --> L3
    Locked --> L4

    L2 -->|open| SG1["SG: 0.0.0.0/0<br/>(all outbound)"]
    L2 -->|restricted| SG2["SG: VPC CIDR +<br/>whitelist IPs"]
    L2 -->|locked| SG3["SG: VPC CIDR only<br/>(internal only)"]
```

## IAM Policy Set & Approval Workflow (Proposed)

> Designed but not yet implemented. See [ADR-005](decisions/ADR-005-security-policy-access-control.md).

- **Per-user IAM Role**: `cc-on-bedrock-task-{subdomain}` — Permission Boundary로 최대 권한 범위 제한
- **Pre-defined Policy Set Catalog**: DynamoDB, S3, EKS, SQS, SNS, Secrets Manager 등 8종
- **Approval Workflow**: User 신청 → DynamoDB `cc-approval-requests` → Admin 승인 → 자동 적용
  - `tier_change`: Cognito attribute + EC2 instance type 변경
  - `dlp_change`: Cognito attribute + Security Group swap (실행 중 즉시 적용)
  - `iam_extension`: `PutRolePolicy` on per-user role + EventBridge 기반 자동 만료

## Usage Tracking & Budget Enforcement

> See [ADR-006](decisions/ADR-006-department-budget-management.md) for department budget management decision.
> See [ADR-014](decisions/ADR-014-local-governance-mode.md) for normalized token limit enforcement (Local Governance Mode).

```mermaid
graph LR
    subgraph EC2["EC2 DevEnv Instances"]
        CC["Claude Code"]
    end

    CC -->|"InvokeModel"| Bedrock["Bedrock"]
    Bedrock -.->|"Logged"| CT["CloudTrail"]
    CT -->|"Event"| EB["EventBridge<br/>Rule"]
    EB -->|"Trigger"| L1["Lambda<br/>usage-tracker"]
    L1 -->|"PutItem<br/>USER# + DEPT#"| DDB["DynamoDB<br/>cc-on-bedrock-usage"]

    L2["Lambda<br/>budget-check<br/>(every 5min)"] -->|"Scan"| DDB
    L2 -->|"Read limits"| BudgetDB["DynamoDB<br/>cc-department-budgets"]
    L2 -->|"If over budget"| IAM["IAM Deny Policy<br/>on per-user role"]
    L2 -.->|"80% / 100%"| SNS["SNS Alert<br/>(dept-manager + admin)"]

    Dashboard["Dashboard<br/>Monitoring + Analytics"] -->|"Query<br/>(project-only usage)"| DDB

    style Bedrock fill:#ff9900,color:#fff
    style DDB fill:#4053d6,color:#fff
    style BudgetDB fill:#4053d6,color:#fff
```

**Dashboard Metrics Source**: Monitoring page의 Bedrock 사용량 메트릭은 DynamoDB `cc-on-bedrock-usage` 테이블에서 조회. CloudWatch `AWS/Bedrock` namespace는 계정 전체 사용량이므로 사용하지 않음 — DynamoDB 파이프라인이 `cc-on-bedrock-task-*` IAM role prefix로 3중 필터링하여 프로젝트 전용 데이터만 기록.

**CloudWatch Cost Optimization**: `textDataDeliveryEnabled: false` on Bedrock invocation logging — disables full request/response text delivery, keeping only metadata (model ID, token counts, latency). Reduces CloudWatch Logs cost by ~99% while preserving all data needed for usage tracking and budget enforcement.
