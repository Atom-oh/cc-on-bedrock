# CC-on-Bedrock Architecture

## Full Architecture Diagram

```mermaid
graph TB
    subgraph Users["Users (Browser)"]
        AdminUser["Admin User"]
        DevUser["Developer User"]
    end

    subgraph CloudFront["CloudFront Distributions"]
        CF_Dashboard["CloudFront<br/>cconbedrock-dashboard.whchoi.net"]
        CF_DevEnv["CloudFront<br/>*.dev.whchoi.net"]
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

    subgraph Stack04["Stack 04: ECS Cluster"]
        DevEnv_ALB["ALB<br/>Host-based Routing"]
        ECS_Cluster["ECS Cluster<br/>cc-on-bedrock-devenv"]
        Nginx["Nginx Service<br/>(Fargate, Reverse Proxy)"]
        DashSvc["Dashboard Service<br/>(EC2 Launch Type)"]
        DevEnv_SGs["Security Groups<br/>open / restricted / locked"]
    end

    subgraph Stack05["Stack 05: Dashboard"]
        Dash_ALB["ALB"]
        DashContainer["Dashboard Container<br/>Next.js (ECR, port 3000)"]
    end

    subgraph Stack07["Stack 07: EC2 DevEnv (ADR-004)"]
        EC2_Instances["Per-user EC2<br/>ARM64 (t4g.medium~large)"]
        EC2_EBS["EBS Root Volume<br/>(state preserved on Stop)"]
        EC2_Profile["Per-user Instance Profile<br/>cc-on-bedrock-task-{subdomain}"]
        RoutingTable["DynamoDB<br/>cc-routing-table"]
    end

    subgraph AWS_Services["AWS Services"]
        Bedrock["Amazon Bedrock<br/>Opus 4.6 / Sonnet 4.6"]
        Bedrock_VPCE["Bedrock<br/>VPC Endpoint"]
        ECR["Amazon ECR<br/>devenv images"]
        CW["CloudWatch<br/>CloudWatch Agent"]
    end

    %% User Access Flow
    AdminUser -->|HTTPS| CF_Dashboard
    DevUser -->|HTTPS| CF_Dashboard
    DevUser -->|HTTPS| CF_DevEnv

    %% CloudFront to ALB
    CF_Dashboard -->|X-Custom-Secret| Dash_ALB
    CF_DevEnv -->|X-Custom-Secret| DevEnv_ALB

    %% Dashboard Flow
    Dash_ALB --> DashContainer
    DashContainer -->|Cognito Admin API| Cognito
    DashContainer -->|EC2 Start/Stop| EC2_Instances
    DashContainer -->|DynamoDB Query| DDB
    DashContainer -->|Bedrock Converse API| Bedrock

    %% Dev Environment Flow (EC2 → Bedrock Direct)
    DevEnv_ALB -->|Host: user.dev.*| Nginx
    Nginx -->|Reverse Proxy| EC2_Instances
    EC2_Instances --> EC2_EBS
    EC2_Instances -->|Instance Profile → IMDS| Bedrock_VPCE
    Bedrock_VPCE --> Bedrock

    %% Routing
    Nginx -->|Lookup| RoutingTable
    NextJS -->|Register IP| RoutingTable

    %% Usage Tracking Flow
    EC2_Instances -.->|API Call| CT
    CT -->|Event| EB
    EB -->|Trigger| Lambda1
    Lambda1 -->|Write| DDB
    Lambda2 -->|Read/Check| DDB

    %% ECS Cluster (Nginx + Dashboard)
    ECS_Cluster --> Nginx
    ECS_Cluster --> DashSvc
    DashSvc --> DashContainer

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

    %% DNS
    R53 -->|CNAME| CF_Dashboard
    R53 -->|Wildcard| CF_DevEnv

    %% Network placement
    Dash_ALB -.-> PubA
    DevEnv_ALB -.-> PubA
    DashContainer -.-> PriA
    ECS_Cluster -.-> PriA
    EC2_Instances -.-> PriA

    %% Styles
    classDef stack fill:#f9f,stroke:#333,stroke-width:2px
    classDef aws fill:#ff9900,stroke:#333,color:#fff
    classDef user fill:#4a90d9,stroke:#333,color:#fff
    classDef agentcore fill:#4CAF50,stroke:#333,color:#fff
    class Stack01,Stack02,Stack03,Stack04,Stack05,Stack07 stack
    class Bedrock,Bedrock_VPCE,ECR,CW aws
    class AdminUser,DevUser user
    class CommonGW,DeptGW,McpLambdas agentcore
```

## Stack Dependencies

```mermaid
graph LR
    S1["01 Network<br/>VPC, Subnets, NAT,<br/>VPC Endpoints, R53,<br/>DNS Firewall"] --> S2["02 Security<br/>Cognito, ACM, KMS,<br/>Secrets, Per-user IAM"]
    S2 --> S3["03 Usage Tracking<br/>DynamoDB, Lambda,<br/>EventBridge, CloudTrail,<br/>MCP Gateway Mgr (ADR-007)"]
    S2 --> S4["04 ECS Cluster<br/>Nginx (Fargate),<br/>ASG, NLB, CloudFront"]
    S2 --> S7["07 EC2 DevEnv<br/>Per-user EC2,<br/>Instance Profile, SG"]
    S4 --> S5["05 Dashboard<br/>ECS Ec2Service,<br/>ALB, CloudFront"]
    S3 --> S5
    S7 --> S4
```

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
    participant CF as CloudFront
    participant Dash as Dashboard<br/>(ECS Ec2Service)
    participant Cognito as Cognito<br/>Hosted UI
    participant EC2 as EC2 Instance
    participant Nginx as Nginx<br/>(ECS)
    participant Bedrock as Amazon Bedrock

    User->>CF: 1. Access dashboard
    CF->>Dash: 2. Forward (X-Custom-Secret)
    Dash->>Cognito: 3. OAuth redirect
    Cognito->>Dash: 4. Auth code → token
    User->>Dash: 5. Start instance (tier select)
    Dash->>EC2: 6. RunInstances / StartInstances
    Note over EC2: Per-user EC2 (ARM64)
    Dash-->>Nginx: 7. Register IP in cc-routing-table
    Dash-->>User: 8. Link: user.dev.whchoi.net/?folder=/home/coder
    User->>Nginx: 9. Host-based routing (multi-port)
    Note over Nginx: ?folder= → :8080 (code-server)<br/>/api/ → :8000 (API server)<br/>/ → :3000 (Frontend dev)
    Nginx->>EC2: 10. Reverse proxy to instance port
    Note over EC2: code-server :8080 (password auth)<br/>Frontend :3000 / API :8000 (optional)<br/>EBS root volume preserves state
    EC2->>Bedrock: 11. Claude Code → Instance Profile → Bedrock VPC Endpoint
    Bedrock-->>EC2: 12. Streamed response
    Note over EC2: 45min idle → auto-stop
```

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

    Dashboard["Dashboard"] -->|"Query"| DDB

    style Bedrock fill:#ff9900,color:#fff
    style DDB fill:#4053d6,color:#fff
    style BudgetDB fill:#4053d6,color:#fff
```
