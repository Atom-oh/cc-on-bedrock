# CC-on-Bedrock: Architecture Design Specification

## Overview

AWS Bedrock 기반 멀티유저 Claude Code 개발환경 플랫폼.
CDK(TypeScript), Terraform(HCL), CloudFormation(YAML) 3가지 IaC로 동일 아키텍처를 구현하여 교육/가이드 자료로 활용.

- **Region:** ap-northeast-2 (Seoul)
- **Models:** Opus 4.6 (`global.anthropic.claude-opus-4-6-v1[1m]`), Sonnet 4.6 (`global.anthropic.claude-sonnet-4-6[1m]`)
- **Users:** Default 10-20, scalable to 100
- **IaC:** CDK (TypeScript) + Terraform (HCL) + CloudFormation (YAML)
- **Reference repos:**
  - https://github.com/whchoi98/ec2_vscode
  - https://github.com/whchoi98/aws_lab_infra
  - https://github.com/BerriAI/litellm

> **Note on Model IDs:** The `global.*` prefix enables cross-region inference profiles.
> Bedrock VPC Endpoints may only support regional models. If cross-region inference is not
> supported via VPC Endpoint, LiteLLM should route global model calls through NAT Gateway
> (public endpoint) and regional model calls through VPC Endpoint. Verify during implementation.

---

## Architecture Diagram

```
                         +---------------------------------------------+
                         |              Users (Browser)                 |
                         +------+------------------+----------+--------+
                                |                  |          |
                    +-----------v----+  +----------v---+  +---v--------------+
                    |  CloudFront    |  |  CloudFront  |  |  CloudFront      |
                    |  Dev Env       |  |  Dashboard   |  |  (none for       |
                    |                |  |              |  |   LiteLLM)       |
                    +-------+--------+  +------+-------+  +------------------+
                            |                  |
                    +-------v--------+  +------v-------+
                    |  ALB           |  |  ALB         |
                    |  Cognito Auth  |  |  Cognito Auth|
                    +-------+--------+  +------+-------+
                            |                  |
                    +-------v--------+  +------v-------+   +----------------+
                    | ECS Cluster    |  | EC2          |   | ALB (Internal) |
                    | (EC2 Mode)     |  | Next.js      |   |                |
                    | (ECR Image)    |  | Dashboard    |   +-------+--------+
                    +---+------------+  +---+----------+           |
                        |                   |              +-------v--------+
                        |                   |              | EC2 ASG x2     |
              +---------+----+--------------+              | LiteLLM Proxy  |
              |              |                             | (ECR Image)    |
              v              v                             +--+----+----+---+
     +----------+    +----------+                             |    |    |
     | Bedrock  |    | Cognito  |                  +----------+    |    +------+
     | (VPC EP) |    | User Pool|                  v               v          v
     +----------+    +----------+           +----------+ +--------------+ +--------+
                                            | Bedrock  | |  Serverless  | |  RDS   |
                                            | (VPC EP) | |    Valkey    | | PgSQL  |
                                            +----------+ +--------------+ +--------+
                                                                               |
                                                                        +------v------+
                                                                        |   Amazon    |
                                                                        |    EFS      |
                                                                        +-------------+
```

> **LiteLLM is internal-only.** No CloudFront distribution for LiteLLM.
> ECS containers and Dashboard access LiteLLM via the internal ALB only.
> LiteLLM is protected by: Internal ALB (not internet-facing) + Security Group + Master Key authentication.

---

## Component Stacks (5 Stacks)

### Stack 01: Network

| Resource | Configuration |
|----------|---------------|
| VPC | `${VpcName}` / `${VpcCidr}` (/16, input at deploy) |
| Public Subnets | `${PublicSubnetCidrA}`, `${PublicSubnetCidrC}` (input, /24) x 2 AZ - ALB |
| Private Subnets | `${PrivateSubnetCidrA}`, `${PrivateSubnetCidrC}` (input, /20) x 2 AZ - EC2, ECS, Dashboard |
| Isolated Subnets | `${IsolatedSubnetCidrA}`, `${IsolatedSubnetCidrC}` (input, /23) x 2 AZ - RDS, Valkey, EFS |
| NAT Gateway | x2 (one per AZ) |
| VPC Endpoints (Interface x7) | SSM, SSM Messages, EC2 Messages, ECR API, ECR DKR, Bedrock Runtime, CloudWatch Logs |
| VPC Endpoints (Gateway x1) | S3 (free) |
| Route 53 | Hosted Zone `${DomainName}` (input at deploy) |

**Deploy Parameters:**

| Parameter | Description | Example |
|-----------|-------------|---------|
| `VpcName` | VPC name | `cc-on-bedrock-vpc` |
| `VpcCidr` | VPC CIDR (/16) | `10.0.0.0/16` |
| `PublicSubnetCidrA` | Public Subnet AZ-a (/24) | `10.0.1.0/24` |
| `PublicSubnetCidrC` | Public Subnet AZ-c (/24) | `10.0.2.0/24` |
| `PrivateSubnetCidrA` | Private Subnet AZ-a (/20) | `10.0.16.0/20` |
| `PrivateSubnetCidrC` | Private Subnet AZ-c (/20) | `10.0.32.0/20` |
| `IsolatedSubnetCidrA` | Isolated Subnet AZ-a (/23) | `10.0.100.0/23` |
| `IsolatedSubnetCidrC` | Isolated Subnet AZ-c (/23) | `10.0.102.0/23` |
| `DomainName` | Base domain | `example.com` |
| `DevSubdomain` | Dev env subdomain prefix | `dev` -> `*.dev.example.com` |

### Stack 02: Security

**Cognito User Pool:**

| Config | Value |
|--------|-------|
| Hosted UI | Enabled |
| Self-signup | Disabled (admin creates users) |
| Groups | `admin` (dashboard admin), `user` (dev env only) |
| Custom Attributes | `custom:subdomain`, `custom:container_os` (ubuntu/al2023), `custom:resource_tier` (light/standard/power), `custom:security_policy` (open/restricted/locked), `custom:litellm_api_key`, `custom:container_id` |

**ACM Certificates:**
- `*.dev.${DomainName}` in us-east-1 (CloudFront for Dev Env)
- `*.dev.${DomainName}` in ap-northeast-2 (ALB for Dev Env)
- `dashboard.${DomainName}` in us-east-1 (CloudFront for Dashboard)
- `dashboard.${DomainName}` in ap-northeast-2 (ALB for Dashboard)

**KMS:** EBS, RDS, EFS encryption keys

**Secrets Manager:**

| Secret | Purpose |
|--------|---------|
| `cc-on-bedrock/litellm-master-key` | LiteLLM admin API key |
| `cc-on-bedrock/rds-credentials` | PostgreSQL credentials |
| `cc-on-bedrock/cloudfront-secret` | X-Custom-Secret header value |
| `cc-on-bedrock/valkey-auth` | Serverless Valkey auth token |

**IAM Roles:**

| Role | Target | Permissions |
|------|--------|-------------|
| `LiteLLMEC2Role` | LiteLLM EC2 | `bedrock:InvokeModel`, `bedrock:InvokeModelWithResponseStream`, SSM, ECR Pull |
| `ECSTaskRole` | ECS containers | `bedrock:InvokeModel`, `bedrock:InvokeModelWithResponseStream` |
| `ECSTaskExecutionRole` | ECS agent | ECR Pull, CloudWatch Logs, Secrets Manager |
| `DashboardEC2Role` | Next.js EC2 | Cognito Admin API, ECS RunTask/StopTask/DescribeTasks, SSM |

**Security Policies:**
- CloudFront Prefix List: ALB SG allows only CloudFront origin-facing IPs
- X-Custom-Secret Header: CloudFront -> ALB custom header, direct ALB access blocked (403)
- LiteLLM ALB: Internal (not internet-facing), SG allows only Private Subnet CIDR
- Private Subnet: All compute in private subnets, no direct internet exposure
- SSM VPC Endpoints: Session Manager access (no SSH)
- EBS/RDS/EFS Encryption: KMS enabled
- DLP Security Policy: Per-user file transfer + network egress control (see DLP section below)

**DLP (Data Loss Prevention) Security Policy:**

Per-user security policy configurable via `custom:security_policy` Cognito attribute.
Container entrypoint script applies policy at startup.

| Policy | File Download | File Upload | Clipboard | Outbound Network | Extension Install | Use Case |
|--------|:------------:|:-----------:|:---------:|:----------------:|:-----------------:|----------|
| `open` | ✅ | ✅ | ✅ | ✅ All | ✅ | Education/Lab |
| `restricted` | ❌ | ❌ | ✅ | ✅ Whitelist only | ✅ Pre-approved only | General production |
| `locked` | ❌ | ❌ | ❌ (best-effort) | ❌ Internal only | ❌ Read-only | High-security production |

**Implementation layers:**

Layer 1 - code-server flags (per container):
```bash
# entrypoint.sh
case "$SECURITY_POLICY" in
  open)
    EXTRA_FLAGS="" ;;
  restricted)
    EXTRA_FLAGS="--disable-file-downloads --disable-file-uploads" ;;
  locked)
    EXTRA_FLAGS="--disable-file-downloads --disable-file-uploads"
    # Extensions dir read-only, clipboard API blocked via CSP headers
    ;;
esac
code-server $EXTRA_FLAGS --bind-addr 0.0.0.0:8080
```

Layer 2 - Network egress (per security group):
```
SG: devenv-open        -> Outbound: 0.0.0.0/0 (all)
SG: devenv-restricted  -> Outbound: VPC CIDR + whitelist IPs (github.com, npmjs.org, pypi.org, etc.)
SG: devenv-locked      -> Outbound: VPC CIDR only (LiteLLM ALB, Bedrock VPC EP, ECR VPC EP)
```

Layer 3 - Route 53 Resolver DNS Firewall (domain-based, for `restricted` policy):
```
DNS Firewall Rule Group (VPC 연결):
  Allow list: github.com, npmjs.org, pypi.org, ubuntu.com, amazonaws.com, ...
  Deny list:  all other domains -> NXDOMAIN 응답
```
- `restricted` 정책 컨테이너의 DNS 쿼리를 도메인 기반으로 필터링
- `locked` 정책은 내부 도메인(VPC DNS)만 허용
- Network Firewall 대비 저비용 (DNS 쿼리당 과금, ~$1-5/월 수준)

Layer 4 - Extension control (for `restricted`/`locked`):
```bash
# restricted: pre-approved extensions list only
code-server --extensions-dir /opt/extensions-approved --user-data-dir /home/coder/.vscode

# locked: extensions dir mounted read-only
code-server --extensions-dir /opt/extensions-readonly
```

### Stack 03: LiteLLM Proxy

**Compute:**

| Config | Value |
|--------|-------|
| Instance Type | t4g.xlarge (4 vCPU, 16 GiB) |
| AMI | Amazon Linux 2023 (ARM64) |
| ASG | Min: 2, Max: 4, Desired: 2 |
| EBS | gp3 50GB, KMS encrypted |
| Deploy | ECR image pull -> docker run |
| Health Check | ALB -> `/health/liveness` |
| ECR Repo | `cc-on-bedrock/litellm` |
| ALB | **Internal** (not internet-facing) |

**LiteLLM Docker Image:**
- Base: Official LiteLLM image (`ghcr.io/berriai/litellm`)
- Custom: Add `litellm-config.yaml` + startup script
- Pushed to ECR `cc-on-bedrock/litellm`

```
docker/litellm/
  Dockerfile              <- FROM ghcr.io/berriai/litellm:main
  litellm-config.yaml     <- Model + router config
  scripts/entrypoint.sh   <- Secrets Manager fetch + startup
```

**LiteLLM Config (`litellm-config.yaml`):**

```yaml
model_list:
  - model_name: "claude-opus-4-6"
    litellm_params:
      model: "bedrock/global.anthropic.claude-opus-4-6-v1[1m]"
      aws_region_name: "ap-northeast-2"
  - model_name: "claude-sonnet-4-6"
    litellm_params:
      model: "bedrock/global.anthropic.claude-sonnet-4-6[1m]"
      aws_region_name: "ap-northeast-2"

router_settings:
  redis_host: <serverless-valkey-endpoint>
  redis_port: 6380
  redis_password: <from-secrets-manager>
  redis_ssl: true

general_settings:
  master_key: <from-secrets-manager>
  database_url: <rds-postgresql-connection-string>
  use_redis_transaction_buffer: true

litellm_settings:
  cache: true
  cache_params:
    type: redis
    host: <serverless-valkey-endpoint>
    port: 6380
    ssl: true
  drop_params: true
```

**RDS PostgreSQL:**

| Config | Value |
|--------|-------|
| Instance | db.t4g.medium (2 vCPU, 4 GiB) |
| Engine | PostgreSQL 16 |
| Storage | gp3 20GB, KMS encrypted |
| Multi-AZ | Single-AZ (education), Multi-AZ for production |
| Subnet | Isolated Subnet (/23) |
| Auth | Secrets Manager |
| Backup | Automated, 7-day retention |

**Serverless Valkey:**

| Config | Value |
|--------|-------|
| Engine | Valkey (Serverless) |
| Purpose | Rate limiting (RPM/TPM) + cache sharing across LiteLLM instances |
| Subnet | Isolated Subnet (/23) |
| TLS | Enabled (required for Serverless), port 6380 |
| Cost | ~$8/month (minimum 100MB storage) |

### Stack 04: ECS Dev Environment

**ECS Cluster:**

| Config | Value |
|--------|-------|
| Launch Type | EC2 (Managed, awsvpc mode) |
| Host Instance | m7g.4xlarge (16 vCPU, 64 GiB) |
| Capacity Provider | ASG (Min: 0, Max: 15) |
| ENI Trunking | Enabled (m7g.4xlarge supports ~120 branch ENIs, well above 14 tasks/host max) |
| Tasks per Host | ~3-14 (depending on tier mix, limited by CPU/memory not ENI) |

**6 Task Definitions (OS 2 x Tier 3):**

| Task Definition | OS | vCPU | Memory | EBS |
|----------------|-----|------|--------|-----|
| `devenv-ubuntu-light` | Ubuntu 24.04 | 1 | 4 GiB | 20GB |
| `devenv-ubuntu-standard` | Ubuntu 24.04 | 2 | 8 GiB | 20GB |
| `devenv-ubuntu-power` | Ubuntu 24.04 | 4 | 12 GiB | 20GB |
| `devenv-al2023-light` | Amazon Linux 2023 | 1 | 4 GiB | 20GB |
| `devenv-al2023-standard` | Amazon Linux 2023 | 2 | 8 GiB | 20GB |
| `devenv-al2023-power` | Amazon Linux 2023 | 4 | 12 GiB | 20GB |

**Container Image (ECR `cc-on-bedrock/devenv`):**

Two images: `:ubuntu-latest`, `:al2023-latest`

```
Common software stack:
- code-server (latest stable, verify Claude Code Extension + Kiro compatibility)
- Claude Code CLI + VSCode Extension
- Kiro CLI + configuration
- Node.js 20, Python 3, pip, uv
- AWS CLI v2, Docker CLI
- Git, curl, jq
- Bedrock MCP servers pre-configured
```

Two Dockerfiles with shared setup script:
```
docker/devenv/
  Dockerfile.ubuntu      <- FROM ubuntu:24.04
  Dockerfile.al2023      <- FROM amazonlinux:2023
  scripts/setup-common.sh <- Shared install logic
```

**Container Environment Variables:**

```yaml
environment:
  - name: ANTHROPIC_BASE_URL
    value: "http://<litellm-alb-internal>:4000"  # LiteLLM proxy (primary)
  - name: ANTHROPIC_API_KEY
    value: <per-user LiteLLM Virtual Key>        # From Secrets Manager
  - name: AWS_DEFAULT_REGION
    value: "ap-northeast-2"
  - name: SECURITY_POLICY
    value: <from Cognito custom:security_policy>  # open / restricted / locked
  # Direct Bedrock access via Task Role IAM (secondary/fallback)
```

**Security Group assignment per policy:**
- Each ECS Task is assigned to one of three Security Groups (`devenv-open`, `devenv-restricted`, `devenv-locked`) based on `SECURITY_POLICY` at task launch time.
- The Dashboard's RunTask call selects the appropriate SG from the user's Cognito attribute.

**Amazon EFS (Persistent Storage):**

| Config | Value |
|--------|-------|
| Performance | General Purpose |
| Throughput | Bursting |
| Lifecycle | Intelligent Tiering (30 days -> IA) |
| Encryption | KMS at rest + TLS in transit |
| Access Points | Per-user (POSIX UID mapping for directory isolation) |
| Mount | `/home/coder` per task |
| Structure | `/efs/users/{subdomain}/` per user |
| Data preserved | workspace, .vscode, .claude, .kiro, git repos, build cache |
| Backup | AWS Backup, 7-day retention |

**Routing (Subdomain-based):**

```
user01.dev.example.com
  -> CloudFront (wildcard cert *.dev.example.com)
  -> ALB:443 (X-Custom-Secret validation + Cognito auth)
  -> Listener Rule: Host=user01.dev.example.com -> Target Group (Task-1)
  -> code-server (VSCode Web IDE)
```

- Route 53: Wildcard A record `*.dev.${DomainName}` -> CloudFront Distribution
- ALB: Single listener (443), host-based routing rules per user

**ASG Scaling Policy:**

```yaml
ECS Capacity Provider:
  minimum_scaling_step_size: 1
  maximum_scaling_step_size: 3
  target_capacity: 80  # 80% utilization target

ASG:
  min_size: 0       # Zero instances when no tasks running
  max_size: 15      # Production 100 users
  desired_capacity: 0  # ECS auto-adjusts
```

**Auto-timeout:** 2 hours of inactivity -> automatic task stop
- Detection: code-server idle detection API + CloudWatch custom metric
- Action: Lambda function polls idle status, calls ECS StopTask

### Stack 05: Next.js Dashboard

**Compute:**

| Config | Value |
|--------|-------|
| Instance | t4g.xlarge (4 vCPU, 16 GiB) |
| AMI | Amazon Linux 2023 (ARM64) |
| ASG | Min: 1, Max: 2 (HA for admin operations) |
| EBS | gp3 30GB, KMS encrypted |
| Deploy | Node.js 20 + Next.js (PM2 process manager) |
| Health Check | ALB -> `/api/health` |
| Domain | `dashboard.${DomainName}` |

**Tech Stack:**

| Item | Choice |
|------|--------|
| Framework | Next.js 14+ (App Router) |
| UI | Tailwind CSS + shadcn/ui |
| Charts | Recharts |
| Auth | next-auth + Cognito Provider |
| API | Server Actions + LiteLLM REST API |
| State | React Server Components (minimal client state) |

**Features:**

A) Analytics (user + admin):
- Per-user token usage (input/output tokens)
- Model usage ratio (Opus 4.6 vs Sonnet 4.6)
- Cost estimation per user/team
- Daily/weekly/monthly trends (time series charts)

B) Operations Monitoring (admin):
- LiteLLM proxy health (per EC2 instance)
- ECS container status and resource utilization
- Active session list (current online users)
- Error rate and latency monitoring

C) Administration (admin only):
- User CRUD (Cognito + LiteLLM Virtual Key creation)
- API key management (renew, deactivate)
- Usage limits (per-user RPM/TPM/Budget)
- Container allocation (subdomain + OS + tier + security policy assignment)
- Container start/stop control
- Auto-timeout configuration

**CloudFront:**
- HTTPS termination (`dashboard.${DomainName}`)
- X-Custom-Secret header injection
- Origin: ALB (Cognito auth)

---

## Observability

### CloudWatch Log Groups

| Log Group | Source |
|-----------|--------|
| `/cc-on-bedrock/litellm` | LiteLLM proxy logs |
| `/cc-on-bedrock/ecs/devenv` | ECS task logs (code-server, Claude Code) |
| `/cc-on-bedrock/dashboard` | Next.js application logs |
| `/cc-on-bedrock/alb/*` | ALB access logs |

### CloudWatch Alarms

| Alarm | Condition | Action |
|-------|-----------|--------|
| ECS Host Capacity | ASG target capacity > 90% | SNS notification |
| RDS CPU | > 80% for 5 min | SNS notification |
| ALB 5xx Rate | > 5% for 3 min | SNS notification |
| LiteLLM Health | Unhealthy target count > 0 | SNS notification |
| EFS Burst Credits | < 20% remaining | SNS notification |

---

## User Flow

### Admin: Create User
```
1. Admin logs into Dashboard (dashboard.example.com)
2. Creates user:
   - Cognito: email, subdomain=user01, container_os=ubuntu, resource_tier=standard, security_policy=restricted
   - LiteLLM: Generate Virtual Key -> store in Cognito custom:litellm_api_key
3. System creates ALB listener rule: Host=user01.dev.example.com -> new Target Group
```

### User: Daily Workflow
```
1. User opens browser -> https://dashboard.example.com
2. Cognito Hosted UI -> login
3. Dashboard shows user's dev environment panel
4. User clicks "Start Dev Environment"
5. Dashboard calls ECS RunTask (devenv-ubuntu-standard)
   -> EFS mount /efs/users/user01 via Access Point
   -> ASG scales out if no available host
6. Dashboard polls task status, shows "Starting..." -> "Ready"
7. Dashboard provides link: https://user01.dev.example.com
8. User clicks link -> code-server opens -> previous workspace restored from EFS
9. User works with Claude Code (via LiteLLM proxy) and Kiro
10. User returns to Dashboard and clicks "Stop", or auto-timeout after 2h inactivity
11. Task stops -> EFS data preserved -> ASG scales in if hosts empty
```

### Bedrock Access Paths
```
Primary:   Claude Code -> ANTHROPIC_BASE_URL -> LiteLLM (Internal ALB) -> Bedrock (usage tracked)
Secondary: boto3/SDK -> Task Role IAM -> Bedrock VPC Endpoint (direct, for development)
Fallback:  If LiteLLM down -> Claude Code can use Task Role IAM directly
```

---

## Project Directory Structure

```
cc-on-bedrock/
├── docs/superpowers/specs/              # Design documents
├── cdk/                                 # AWS CDK (TypeScript)
│   ├── bin/app.ts
│   └── lib/
│       ├── 01-network-stack.ts
│       ├── 02-security-stack.ts
│       ├── 03-litellm-stack.ts
│       ├── 04-ecs-devenv-stack.ts
│       └── 05-dashboard-stack.ts
├── terraform/                           # Terraform (HCL)
│   ├── modules/
│   │   ├── network/
│   │   ├── security/
│   │   ├── litellm/
│   │   ├── ecs-devenv/
│   │   └── dashboard/
│   ├── main.tf
│   └── variables.tf
├── cloudformation/                      # CloudFormation (YAML)
│   ├── 01-network.yaml
│   ├── 02-security.yaml
│   ├── 03-litellm.yaml
│   ├── 04-ecs-devenv.yaml
│   └── 05-dashboard.yaml
├── docker/                              # Docker images
│   ├── devenv/
│   │   ├── Dockerfile.ubuntu
│   │   ├── Dockerfile.al2023
│   │   └── scripts/setup-common.sh
│   └── litellm/
│       ├── Dockerfile
│       ├── litellm-config.yaml
│       └── scripts/entrypoint.sh
├── shared/                              # Shared configs
│   └── nextjs-app/
└── README.md
```

---

## Cost Estimate (Education: 20 Users, Seoul Region)

### With Auto-Scaling (Average)

| Resource | Spec | Monthly Cost |
|----------|------|-------------|
| EC2 - LiteLLM x2 | t4g.xlarge | ~$290 |
| EC2 - ECS Host (avg ~1.5) | m7g.4xlarge | ~$700 |
| EC2 - Dashboard (ASG min:1) | t4g.xlarge | ~$145 |
| RDS PostgreSQL | db.t4g.medium, 7-day backup | ~$80 |
| Serverless Valkey | min 100MB | ~$8 |
| Amazon EFS | 20 users x 10GB, Intelligent Tiering | ~$20-40 |
| NAT Gateway x2 | | ~$90 |
| ALB x3 | 2 external + 1 internal | ~$60 |
| CloudFront x2 | Dev Env + Dashboard (no LiteLLM) | ~$2-7 |
| VPC Endpoints x7 | Interface ($7.30/EP/AZ x 2 AZ) | ~$102 |
| Route 53 + ACM | | ~$1 |
| ECR | Image storage (3 images) | ~$2-5 |
| Bedrock | Usage-based | Variable |
| **Total (excl. Bedrock)** | | **~$1,500-1,530/month** |

### Always-On (No Scaling)

| Change | Cost |
|--------|------|
| ECS Host always 3x m7g.4xlarge | ~$1,758 |
| **Total (excl. Bedrock)** | **~$2,560-2,600/month** |

### Production (100 Users, Standard Tier)

| Resource | Change | Cost |
|----------|--------|------|
| ECS Host ~15x m7g.4xlarge | | ~$8,790 |
| EFS 100 users x 10GB | | ~$100-200 |
| RDS Multi-AZ | db.t4g.medium | ~$150 |
| Dashboard ASG max:2 | | ~$290 |
| LiteLLM ASG max:4 | | ~$580 |
| Other (NAT, ALB, VPC EP, CF) | | ~$260 |
| **Total (excl. Bedrock)** | | **~$10,200-10,500/month** |

---

## Key Design Decisions

1. **3 IaC tools:** CDK + Terraform + CloudFormation for education/guide purposes
2. **Subdomain routing:** `user01.dev.example.com` instead of port-based (CloudFront compatibility)
3. **Dual Bedrock path:** LiteLLM proxy (primary, tracked) + direct IAM (secondary, fallback)
4. **Serverless Valkey:** Cheaper than provisioned ($8 vs $14/month), zero management, auto Multi-AZ, TLS required (port 6380)
5. **EFS persistent storage:** User data survives container stop/restart, enables ASG scale-to-zero, per-user Access Points for isolation
6. **Tiered resources:** Light(1vCPU/4GiB), Standard(2vCPU/8GiB), Power(4vCPU/12GiB) per user
7. **Dual OS images:** Ubuntu 24.04 + Amazon Linux 2023, user-selectable
8. **m7g.4xlarge ECS hosts:** Non-burstable, optimal bin-packing for mixed tiers, ~120 branch ENIs with trunking
9. **ASG Min:0:** Zero-cost when no users active, auto-timeout at 2h inactivity via code-server idle detection
10. **Component-based stacks:** 5 independent stacks for modularity and 1:1 IaC comparison
11. **LiteLLM internal-only:** No CloudFront, internal ALB only, accessed by ECS tasks and Dashboard
12. **All subnet CIDRs as input parameters:** VPC, Public, Private, Isolated CIDRs all configurable at deploy time
13. **Dashboard user flow:** Users always start from Dashboard, then navigate to their dev environment subdomain
14. **DLP security policy:** Per-user open/restricted/locked policy controlling file transfer, network egress, clipboard, and extension install via 4 enforcement layers (code-server flags, Security Groups, Route 53 DNS Firewall for domain-based filtering, extension control)
