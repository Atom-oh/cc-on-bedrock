# Department MCP via AgentCore Gateway Design

> **Date**: 2026-04-10
> **Status**: Approved
> **Author**: Claude Opus 4.6 + Junseok Oh

## 1. Context

CC-on-Bedrock is a multi-user Claude Code dev platform where each user gets an independent EC2 instance (ARM64). The platform currently has a **single AgentCore Gateway** (`cconbedrock-gateway`) with 3 Lambda targets providing 8 monitoring/analytics tools. All users receive identical MCP configurations.

**Problem**: Departments have different tool needs (e.g., data team needs Athena, frontend team needs Figma), but there is no mechanism to provision department-specific MCP tools. The single shared gateway provides no isolation between departments.

**Goal**: Implement a 2-tier MCP Gateway architecture with Admin-managed, catalog-based department MCP assignment:
- **Tier 1 (Common)**: Company-wide Gateway for shared monitoring/cost tools (existing)
- **Tier 2 (Department)**: Per-department dedicated Gateway with department-specific tools

## 2. Architecture Overview

```
[Admin Dashboard /admin/mcp]
   |
   | PUT /api/admin/mcp/assignments
   v
[cc-dept-mcp-config DDB] ──DDB Streams──> [gateway-manager Lambda]
                                                |
                                  ┌─────────────┼─────────────┐
                                  v             v             v
                          create_gateway  create_target  sync_targets
                          (per-dept GW)   (Lambda MCP)   (synchronize)
                                  |
                                  v
                        [cc-dept-mcp-config DDB] (gatewayUrl stored)
                        [cc-department-budgets DDB] (gatewayUrl copied)

[EC2 Start] → systemd cc-mcp-sync.service → sync-mcp-config.sh
                              |
                              | DDB query (dept Gateway URL)
                              v
                        ~/.claude/mcp_servers.json
                        (Local MCP + Common GW + Dept GW)
                              |
                              v
                        [Claude Code Session]
                              |
                    ┌─────────┼─────────┐
                    v         v         v
              [Local MCP]  [Common GW]  [Dept GW]
              (uvx)        (monitoring)  (dept-specific)
```

## 3. Data Model

### 3.1 New Table: `cc-mcp-catalog`

MCP catalog of available tools that Admin can assign to departments.

| PK | SK | Attributes |
|---|---|---|
| `CATALOG#{id}` | `META` | `name`, `description`, `category`, `tier` (common/department), `lambdaHandler`, `lambdaFile`, `toolSchema` (JSON), `requiredIamActions[]`, `version`, `enabled` |

**Initial seed catalog:**

| ID | Name | Category | Tier |
|---|---|---|---|
| `ecs-mcp` | ECS Container Tools | monitoring | common |
| `cloudwatch-mcp` | CloudWatch Metrics | monitoring | common |
| `dynamodb-mcp` | Usage & Budget | monitoring | common |
| `github-mcp` | GitHub Integration | development | department |
| `jira-mcp` | Jira Project Mgmt | development | department |
| `athena-mcp` | Athena Query | data | department |
| `s3-mcp` | S3 Data Explorer | data | department |
| `slack-mcp` | Slack Integration | communication | department |

### 3.2 New Table: `cc-dept-mcp-config`

Department Gateway state and MCP assignments. DynamoDB Streams enabled.

| PK | SK | Attributes |
|---|---|---|
| `COMMON` | `GATEWAY` | `gatewayId`, `gatewayUrl`, `status`, `lastSyncAt` |
| `COMMON` | `MCP#{catalogId}` | `targetId`, `enabled`, `addedAt` |
| `DEPT#{deptId}` | `GATEWAY` | `gatewayId`, `gatewayUrl`, `gatewayName`, `status`, `targetCount`, `lastSyncAt` |
| `DEPT#{deptId}` | `MCP#{catalogId}` | `targetId`, `enabled`, `addedAt`, `addedBy` |

### 3.3 Existing Table Change: `cc-department-budgets`

Add `gatewayUrl` field for fast EC2 boot-time resolution (avoids second DDB query).

## 4. Gateway Manager Lambda

### 4.1 Function: `cc-on-bedrock-gateway-manager`

**Runtime**: Python 3.12, Timeout: 5 minutes
**Triggers**: DDB Streams on `cc-dept-mcp-config`, Direct invocation from Admin API

### 4.2 Operations

| DDB Event | Action |
|---|---|
| INSERT `DEPT#{dept}/GATEWAY` | `create_gateway(name=cconbedrock-{dept}-gateway, protocolType=MCP, authorizerType=NONE, roleArn=cc-on-bedrock-agentcore-gateway-{dept})` → store gatewayId/URL |
| INSERT `DEPT#{dept}/MCP#{id}` | Lookup toolSchema from `cc-mcp-catalog` → `create_gateway_target` → `synchronize_gateway_targets` → store targetId |
| REMOVE `DEPT#{dept}/MCP#{id}` | `delete_gateway_target(targetId)` → `synchronize_gateway_targets` |
| REMOVE `DEPT#{dept}/GATEWAY` | Delete all targets → `delete_gateway` → cleanup records |
| Admin direct invoke `sync` | Re-read all MCP assignments → reconcile targets with actual gateway state |

### 4.3 Error Handling

- Gateway creation failure → set `status: FAILED` + `errorMessage` in DDB
- Target registration failure → partial failure allowed, mark individual MCP as `FAILED`
- DDB Streams retries (3x) → DLQ → SNS alert to admin

### 4.4 Code Base

Reuses API patterns from existing `agent/lambda/create_targets.py`:
- `bedrock-agentcore-control` client for `create_gateway`, `create_gateway_target`, `synchronize_gateway_targets`
- `credentialProviderType: GATEWAY_IAM_ROLE` for Lambda targets

### 4.5 Shared Lambda Approach

Catalog MCP Lambda functions are shared across departments:
- One Lambda per catalog item: `cc-on-bedrock-mcp-{catalogId}`
- Same Lambda registered as target on multiple department gateways
- Lambda identifies calling department via Gateway context if needed

## 5. Admin Dashboard

### 5.1 New Page: `/admin/mcp`

**Tab 1 -- MCP Catalog**
- List catalog items (name, category, tier, tool count, status)
- Add/edit/disable catalog items
- `common` tier items auto-registered on company gateway

**Tab 2 -- Department MCP Assignments**
- Department dropdown selector (from `cc-department-budgets`)
- Checkbox list of department-tier catalog items
- "Apply" button → DDB update → Lambda auto-sync
- Gateway status indicator: `ACTIVE` / `SYNCING` / `FAILED`

**Tab 3 -- Gateway Status**
- All gateways list (common + per-department)
- Per gateway: name, target count, last sync time, status
- "Re-sync" button for drift recovery

### 5.2 API Routes

| Route | Method | Description |
|---|---|---|
| `/api/admin/mcp/catalog` | GET | List all catalog items |
| `/api/admin/mcp/catalog` | POST | Add catalog item |
| `/api/admin/mcp/catalog` | PUT | Update catalog item |
| `/api/admin/mcp/assignments` | GET | Get department MCP assignments |
| `/api/admin/mcp/assignments` | PUT | Assign/remove MCP from department |
| `/api/admin/mcp/gateways` | GET | List all gateway status |
| `/api/admin/mcp/gateways` | POST | Create department gateway |
| `/api/admin/mcp/gateways` | DELETE | Delete department gateway |
| `/api/admin/mcp/gateways/sync` | POST | Re-sync specific gateway |

### 5.3 Department Manager View Extension

Add "MCP Status" card to existing `/dept` dashboard:
- Read-only list of MCPs assigned to their department
- Per-MCP status and last sync timestamp

## 6. EC2 MCP Config Injection

### 6.1 AMI Script: `/opt/cc-on-bedrock/sync-mcp-config.sh`

```bash
#!/bin/bash
# 1. Get department from EC2 instance tags
INSTANCE_ID=$(curl -s http://169.254.169.254/latest/meta-data/instance-id)
REGION=$(curl -s http://169.254.169.254/latest/meta-data/placement/region)
DEPT=$(aws ec2 describe-tags --filters "Name=resource-id,Values=$INSTANCE_ID" \
  "Name=key,Values=department" --query 'Tags[0].Value' --output text --region $REGION)

# 2. Query DDB for Gateway URLs
DEPT_GW=$(aws dynamodb get-item --table-name cc-dept-mcp-config \
  --key '{"PK":{"S":"DEPT#'$DEPT'"},"SK":{"S":"GATEWAY"}}' \
  --query 'Item.gatewayUrl.S' --output text --region $REGION 2>/dev/null)
COMMON_GW=$(aws dynamodb get-item --table-name cc-dept-mcp-config \
  --key '{"PK":{"S":"COMMON"},"SK":{"S":"GATEWAY"}}' \
  --query 'Item.gatewayUrl.S' --output text --region $REGION 2>/dev/null)

# 3. Generate mcp_servers.json (local MCP + Gateway MCP merged)
cat > /home/coder/.claude/mcp_servers.json << EOF
{
  "awslabs-core-mcp-server": {
    "command": "uvx", "args": ["awslabs.core-mcp-server@latest"],
    "env": {"AWS_REGION": "$REGION"}
  },
  "bedrock-agentcore-mcp-server": {
    "command": "uvx", "args": ["bedrock-agentcore-mcp-server@latest"],
    "env": {"AWS_REGION": "$REGION"}
  }
  ${COMMON_GW:+,"cc-common-gateway": {"url": "$COMMON_GW"}}
  ${DEPT_GW:+,"cc-dept-gateway": {"url": "$DEPT_GW"}}
}
EOF
chown coder:coder /home/coder/.claude/mcp_servers.json
```

### 6.2 Systemd Service: `cc-mcp-sync.service`

```ini
[Unit]
Description=CC-on-Bedrock MCP Config Sync
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/opt/cc-on-bedrock/sync-mcp-config.sh
User=root
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
```

Runs on every EC2 Start (including Stop → Start). The EBS root volume preserves the file between stops, but the service always overwrites with the latest DDB state on boot.

## 7. Security Model

### 7.1 Three-Layer IAM Isolation

**Layer 1 -- Gateway IAM Role (per-department)**
- Role: `cc-on-bedrock-agentcore-gateway-{deptId}`
- Can only invoke Lambda functions assigned to that department's gateway
- Created dynamically by Gateway Manager Lambda when department gateway is created

**Layer 2 -- MCP Lambda Execution Role (per-catalog-item)**
- Role: `cc-on-bedrock-mcp-lambda-{catalogId}`
- Scoped to the specific AWS resources that MCP needs (e.g., Athena MCP → Athena + S3 results only)

**Layer 3 -- Per-user Role Extension**
- Existing `cc-on-bedrock-task-{subdomain}` role gets inline policy:

```json
{
  "Statement": [{
    "Effect": "Allow",
    "Action": "bedrock-agentcore:InvokeGateway",
    "Resource": [
      "arn:aws:bedrock-agentcore:ap-northeast-2:*:gateway/{common-gw-id}",
      "arn:aws:bedrock-agentcore:ap-northeast-2:*:gateway/{dept-gw-id}"
    ]
  }]
}
```

- Added during `startInstance()` in `ec2-clients.ts` using department's gateway ID from DDB

### 7.2 Permission Boundary Change

Add to `cc-on-bedrock-task-boundary`:
```json
{
  "Effect": "Allow",
  "Action": "bedrock-agentcore:InvokeGateway",
  "Resource": "arn:aws:bedrock-agentcore:ap-northeast-2:*:gateway/*"
}
```

### 7.3 Cross-Department Access Prevention

- User in "engineering" dept → can access common GW + engineering GW only
- Attempting to access "design" GW → IAM Deny (resource ARN not in inline policy)
- Gateway Manager Lambda ensures per-user inline policy only includes authorized gateway ARNs

## 8. CDK Infrastructure Changes

| Stack | Changes |
|---|---|
| `03-usage-tracking-stack.ts` | Add `cc-mcp-catalog` DDB table, `cc-dept-mcp-config` DDB table (Streams enabled), `cc-on-bedrock-gateway-manager` Lambda + DDB Streams trigger + DLQ (SNS) |
| `02-security-stack.ts` | Add `bedrock-agentcore:InvokeGateway` to Permission Boundary |
| `05-dashboard-stack.ts` | Add DDB permissions for new tables + Lambda Invoke for gateway-manager |
| `07-ec2-devenv-stack.ts` | AMI includes `sync-mcp-config.sh` + systemd service |

## 9. Verification Plan

### 9.1 Unit Tests
- Gateway Manager Lambda: mock AgentCore API calls, verify correct gateway/target lifecycle
- Admin API routes: mock DDB, verify CRUD operations
- MCP config generation script: verify JSON output for various department configs

### 9.2 Integration Tests
- Create test department "test-dept" via Admin API
- Assign `github-mcp` from catalog → verify Gateway created + target registered
- Start EC2 for test-dept user → verify `mcp_servers.json` contains dept gateway
- Stop/Start EC2 → verify config persists and re-syncs
- Remove MCP assignment → verify target removed from gateway
- Delete department gateway → verify cleanup

### 9.3 Security Tests
- Verify user in dept A cannot invoke dept B's gateway (IAM deny)
- Verify all users can invoke common gateway
- Verify Permission Boundary correctly caps gateway access

### 9.4 Dashboard Tests
- Admin can browse catalog, assign MCPs to departments
- Dept-manager can view (read-only) assigned MCPs
- Gateway status updates in real-time after sync

## 10. Implementation Priority

1. DDB tables (`cc-mcp-catalog`, `cc-dept-mcp-config`) via CDK
2. MCP catalog seeding script
3. Gateway Manager Lambda + DDB Streams trigger
4. Permission Boundary update
5. Admin dashboard MCP management page (`/admin/mcp`)
6. Admin API routes (`/api/admin/mcp/*`)
7. EC2 boot-time sync script + systemd service (AMI update)
8. Per-user IAM inline policy update in `ec2-clients.ts`
9. Department manager view extension
10. End-to-end testing with test department

## 11. Open Questions for Implementation

1. **Claude Code `mcp_servers.json` Gateway entry format**: The exact JSON schema for referencing an AgentCore Gateway (Streamable HTTP + SigV4) in `mcp_servers.json` needs validation against Claude Code's MCP client. The `bedrock-agentcore-mcp-server` package may already handle this, or a custom entry may be needed.
2. **Gateway quota**: AgentCore Gateway per-account limits should be confirmed before scaling to many departments. If quota is low, a single-gateway-with-tagging fallback (Approach A's pattern) may be needed.
3. **AMI build process**: The AMI currently does not include department-aware scripts. The AMI build pipeline needs to include `sync-mcp-config.sh` and the systemd service.

## 12. Key Files to Modify

| File | Change |
|---|---|
| `cdk/lib/03-usage-tracking-stack.ts` | New DDB tables + Gateway Manager Lambda |
| `cdk/lib/02-security-stack.ts` | Permission Boundary update |
| `cdk/lib/05-dashboard-stack.ts` | Dashboard role permissions |
| `cdk/lib/lambda/gateway-manager.py` | New: Gateway lifecycle Lambda |
| `agent/lambda/create_targets.py` | Reference for API patterns |
| `shared/nextjs-app/src/app/admin/mcp/page.tsx` | New: Admin MCP management page |
| `shared/nextjs-app/src/app/api/admin/mcp/catalog/route.ts` | New: Catalog API |
| `shared/nextjs-app/src/app/api/admin/mcp/assignments/route.ts` | New: Assignment API |
| `shared/nextjs-app/src/app/api/admin/mcp/gateways/route.ts` | New: Gateway management API |
| `shared/nextjs-app/src/app/dept/dept-dashboard.tsx` | Extend: MCP status card |
| `shared/nextjs-app/src/app/api/dept/route.ts` | Extend: dept MCP info |
| `shared/nextjs-app/src/lib/ec2-clients.ts` | Extend: per-user IAM inline policy for gateway |
| `shared/nextjs-app/src/middleware.ts` | Extend: `/admin/mcp` route protection |
| `docker/devenv/scripts/sync-mcp-config.sh` | New: EC2 boot MCP sync script |
| `docker/devenv/systemd/cc-mcp-sync.service` | New: systemd service |
