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
        IAM["IAM Roles<br/>ECS Task, Task Exec,<br/>Dashboard EC2"]
    end

    subgraph Stack03["Stack 03: Usage Tracking"]
        DDB["DynamoDB<br/>cc-on-bedrock-usage"]
        Lambda1["Lambda<br/>bedrock-usage-tracker"]
        Lambda2["Lambda<br/>budget-check (5min)"]
        EB["EventBridge Rules<br/>CloudTrail → Lambda"]
        CT["CloudTrail<br/>Bedrock API Logs"]
    end

    subgraph Stack04["Stack 04: ECS Dev Environment"]
        DevEnv_ALB["ALB<br/>Host-based Routing"]
        ECS_Cluster["ECS Cluster<br/>EC2 Mode (8 instances)"]
        Tasks["ECS Tasks<br/>6 Task Defs<br/>(2 OS x 3 Tiers)"]
        EFS["Amazon EFS<br/>/home/coder"]
        DevEnv_SGs["Security Groups<br/>open / restricted / locked"]
    end

    subgraph Stack05["Stack 05: Dashboard"]
        Dash_ALB["ALB"]
        Dash_ASG["EC2 ASG<br/>t4g.xlarge"]
        NextJS["Next.js Standalone<br/>PM2 + S3 Deploy"]
    end

    subgraph AWS_Services["AWS Services"]
        Bedrock["Amazon Bedrock<br/>Opus 4.6 / Sonnet 4.6"]
        Bedrock_VPCE["Bedrock<br/>VPC Endpoint"]
        ECR["Amazon ECR<br/>devenv images"]
        CW["CloudWatch<br/>Container Insights"]
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
    NextJS -->|ECS RunTask/StopTask| ECS_Cluster
    NextJS -->|DynamoDB Query| DDB
    NextJS -->|Bedrock Converse API| Bedrock

    %% Dev Environment Flow (Bedrock Direct)
    DevEnv_ALB -->|Host: user.dev.*| Tasks
    Tasks --> EFS
    Tasks -->|Task Role → IMDS| Bedrock_VPCE
    Bedrock_VPCE --> Bedrock

    %% Usage Tracking Flow
    Tasks -.->|API Call| CT
    CT -->|Event| EB
    EB -->|Trigger| Lambda1
    Lambda1 -->|Write| DDB
    Lambda2 -->|Read/Check| DDB

    %% ECS Cluster
    ECS_Cluster --> Tasks

    %% Infrastructure
    Tasks --> ECR
    Tasks --> CW
    NextJS --> CW

    %% DNS
    R53 -->|CNAME| CF_Dashboard
    R53 -->|Wildcard| CF_DevEnv

    %% Network placement
    Dash_ALB -.-> PubA
    DevEnv_ALB -.-> PubA
    Dash_ASG -.-> PriA
    ECS_Cluster -.-> PriA
    EFS -.-> PriA

    %% Styles
    classDef stack fill:#f9f,stroke:#333,stroke-width:2px
    classDef aws fill:#ff9900,stroke:#333,color:#fff
    classDef user fill:#4a90d9,stroke:#333,color:#fff
    class Stack01,Stack02,Stack03,Stack04,Stack05 stack
    class Bedrock,Bedrock_VPCE,ECR,CW aws
    class AdminUser,DevUser user
```

## Stack Dependencies

```mermaid
graph LR
    S1["01 Network<br/>VPC, Subnets, NAT,<br/>VPC Endpoints, R53,<br/>DNS Firewall"] --> S2["02 Security<br/>Cognito (Hosted UI),<br/>ACM, KMS, Secrets, IAM"]
    S2 --> S3["03 Usage Tracking<br/>DynamoDB, Lambda,<br/>EventBridge, CloudTrail"]
    S2 --> S4["04 ECS DevEnv<br/>ECS Cluster, Tasks,<br/>EFS, ALB, CloudFront"]
    S4 --> S5["05 Dashboard<br/>Next.js, ALB,<br/>CloudFront"]
    S3 --> S5
```

## User Access Flow

```mermaid
sequenceDiagram
    participant User as Developer
    participant CF as CloudFront
    participant Dash as Dashboard
    participant Cognito as Cognito<br/>Hosted UI
    participant ECS as ECS Cluster
    participant DevEnv as Dev Environment<br/>(user.dev.whchoi.net)
    participant Bedrock as Amazon Bedrock

    User->>CF: 1. Access dashboard
    CF->>Dash: 2. Forward (X-Custom-Secret)
    Dash->>Cognito: 3. OAuth redirect
    Cognito->>Dash: 4. Auth code → token
    User->>Dash: 5. Admin starts container
    Dash->>ECS: 6. RunTask (devenv-ubuntu-standard)
    Note over ECS: ASG scales if needed
    ECS-->>Dash: 7. Task started + ALB registered
    Dash-->>User: 8. Link: user.dev.whchoi.net
    User->>DevEnv: 9. Open code-server (password auth)
    Note over DevEnv: Workspace from EFS
    DevEnv->>Bedrock: 10. Claude Code → Task Role → Bedrock VPC Endpoint
    Bedrock-->>DevEnv: 11. Streamed response
    Note over DevEnv: 2h inactivity → auto-stop
```

## Bedrock Access (Direct Mode)

```mermaid
graph LR
    CC["Claude Code<br/>(in ECS Task)"] -->|"Task Role → IMDS<br/>CLAUDE_CODE_USE_BEDROCK=1"| VPCE["Bedrock<br/>VPC Endpoint"]
    VPCE --> Bedrock["Amazon<br/>Bedrock"]

    Dashboard["Dashboard<br/>(AI Assistant)"] -->|"EC2 Instance Role<br/>Converse API"| Bedrock

    CT["CloudTrail"] -.->|"Logs all<br/>InvokeModel calls"| EB["EventBridge"]
    EB -.->|"Trigger"| Lambda["Lambda"]
    Lambda -.->|"Write"| DDB["DynamoDB<br/>(usage tracking)"]

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

        ECS_EC2["ECS Host EC2 x8"]
        Dash_EC2["Dashboard EC2"]

        EFS_FS["Amazon EFS"]

        ALB1 -.-> PS_A
        ALB2 -.-> PS_A
        NAT1 -.-> PS_A
        NAT2 -.-> PS_C

        ECS_EC2 -.-> PR_A
        Dash_EC2 -.-> PR_A
        EFS_FS -.-> PR_A
    end

    Internet["Internet<br/>CloudFront"] --> ALB1
    Internet --> ALB2
```

## DLP Security Policies

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

## Usage Tracking Pipeline

```mermaid
graph LR
    subgraph ECS["ECS Containers"]
        CC["Claude Code"]
    end

    CC -->|"InvokeModel"| Bedrock["Bedrock"]
    Bedrock -.->|"Logged"| CT["CloudTrail"]
    CT -->|"Event"| EB["EventBridge<br/>Rule"]
    EB -->|"Trigger"| L1["Lambda<br/>usage-tracker"]
    L1 -->|"PutItem"| DDB["DynamoDB<br/>cc-on-bedrock-usage"]

    L2["Lambda<br/>budget-check<br/>(every 5min)"] -->|"Scan"| DDB
    L2 -->|"If over budget"| IAM["IAM<br/>Deny Policy"]

    Dashboard["Dashboard"] -->|"Query"| DDB

    style Bedrock fill:#ff9900,color:#fff
    style DDB fill:#4053d6,color:#fff
```
