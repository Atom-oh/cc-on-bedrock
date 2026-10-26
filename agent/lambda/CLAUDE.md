# Auxiliary AgentCore tool targets

Inherit `agent/CLAUDE.md` and the repository baseline. These existing eight
Gateway tools are outside root Terraform's governed `lambda/` source path.

## Contract and ownership

- Handlers select `tool_name`, use `arguments` or the event, and return
  `statusCode` plus a JSON-string body (`200`, `400` unknown tool, `500` error).
- `cc_ecs_mcp.py`: container status and EFS metadata; cluster/file-system inputs.
- `cc_cloudwatch_mcp.py`: ECS ContainerInsights metrics and time window.
- `cc_dynamodb_mcp.py`: spend, daily-budget comparison, health, user and department
  usage; `USAGE_TABLE_NAME` and region environment inputs.
- `create_targets.py` creates/updates Python 3.12 ARM64 tool Lambdas, Gateway
  and targets using supplied Lambda/Gateway role ARNs.

## Change constraints

`create_targets.py` mutates AWS at top level, including on import. Never run or
import it as validation. It currently requests `authorizerType = NONE`; do not
describe that configuration as IAM authentication or extend this parallel
deployment path before Terraform migration.

ECS/EFS assumptions cannot establish current per-user EC2/EBS health.
`get_budget_status` compares one caller-supplied daily threshold; it is not
authoritative multi-period governance. User schema says subdomain, but current
usage `USER#` keys use lowercase email; pass the actual stored suffix.
Tools perform account-level reads without their own user/department authorization.
Gateway/runtime access controls are a separate contract.

## Validation

From the repository root:

```bash
python3 -m py_compile agent/lambda/*.py
```

Syntax-only; this writes bytecode without importing scripts or contacting AWS.
There is no dedicated behavior suite in this directory.
