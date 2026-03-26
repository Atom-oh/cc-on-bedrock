# CC-on-Bedrock Architecture & Cost Review

**Date**: 2026-03-26 | **Reviewer**: Senior AWS Solutions Architect | **Region**: ap-northeast-2 (Seoul)

---

## Table of Contents

1. [Cost Optimization](#1-cost-optimization)
2. [Architecture Review](#2-architecture-review)
3. [EFS Deep Analysis](#3-efs-deep-analysis)
4. [Security Issues](#4-security-issues)
5. [Monthly Cost Estimates](#5-monthly-cost-estimates)

---

## 1. Cost Optimization

### 1.1 ECS EC2 vs Fargate Analysis

**Current**: ECS on EC2 (m7g.4xlarge, 16 vCPU / 64 GiB, ASG min:0 max:15)

| Factor | ECS EC2 (Current) | Fargate |
|--------|-------------------|---------|
| m7g.4xlarge On-Demand | ~$467/mo per instance | N/A |
| Fargate ARM (2 vCPU / 8 GiB) | N/A | ~$95/mo per task (24/7) |
| Fargate ARM (4 vCPU / 12 GiB) | N/A | ~$165/mo per task (24/7) |
| Bin-packing (standard tier) | ~8 tasks per host = ~$58/task | $95/task |
| EFS support | ✅ | ✅ |
| ECS Exec | ✅ | ✅ |
| GPU/custom AMI | ✅ | ❌ |
| Spot support | ✅ (dev workloads) | ✅ (Fargate Spot) |

**Verdict**: EC2 is the correct choice for this workload. At 8 standard tasks per m7g.4xlarge, the per-task cost is ~$58 vs ~$95 on Fargate — a **39% savings**. The ASG min:0 design is excellent for off-hours cost elimination.

**Severity**: ✅ Good — No change needed

**Recommendations**:
- `[LOW]` Consider **Spot Instances** for the ECS capacity provider. Dev workloads tolerate interruption well. Savings: ~60-70% → per-task cost drops to ~$17-23.
- `[LOW]` Add a **scheduled scaling action** to set desiredCapacity=0 outside business hours (e.g., 8PM-8AM KST) if not already automated.

### 1.2 EFS Cost Analysis — Bursting vs Elastic Throughput

**Current**: General Purpose, Bursting throughput, lifecycle to IA after 30 days

**Seoul Region EFS Pricing** (verified from AWS Price List API):

| Storage Class | Price (GB-Mo) |
|---------------|---------------|
| Standard (General Purpose) | $0.33 |
| Infrequent Access (IA) | $0.027 |
| One Zone Standard | $0.176 |
| One Zone IA | $0.0145 |
| Archive | $0.01 |

| Throughput Mode | Cost |
|-----------------|------|
| Bursting | Free (included with storage, 50 MiB/s per TiB) |
| Elastic | $0.07/GB write, $0.03/GB read |
| Provisioned | $6.60/MiBps-Mo |

**Problem with Bursting at scale**: With 10 users × 10 GB = 100 GB storage, burst throughput = **5 MiB/s baseline**. This is critically low for concurrent `npm install` operations.

| Users | Storage Est. | Burst Baseline | Burst Credit Duration |
|-------|-------------|----------------|----------------------|
| 10 | 100 GB | 5 MiB/s | ~2.3 hrs at 100 MiB/s |
| 30 | 300 GB | 15 MiB/s | ~2.3 hrs at 100 MiB/s |
| 50 | 500 GB | 25 MiB/s | ~2.3 hrs at 100 MiB/s |

**Severity**: 🔴 CRITICAL for 30+ users

**Recommendation**: Switch to **Elastic Throughput** for production deployments with 30+ users. The per-GB I/O cost is offset by avoiding the burst credit exhaustion cliff that causes `npm install` to crawl at 5-25 MiB/s.

**Cost impact of Elastic Throughput** (estimated 50 GB/day read + 20 GB/day write for 30 users):
- Read: 50 GB × 22 days × $0.03 = $33/mo
- Write: 20 GB × 22 days × $0.07 = $30.80/mo
- Total throughput cost: ~$64/mo (vs $0 for Bursting)
- Worth it to avoid the performance cliff

### 1.3 RDS Sizing

**Current**: db.t4g.medium (2 vCPU, 4 GiB RAM), Single-AZ, 20 GB GP3

| Concern | Severity | Detail |
|---------|----------|--------|
| Single-AZ | 🟡 MEDIUM | No failover. Acceptable for education, not production |
| 20 GB storage | ✅ OK | LiteLLM metadata is small. Adequate for 50 users |
| t4g.medium | ✅ OK | Sufficient for proxy metadata. Not a query-heavy workload |
| No read replica | ✅ OK | Dashboard reads are infrequent |

**Note**: The CDK app.ts now uses `UsageTrackingStack` (DynamoDB) instead of LiteLLM's RDS. The LiteLLM stack with RDS is still in Terraform/CloudFormation but appears to be in deprecation. If LiteLLM is fully removed, the RDS instance can be eliminated entirely — saving ~$80/mo.

### 1.4 NAT Gateway Optimization

**Current**: 2 NAT Gateways (one per AZ)

| Item | Monthly Cost |
|------|-------------|
| 2 × NAT GW fixed | $90 ($45 each) |
| Data processing (~100 GB) | ~$5 |
| **Total** | **~$95/mo** |

**Severity**: 🟡 MEDIUM — Overprovisioned for education use

**Recommendations**:
- `[MEDIUM]` For education/workshop (≤20 users): Use **1 NAT Gateway** in a single AZ. Saves $45/mo. Dev workloads tolerate brief AZ outages.
- `[LOW]` VPC Endpoints already cover Bedrock, ECR, SSM, CloudWatch, S3. The remaining NAT traffic is primarily `npm install` / `pip install` from containers. Consider adding a **VPC endpoint for Secrets Manager** to further reduce NAT traffic.
- `[LOW]` Missing VPC Endpoint: **DynamoDB Gateway Endpoint** (free) — the usage tracking Lambda writes to DynamoDB through NAT currently.

### 1.5 VPC Endpoint Cost

**Current**: 7 Interface endpoints × 2 AZs = 14 ENIs

| Item | Monthly Cost |
|------|-------------|
| 7 Interface endpoints × 2 AZs × $0.013/hr | ~$131/mo |
| Data processing (minimal) | ~$2/mo |
| **Total** | **~$133/mo** |

**Severity**: 🟡 MEDIUM

The Bedrock Runtime VPC endpoint alone justifies the cost (security + latency). But for education deployments, consider:
- `[LOW]` Remove `ec2messages` endpoint if ECS Exec via SSM is sufficient (ssm + ssmmessages cover it)
- `[LOW]` Reduce to single-AZ endpoint placement for non-critical endpoints

---

## 2. Architecture Review

### 2.1 Scalability Bottlenecks

| Bottleneck | Severity | Detail |
|------------|----------|--------|
| **EFS Bursting throughput** | 🔴 CRITICAL | 30+ concurrent `npm install` will exhaust burst credits in minutes. See Section 3. |
| **ALB rule limit** | 🟡 MEDIUM | ALB supports 100 rules per listener. At 50 users, you're at 50% capacity. At 100 users, you hit the limit. Need to request quota increase or implement path-based routing. |
| **Dashboard ASG max:2** | 🟡 MEDIUM | Single Next.js instance handles all API routes including ECS RunTask, ALB management, Cognito CRUD. Under 50+ concurrent admin operations, this becomes a bottleneck. |
| **ListTasks pagination** | 🟢 LOW | `listContainers()` uses `maxResults: 100`. At 100+ users, needs pagination. |
| **Per-user IAM role creation** | 🟡 MEDIUM | `ensureUserTaskRole()` creates IAM roles on-demand with a 3-second sleep for propagation. At scale, this adds latency and risks IAM API throttling. Pre-create roles during user creation instead. |

### 2.2 Single Points of Failure

| Component | SPOF? | Impact | Mitigation |
|-----------|-------|--------|------------|
| **RDS Single-AZ** | 🔴 YES | LiteLLM proxy down → no AI proxy analytics | Enable Multi-AZ ($80→$160/mo) or remove if migrating to DynamoDB |
| **Dashboard EC2 (min:1)** | 🟡 PARTIAL | Single instance. ASG recovers but ~5 min downtime | Acceptable for education. Production: min:2 |
| **EFS** | ✅ NO | Multi-AZ by default | Regional service, highly durable |
| **NAT Gateway** | ✅ NO | 2 NAT GWs across AZs | Properly redundant |
| **CloudFront** | ✅ NO | Global edge network | AWS-managed HA |
| **Cognito** | ✅ NO | Regional managed service | AWS-managed HA |

### 2.3 Monitoring Gaps

| Gap | Severity | Detail |
|-----|----------|--------|
| **No EFS CloudWatch alarms** | 🔴 HIGH | No alerts for `BurstCreditBalance` depletion, `PercentIOLimit`, or `ClientConnections`. You'll discover throughput issues only when users complain. |
| **No ALB 5xx alarm** | 🟡 MEDIUM | DevEnv ALB has no CloudWatch alarm for HTTP 5xx errors. Container crashes go unnoticed. |
| **No ECS task failure alarm** | 🟡 MEDIUM | No EventBridge rule for ECS task state changes (STOPPED with non-zero exit code). |
| **Health check is trivial** | 🟡 MEDIUM | `/api/health` returns `{ status: "healthy" }` without checking downstream dependencies (ECS API reachability, Cognito, DynamoDB). |
| **No container idle timeout enforcement** | 🟡 MEDIUM | The doc mentions "2-hour auto-stop" but `idle-monitor.sh` runs inside the container. If the monitor crashes, the container runs indefinitely. Need an external watchdog (Lambda + CloudWatch). |
| **No Bedrock throttling visibility** | 🟢 LOW | No dashboard metric for Bedrock `ThrottlingException` rate. Users may hit model invocation limits without visibility. |

### 2.4 Auto-Scaling Strategy

**Current design is solid**:
- ECS Capacity Provider with managed scaling at 80% target capacity ✅
- ASG min:0 for cost savings ✅
- Dashboard ASG min:1 max:2 ✅

**Gaps**:
- `[MEDIUM]` No **target tracking scaling policy** on the Dashboard ASG. It stays at min:1 regardless of load. Add CPU-based scaling at 70% threshold.
- `[MEDIUM]` ECS capacity provider `maximumScalingStepSize` is not set in CDK (defaults to 10000). Terraform sets it to 10. CDK should match: `maximumScalingStepSize: 10`.
- `[LOW]` No **predictive scaling** for workshop scenarios where you know 30 users will connect at 9 AM. Consider pre-warming the ASG via scheduled actions.

---

## 3. EFS Deep Analysis

### 3.1 Is EFS Right for Shared Dev Storage?

**Yes, with caveats.** EFS is the correct choice for this multi-tenant dev environment because:

| Requirement | EFS | EBS | FSx Lustre | FSx ONTAP |
|-------------|-----|-----|------------|-----------|
| Shared across containers | ✅ Native | ❌ Single-attach | ✅ | ✅ |
| Persist across task restarts | ✅ | ❌ (task-scoped) | ✅ | ✅ |
| Multi-AZ durability | ✅ | ❌ Single-AZ | ❌ Single-AZ | ✅ |
| No capacity planning | ✅ Auto-grow | ❌ Pre-provision | ❌ Pre-provision | ❌ Pre-provision |
| Cost at 200 GB | $66/mo | $16/mo (gp3) | $140/mo (1.2TB min) | $200+/mo |
| ECS native integration | ✅ | ✅ (EC2 only) | ✅ | ✅ |
| POSIX compliance | ✅ | ✅ | ✅ | ✅ |
| Latency (single file) | 1-5ms | 0.5-1ms | 0.2ms | 0.5-2ms |

**EFS wins** on: shared access, auto-scaling storage, multi-AZ, zero capacity planning.
**EFS loses** on: per-file latency, throughput per dollar, small-file IOPS.

### 3.2 Performance Limits for 30+ Concurrent Users

This is the critical issue. `npm install` is the worst-case EFS workload: thousands of small files, heavy metadata operations, random I/O.

**Benchmark estimates for `npm install` (medium project, ~500 packages)**:

| Throughput Mode | 1 user | 10 concurrent | 30 concurrent |
|-----------------|--------|---------------|---------------|
| Bursting (100 GB stored) | ~45s | ~3-5 min | 💀 10-30 min (credit exhaustion) |
| Bursting (500 GB stored) | ~40s | ~2-3 min | ~5-8 min |
| Elastic | ~35s | ~1-2 min | ~2-4 min |
| Provisioned (100 MiB/s) | ~30s | ~1-2 min | ~3-5 min |

**Why `npm install` is pathological on EFS**:
1. Creates 10,000-50,000 small files in `node_modules`
2. Each file create = NFS round-trip (~1-5ms) = 200-1000 IOPS
3. EFS General Purpose mode: 35,000 read IOPS, 7,000 write IOPS (shared across all clients)
4. 30 users × 1,000 write IOPS each = 30,000 IOPS → hits the 7,000 write IOPS limit

**Severity**: 🔴 CRITICAL for 30+ users doing simultaneous `npm install`

### 3.3 EFS vs EBS vs FSx Comparison for This Workload

| Criteria | EFS (Current) | EBS gp3 per-user | FSx for Lustre | FSx for ONTAP |
|----------|---------------|-------------------|----------------|---------------|
| **npm install speed** | Slow (NFS overhead) | Fast (local block) | Fastest | Fast |
| **Multi-tenant sharing** | ✅ Native | ❌ Requires ECS EC2 | ✅ | ✅ |
| **Cost (30 users, 300GB)** | $99/mo + throughput | $48/mo (30×$1.60) | $420/mo min | $600+/mo |
| **Operational complexity** | Low | Medium (per-user volumes) | High | High |
| **Data persistence** | ✅ Always | ❌ Task lifecycle | ✅ | ✅ |
| **Recommendation** | ✅ Best fit | For power users only | Overkill | Overkill |

**Hybrid approach for power users**: Mount EFS for `/home/coder/workspace` (persistent code) but use the container's local EBS for `node_modules` via a symlink or `.npmrc` cache directory. This gives EFS persistence with EBS speed for package installs.

### 3.4 EFS Access Points for Multi-Tenant Isolation

**Current state**: The code uses directory-based isolation (`/users/{subdomain}/`) via `entrypoint.sh`. The EFS task definition mounts `rootDirectory: '/'` and the entrypoint creates per-user directories.

**Problem**: Any container can read/write ANY user's directory. The `chown` in entrypoint.sh is cosmetic — all containers run as the same UID.

**Severity**: 🔴 HIGH — Cross-tenant data access possible

**Recommendation**: Use **EFS Access Points** for proper isolation:

```typescript
// Per-user Access Point (create during user provisioning)
const accessPoint = new efs.AccessPoint(this, `AP-${subdomain}`, {
  fileSystem,
  path: `/users/${subdomain}`,
  createAcl: { ownerUid: '1000', ownerGid: '1000', permissions: '750' },
  posixUser: { uid: '1000', gid: '1000' },
});
```

Then in the task definition's EFS volume config:
```typescript
efsVolumeConfiguration: {
  fileSystemId: fileSystem.fileSystemId,
  transitEncryption: 'ENABLED',
  authorizationConfig: {
    accessPointId: accessPoint.accessPointId,
    iam: 'ENABLED',
  },
}
```

**Benefits**:
- Kernel-level enforcement — container literally cannot see other users' files
- Automatic directory creation with correct permissions
- IAM authorization adds another layer
- No code changes needed in entrypoint.sh

**Limit**: 1,000 Access Points per file system (sufficient for 1,000 users)

### 3.5 EFS Intelligent-Tiering

**Current**: `lifecyclePolicy: AFTER_30_DAYS` (moves to IA after 30 days of no access)

This is good but incomplete. Recommendations:

| Setting | Current | Recommended | Impact |
|---------|---------|-------------|--------|
| Transition to IA | 30 days | **14 days** | Old project files tier faster. Saves ~30% on storage |
| Transition back to Standard | Not set | **On first access** | Ensures active files are in Standard tier |
| Intelligent-Tiering | Not enabled | **Enable** | Automatic optimization |

**Cost savings estimate** (30 users, 300 GB total):
- Current (all Standard): 300 GB × $0.33 = $99/mo
- With IA tiering (60% in IA): 120 GB × $0.33 + 180 GB × $0.027 = $44.46/mo
- **Savings: ~$55/mo (55%)**

---

## 4. Security Issues

### 4.1 Unresolved from Previous Review

| # | Issue | Severity | Status | Detail |
|---|-------|----------|--------|--------|
| S1 | **Shared code-server password** | 🔴 CRITICAL | ⚠️ UNRESOLVED | All users share `CcOnBedrock2026!`. Hardcoded in `aws-clients.ts` line: `CODESERVER_PASSWORD: "CcOnBedrock2026!"`. Any user can access any other user's dev environment by guessing the subdomain URL. |
| S2 | **EFS cross-tenant access** | 🔴 HIGH | ⚠️ UNRESOLVED | No Access Points. All containers mount the same EFS root. User A can `ls /home/coder/users/userB/`. See Section 3.4. |
| S3 | **Bedrock wildcard resource** | 🟡 MEDIUM | ⚠️ UNRESOLVED | ECS Instance Role and Task Role both use `Resource: '*'` for Bedrock. The CDK Task Role correctly scopes to `anthropic.claude-*` patterns, but the Instance Role (line 131 of 04-ecs-devenv-stack.ts) and Terraform both use `Resource: '*'`. |
| S4 | **Dashboard secret in CloudFormation output** | 🟡 MEDIUM | ⚠️ UNRESOLVED | `cloudfrontSecret.secretValue.unsafeUnwrap()` in 05-dashboard-stack.ts embeds the secret in the CloudFormation template. Anyone with `cloudformation:GetTemplate` can read it. |
| S5 | **No WAF on ALBs** | 🟡 MEDIUM | ⚠️ UNRESOLVED | Neither the DevEnv ALB nor Dashboard ALB has AWS WAF attached. CloudFront prefix list helps but doesn't prevent application-layer attacks. |
| S6 | **IMDSv2 not enforced on ECS hosts** | 🟡 MEDIUM | ⚠️ UNRESOLVED | The ECS Launch Template doesn't set `httpTokens: 'required'`. Containers can use IMDSv1 to access instance credentials. |
| S7 | **LiteLLM ALB on HTTP:4000** | 🟢 LOW | ⚠️ UNRESOLVED | Internal ALB listener uses HTTP (no TLS). Traffic between Dashboard/containers and LiteLLM is unencrypted within VPC. Acceptable for internal traffic but not best practice. |

### 4.2 New Security Findings

| # | Issue | Severity | Detail |
|---|-------|----------|--------|
| S8 | **Dashboard creates IAM roles at runtime** | 🔴 HIGH | `ensureUserTaskRole()` in `aws-clients.ts` creates IAM roles dynamically from the Dashboard EC2 instance. The Dashboard role has `iam:CreateRole` + `iam:PutRolePolicy` — this is a privilege escalation vector. A compromised Dashboard can create arbitrary IAM roles. **Fix**: Pre-create roles during user provisioning via CDK/Terraform, not at runtime. |
| S9 | **Hardcoded account ID** | 🟡 MEDIUM | `aws-clients.ts` line: `const accountId = process.env.AWS_ACCOUNT_ID ?? "061525506239"`. Fallback exposes the real account ID. Use only environment variables. |
| S10 | **No CSRF protection on container API** | 🟡 MEDIUM | POST/DELETE `/api/containers` checks session but has no CSRF token validation. An attacker could craft a malicious page that starts/stops containers if an admin visits it while authenticated. |
| S11 | **ALB HTTP listener on DevEnv** | 🟡 MEDIUM | DevEnv ALB has an HTTP:80 listener (CDK line 186) alongside HTTPS. The comment says "CloudFront uses http-only origin" but this means ALB→container traffic is unencrypted. Combined with the shared password, this is a credential exposure risk. |
| S12 | **ECS Launch Template missing encryption key** | 🟢 LOW | LiteLLM Launch Template comment: "Use default AWS managed key (aws/ebs) to avoid cross-stack KMS grant issues". This means LiteLLM EBS volumes use a different key than the rest of the infrastructure. Inconsistent encryption posture. |

---

## 5. Monthly Cost Estimates (ap-northeast-2, excl. Bedrock)

### Assumptions
- Business hours: 10 hrs/day × 22 days/month = 220 hrs
- ECS hosts run only during business hours (ASG min:0 off-hours)
- Standard tier (2 vCPU / 8 GiB) for most users
- EFS: 10 GB per user average

### 5.1 Cost by User Count

| Resource | 10 Users | 30 Users | 50 Users |
|----------|----------|----------|----------|
| **ECS Hosts** (m7g.4xlarge) | | | |
| ├ Instances needed (8 tasks/host) | 1.5 avg | 4 avg | 7 avg |
| ├ On-Demand (220 hrs) | $200 | $535 | $935 |
| ├ With Spot (~65% savings) | $70 | $187 | $327 |
| **LiteLLM EC2** (t4g.xlarge × 2) | $290 | $290 | $290 |
| **Dashboard EC2** (t4g.xlarge × 1) | $145 | $145 | $145 |
| **RDS PostgreSQL** (db.t4g.medium) | $80 | $80 | $80 |
| **Serverless Valkey** | $8 | $8 | $8 |
| **EFS Storage** (Standard) | $33 | $99 | $165 |
| **EFS Throughput** (Elastic, est.) | $0 (Bursting OK) | $64 | $90 |
| **NAT Gateway** (×2) | $95 | $95 | $95 |
| **ALB** (×3) | $60 | $60 | $60 |
| **VPC Endpoints** (×7, 2 AZs) | $133 | $133 | $133 |
| **CloudFront** (×2) | $5 | $7 | $10 |
| **Route 53 + ACM + ECR** | $5 | $5 | $5 |
| **AgentCore Runtime** | $5 | $8 | $10 |
| **CloudWatch** (Container Insights) | $10 | $25 | $40 |
| **DynamoDB** (usage tracking) | $2 | $5 | $8 |
| | | | |
| **Total (On-Demand ECS)** | **$1,071** | **$1,559** | **$2,074** |
| **Total (Spot ECS)** | **$941** | **$1,211** | **$1,466** |

### 5.2 Cost Optimization Opportunities Summary

| Optimization | Savings | Effort | Risk |
|-------------|---------|--------|------|
| Spot Instances for ECS hosts | $130-608/mo | Low | Low (dev workloads) |
| Remove LiteLLM stack (if migrated to DynamoDB) | $378/mo | Medium | Medium |
| Single NAT Gateway (education) | $45/mo | Low | Low |
| EFS IA lifecycle 14 days | $30-55/mo | Low | None |
| Reduce VPC endpoints to single-AZ | $66/mo | Low | Low |
| Reserved Instances (1yr) for always-on EC2 | ~30% on LiteLLM+Dashboard | Medium | Commitment |
| **Total potential savings** | **$649-1,152/mo** | | |

### 5.3 Production (100 Users) Estimate

| Change | Detail | Monthly |
|--------|--------|---------|
| ECS Hosts | ~13 × m7g.4xlarge (220 hrs) | $1,870 |
| RDS Multi-AZ | db.t4g.medium | $160 |
| Dashboard | min:2 | $290 |
| EFS (1 TB, Elastic) | Storage + throughput | $450 |
| NAT + VPC Endpoints | Same | $228 |
| Everything else | Same | $383 |
| **Total** | | **~$3,381/mo** |
| **With Spot ECS** | | **~$2,200/mo** |

---

## Priority Action Items

| Priority | Action | Section | Est. Effort |
|----------|--------|---------|-------------|
| 🔴 P0 | Generate per-user code-server passwords (Secrets Manager) | S1 | 2 days |
| 🔴 P0 | Implement EFS Access Points for tenant isolation | S2, 3.4 | 3 days |
| 🔴 P0 | Switch to Elastic Throughput for 30+ user deployments | 1.2, 3.2 | 1 hour |
| 🔴 P0 | Add EFS CloudWatch alarms (BurstCreditBalance, PercentIOLimit) | 2.3 | 2 hours |
| 🟡 P1 | Remove runtime IAM role creation; pre-provision during user setup | S8 | 2 days |
| 🟡 P1 | Enforce IMDSv2 on all Launch Templates | S6 | 1 hour |
| 🟡 P1 | Scope Bedrock IAM to specific model ARNs (all IaC variants) | S3 | 1 hour |
| 🟡 P1 | Add WAF to external ALBs | S5 | 4 hours |
| 🟡 P1 | Add ALB 5xx and ECS task failure alarms | 2.3 | 2 hours |
| 🟢 P2 | Evaluate Spot Instances for ECS capacity provider | 1.1 | 2 hours |
| 🟢 P2 | Add DynamoDB Gateway VPC Endpoint | 1.4 | 30 min |
| 🟢 P2 | Reduce EFS lifecycle to 14 days | 3.5 | 10 min |
| 🟢 P2 | Remove hardcoded account ID fallback | S9 | 10 min |
