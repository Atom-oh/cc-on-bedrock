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

    subgraph Stack03["Stack 03: Usage Tracking"]
        DDB["DynamoDB<br/>cc-on-bedrock-usage"]
        Lambda1["Lambda<br/>bedrock-usage-tracker"]
        Lambda2["Lambda<br/>budget-check (5min)"]
        EB["EventBridge Rules<br/>CloudTrail → Lambda"]
        CT["CloudTrail<br/>Bedrock API Logs"]
    end

    subgraph Stack04["Stack 04: ECS Cluster"]
        DevEnv_ALB["ALB<br/>Host-based Routing"]
        ECS_Cluster["ECS Cluster<br/>EC2 Mode"]
        Nginx["Nginx Service<br/>Reverse Proxy"]
        DevEnv_SGs["Security Groups<br/>open / restricted / locked"]
    end

    subgraph Stack05["Stack 05: Dashboard"]
        Dash_ALB["ALB"]
        Dash_ASG["EC2 ASG<br/>t4g.xlarge"]
        NextJS["Next.js Standalone<br/>PM2 + S3 Deploy"]
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
    Dash_ALB --> Dash_ASG
    Dash_ASG --> NextJS
    NextJS -->|Cognito Admin API| Cognito
    NextJS -->|EC2 Start/Stop| EC2_Instances
    NextJS -->|DynamoDB Query| DDB
    NextJS -->|Bedrock Converse API| Bedrock

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

    %% ECS Cluster (Nginx only)
    ECS_Cluster --> Nginx

    %% Infrastructure
    EC2_Instances --> CW
    NextJS --> CW

    %% DNS
    R53 -->|CNAME| CF_Dashboard
    R53 -->|Wildcard| CF_DevEnv

    %% Network placement
    Dash_ALB -.-> PubA
    DevEnv_ALB -.-> PubA
    Dash_ASG -.-> PriA
    ECS_Cluster -.-> PriA
    EC2_Instances -.-> PriA

    %% Styles
    classDef stack fill:#f9f,stroke:#333,stroke-width:2px
    classDef aws fill:#ff9900,stroke:#333,color:#fff
    classDef user fill:#4a90d9,stroke:#333,color:#fff
    class Stack01,Stack02,Stack03,Stack04,Stack05,Stack07 stack
    class Bedrock,Bedrock_VPCE,ECR,CW aws
    class AdminUser,DevUser user
```

## Stack Dependencies

```mermaid
graph LR
    S1["01 Network<br/>VPC, Subnets, NAT,<br/>VPC Endpoints, R53,<br/>DNS Firewall"] --> S2["02 Security<br/>Cognito, ACM, KMS,<br/>Secrets, Per-user IAM"]
    S2 --> S3["03 Usage Tracking<br/>DynamoDB, Lambda,<br/>EventBridge, CloudTrail"]
    S2 --> S4["04 ECS Cluster<br/>Nginx Service,<br/>ALB, CloudFront"]
    S2 --> S7["07 EC2 DevEnv<br/>Per-user EC2,<br/>Instance Profile, SG"]
    S4 --> S5["05 Dashboard<br/>Next.js, ALB,<br/>CloudFront"]
    S3 --> S5
    S7 --> S4
```

## User Access Flow

```mermaid
sequenceDiagram
    participant User as Developer
    participant CF as CloudFront
    participant Dash as Dashboard
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
    Dash-->>User: 8. Link: user.dev.whchoi.net
    User->>Nginx: 9. Host-based routing
    Nginx->>EC2: 10. Reverse proxy to instance
    Note over EC2: code-server (password auth)<br/>EBS root volume preserves state
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

        ECS_EC2["ECS Cluster<br/>(Nginx)"]
        DevEnv_EC2["Per-user EC2<br/>(DevEnv)"]
        Dash_EC2["Dashboard EC2"]

        ALB1 -.-> PS_A
        ALB2 -.-> PS_A
        NAT1 -.-> PS_A
        NAT2 -.-> PS_C

        ECS_EC2 -.-> PR_A
        DevEnv_EC2 -.-> PR_A
        Dash_EC2 -.-> PR_A
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
