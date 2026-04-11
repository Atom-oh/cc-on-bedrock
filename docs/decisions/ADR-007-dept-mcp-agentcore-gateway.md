# ADR-007: Department MCP via AgentCore Gateway

## Status
Accepted

## Context

CC-on-Bedrock operates a single shared AgentCore Gateway (`cconbedrock-gateway`) with 3 Lambda targets providing 8 monitoring/analytics tools. All users receive identical MCP configurations regardless of department. As the platform scales to 4,000+ users across multiple departments, two problems emerge:

1. **No tool isolation**: All users access the same MCP tools. There is no mechanism to provision department-specific tools (e.g., data team needs Athena, frontend team needs Figma integration).
2. **No admin management**: Adding or removing MCP tools requires manual script execution (`create_targets.py`), with no dashboard interface for administrators.

Departments are already modeled in the system (Cognito `custom:department`, DynamoDB `cc-department-budgets`), but MCP tool provisioning has no department awareness.

## Options Considered

### Option 1: DynamoDB + Script-based (Minimal Change)
- Extend `create_targets.py` into a parameterized script for per-department gateway creation
- MCP catalog as static JSON embedded in Next.js code
- Admin triggers sync manually via API
- **Pros**: Minimal CDK changes, follows existing patterns
- **Cons**: Static catalog requires code deploy to update, no automated sync, manual drift correction

### Option 2: Lambda-Managed Gateway Lifecycle (Event-Driven)
- Dedicated `gateway-manager` Lambda manages full gateway lifecycle
- MCP catalog stored in DynamoDB (runtime-updateable)
- DDB Streams triggers Lambda on admin changes → automatic gateway sync
- Systemd service on EC2 re-syncs `mcp_servers.json` on every boot
- **Pros**: Event-driven automation, runtime catalog updates, DDB-consistent architecture, reconciliation loop
- **Cons**: Additional Lambda + DDB Streams cost, two new DDB tables

### Option 3: CDK Custom Resource + SSM Parameter Store
- CDK Custom Resources for declarative gateway management
- Pre-assembled `mcp_servers.json` stored in SSM for fastest EC2 boot
- Three-layer config: DDB (admin UI) → Lambda → SSM (EC2 reads)
- **Pros**: Fastest boot time (~100ms SSM vs ~500ms DDB), SSM versioning audit trail
- **Cons**: Dual storage (DDB + SSM) sync complexity, highest implementation cost, negligible boot time gain vs total EC2 boot time (30-60s)

## Decision

**Option 2: Lambda-Managed Gateway Lifecycle (Event-Driven)**

### Reasoning

1. **Right automation level**: Option 1 is too manual; Option 3 adds SSM as a sync-prone second storage layer. Option 2's event-driven Lambda is the sweet spot.
2. **Consistent with existing architecture**: The project already uses DynamoDB extensively for configuration (routing table, user instances, department budgets, approval requests). Two more tables follow established patterns.
3. **Runtime-updateable catalog**: Unlike Option 1's static catalog, DDB-based catalog lets admins add new MCP types without code deployments.
4. **Acceptable boot latency**: DDB queries add ~200-500ms vs SSM's ~100ms. Against a 30-60 second EC2 boot, this difference is negligible.
5. **Upgrade path**: Can add SSM caching (Option 3's strength) later as optimization without architectural changes.

### Architecture: 2-Tier Gateway Model

- **Tier 1 (Common)**: Single company-wide Gateway for shared monitoring/cost tools (existing `cconbedrock-gateway`)
- **Tier 2 (Department)**: Per-department dedicated Gateway with catalog-assigned tools, strong IAM isolation

### Key Components

| Component | Purpose |
|---|---|
| `cc-mcp-catalog` DDB table | Available MCP tools (catalog with tier: common/department) |
| `cc-dept-mcp-config` DDB table (Streams) | Per-department gateway state + MCP assignments |
| `cc-on-bedrock-gateway-manager` Lambda | Creates/deletes gateways, adds/removes targets, syncs |
| `/admin/mcp` dashboard page | 3-tab admin UI: catalog, assignments, gateway status |
| `sync-mcp-config.sh` + systemd service | EC2 boot-time MCP config injection |
| Per-user IAM inline policy | `InvokeGateway` scoped to common + department gateway ARNs |

### Security: 3-Layer IAM Isolation

1. **Gateway Role** (`cc-on-bedrock-agentcore-gateway-{dept}`): Can only invoke that department's Lambda functions
2. **Lambda Role** (`cc-on-bedrock-mcp-lambda-{catalogId}`): Scoped to specific AWS resources per MCP type
3. **User Role** (`cc-on-bedrock-task-{subdomain}`): `InvokeGateway` limited to common + own department gateway ARNs

## Consequences

### Positive
- Departments get isolated MCP tool environments without affecting other departments
- Admin can manage MCP assignments through dashboard UI without code deployment
- Event-driven sync eliminates manual gateway management
- EC2 Stop/Start preserves and re-syncs MCP config automatically
- Existing local MCP servers (awslabs-core, bedrock-agentcore) continue working alongside gateway MCPs
- 3-layer IAM isolation prevents cross-department tool access

### Negative
- Two new DynamoDB tables increase table count (now 8 application tables)
- Gateway Manager Lambda adds operational surface (DDB Streams retries, DLQ monitoring)
- Gateway creation takes 10-30 seconds (admin needs async feedback in UI)
- AMI must be updated to include `sync-mcp-config.sh` and systemd service
- Per-department IAM roles are created dynamically by Lambda (not CDK-managed)
- MCP Lambda functions for department-tier catalog items must be developed separately

## References
- Design spec: `docs/superpowers/specs/2026-04-10-dept-mcp-agentcore-gateway-design.md`
- Existing gateway provisioning: `agent/lambda/create_targets.py`
- Department model: ADR-004 (EC2-per-user), `cdk/lib/02-security-stack.ts` (Cognito groups)
- AgentCore integration: `agent/agent.py`, `agent/streamable_http_sigv4.py`
- Budget management: `cdk/lib/03-usage-tracking-stack.ts` (cc-department-budgets)
