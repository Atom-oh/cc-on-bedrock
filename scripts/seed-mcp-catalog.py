"""
Seed MCP Catalog into DynamoDB cc-mcp-catalog table.
Usage: python3 scripts/seed-mcp-catalog.py [--region ap-northeast-2]

Seeds the initial catalog of available MCP tools.
common tier: always on the company-wide gateway
department tier: admin assigns to specific departments
"""
import boto3
import json
import argparse
import time

CATALOG_ITEMS = [
    {
        "id": "ecs-mcp",
        "name": "ECS Container Tools",
        "description": "Container status monitoring and EFS filesystem info",
        "category": "monitoring",
        "tier": "common",
        "lambdaHandler": "cc_ecs_mcp.lambda_handler",
        "lambdaFile": "cc_ecs_mcp.py",
        "toolSchema": json.dumps([
            {
                "name": "get_container_status",
                "description": "Get all ECS container status with user assignments, OS/tier distribution",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "cluster": {"type": "string", "description": "ECS cluster name (default: cc-on-bedrock-devenv)"}
                    },
                },
            },
            {
                "name": "get_efs_info",
                "description": "Get EFS file system info: size, mount targets, encryption",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "fileSystemId": {"type": "string", "description": "EFS file system ID"}
                    },
                },
            },
        ]),
        "version": "1.0.0",
        "enabled": True,
    },
    {
        "id": "cloudwatch-mcp",
        "name": "CloudWatch Metrics",
        "description": "Container Insights CPU, Memory, Network metrics",
        "category": "monitoring",
        "tier": "common",
        "lambdaHandler": "cc_cloudwatch_mcp.lambda_handler",
        "lambdaFile": "cc_cloudwatch_mcp.py",
        "toolSchema": json.dumps([
            {
                "name": "get_container_metrics",
                "description": "Get ECS cluster CPU, Memory, Network metrics from Container Insights",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "cluster": {"type": "string", "description": "ECS cluster name"},
                        "minutes": {"type": "integer", "description": "Lookback period in minutes (default: 10)"},
                    },
                },
            },
        ]),
        "version": "1.0.0",
        "enabled": True,
    },
    {
        "id": "dynamodb-mcp",
        "name": "Usage & Budget Analytics",
        "description": "Usage tracking, budget status, system health, department analytics",
        "category": "monitoring",
        "tier": "common",
        "lambdaHandler": "cc_dynamodb_mcp.lambda_handler",
        "lambdaFile": "cc_dynamodb_mcp.py",
        "toolSchema": json.dumps([
            {
                "name": "get_spend_summary",
                "description": "Get total spend, tokens, per-user breakdown for N days",
                "inputSchema": {"type": "object", "properties": {"days": {"type": "integer", "description": "Number of days (default: 7)"}}},
            },
            {
                "name": "get_budget_status",
                "description": "Get today's budget utilization per user",
                "inputSchema": {"type": "object", "properties": {"daily_budget": {"type": "number", "description": "Daily budget in USD (default: 50)"}}},
            },
            {
                "name": "get_system_health",
                "description": "Get platform health: DynamoDB, ECS status",
                "inputSchema": {"type": "object", "properties": {}},
            },
            {
                "name": "get_user_usage",
                "description": "Get specific user's daily usage and model breakdown",
                "inputSchema": {"type": "object", "properties": {"user_id": {"type": "string", "description": "User ID"}, "days": {"type": "integer"}}, "required": ["user_id"]},
            },
            {
                "name": "get_department_usage",
                "description": "Get department-level usage comparison",
                "inputSchema": {"type": "object", "properties": {"days": {"type": "integer", "description": "Number of days (default: 7)"}}},
            },
        ]),
        "version": "1.0.0",
        "enabled": True,
    },
    {
        "id": "github-mcp",
        "name": "GitHub Integration",
        "description": "Repository management, PR review, issue tracking",
        "category": "development",
        "tier": "department",
        "lambdaHandler": "cc_github_mcp.lambda_handler",
        "lambdaFile": "cc_github_mcp.py",
        "toolSchema": json.dumps([
            {"name": "list_pull_requests", "description": "List PRs for a repository", "inputSchema": {"type": "object", "properties": {"repo": {"type": "string"}, "state": {"type": "string"}}, "required": ["repo"]}},
            {"name": "get_repo_stats", "description": "Get repository statistics and contributor info", "inputSchema": {"type": "object", "properties": {"repo": {"type": "string"}}, "required": ["repo"]}},
        ]),
        "version": "1.0.0",
        "enabled": True,
    },
    {
        "id": "jira-mcp",
        "name": "Jira Project Management",
        "description": "Issue tracking, sprint management, project boards",
        "category": "development",
        "tier": "department",
        "lambdaHandler": "cc_jira_mcp.lambda_handler",
        "lambdaFile": "cc_jira_mcp.py",
        "toolSchema": json.dumps([
            {"name": "search_issues", "description": "Search Jira issues with JQL", "inputSchema": {"type": "object", "properties": {"jql": {"type": "string"}, "max_results": {"type": "integer"}}, "required": ["jql"]}},
            {"name": "get_sprint_status", "description": "Get current sprint status and burndown", "inputSchema": {"type": "object", "properties": {"board_id": {"type": "string"}}, "required": ["board_id"]}},
        ]),
        "version": "1.0.0",
        "enabled": True,
    },
    {
        "id": "athena-mcp",
        "name": "Athena Query",
        "description": "Run SQL queries against S3 data lakes via Athena",
        "category": "data",
        "tier": "department",
        "lambdaHandler": "cc_athena_mcp.lambda_handler",
        "lambdaFile": "cc_athena_mcp.py",
        "toolSchema": json.dumps([
            {"name": "run_query", "description": "Execute an Athena SQL query", "inputSchema": {"type": "object", "properties": {"query": {"type": "string"}, "database": {"type": "string"}, "output_location": {"type": "string"}}, "required": ["query"]}},
            {"name": "list_tables", "description": "List tables in an Athena database", "inputSchema": {"type": "object", "properties": {"database": {"type": "string"}}, "required": ["database"]}},
        ]),
        "version": "1.0.0",
        "enabled": True,
    },
    {
        "id": "s3-mcp",
        "name": "S3 Data Explorer",
        "description": "Browse and query S3 buckets and objects",
        "category": "data",
        "tier": "department",
        "lambdaHandler": "cc_s3_mcp.lambda_handler",
        "lambdaFile": "cc_s3_mcp.py",
        "toolSchema": json.dumps([
            {"name": "list_objects", "description": "List objects in an S3 bucket with prefix", "inputSchema": {"type": "object", "properties": {"bucket": {"type": "string"}, "prefix": {"type": "string"}}, "required": ["bucket"]}},
            {"name": "get_object_metadata", "description": "Get S3 object metadata", "inputSchema": {"type": "object", "properties": {"bucket": {"type": "string"}, "key": {"type": "string"}}, "required": ["bucket", "key"]}},
        ]),
        "version": "1.0.0",
        "enabled": True,
    },
    {
        "id": "slack-mcp",
        "name": "Slack Integration",
        "description": "Channel management, message search, notifications",
        "category": "communication",
        "tier": "department",
        "lambdaHandler": "cc_slack_mcp.lambda_handler",
        "lambdaFile": "cc_slack_mcp.py",
        "toolSchema": json.dumps([
            {"name": "search_messages", "description": "Search Slack messages", "inputSchema": {"type": "object", "properties": {"query": {"type": "string"}, "channel": {"type": "string"}}, "required": ["query"]}},
            {"name": "list_channels", "description": "List Slack channels", "inputSchema": {"type": "object", "properties": {"limit": {"type": "integer"}}}},
        ]),
        "version": "1.0.0",
        "enabled": True,
    },
]


def main():
    parser = argparse.ArgumentParser(description="Seed MCP catalog into DynamoDB")
    parser.add_argument("--region", default="ap-northeast-2")
    parser.add_argument("--table", default="cc-mcp-catalog")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    ddb = boto3.resource("dynamodb", region_name=args.region)
    table = ddb.Table(args.table)

    print(f"Seeding {len(CATALOG_ITEMS)} MCP catalog items into {args.table}")

    for item in CATALOG_ITEMS:
        pk = f"CATALOG#{item['id']}"
        sk = "META"

        if args.dry_run:
            print(f"  [DRY-RUN] {pk} — {item['name']} ({item['tier']})")
            continue

        table.put_item(Item={
            "PK": pk,
            "SK": sk,
            "catalogId": item["id"],
            "name": item["name"],
            "description": item["description"],
            "category": item["category"],
            "tier": item["tier"],
            "lambdaHandler": item["lambdaHandler"],
            "lambdaFile": item["lambdaFile"],
            "toolSchema": item["toolSchema"],
            "version": item["version"],
            "enabled": item["enabled"],
            "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        })
        print(f"  SEEDED: {item['id']} — {item['name']} ({item['tier']})")

    # Also seed the COMMON gateway record if not exists
    if not args.dry_run:
        config_table = ddb.Table("cc-dept-mcp-config")
        try:
            existing = config_table.get_item(Key={"PK": "COMMON", "SK": "GATEWAY"}).get("Item")
            if not existing:
                config_table.put_item(Item={
                    "PK": "COMMON",
                    "SK": "GATEWAY",
                    "gatewayId": "",
                    "gatewayUrl": "",
                    "status": "PENDING",
                    "lastSyncAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                })
                print("  SEEDED: COMMON/GATEWAY record (needs manual gateway ID/URL)")
        except Exception as e:
            print(f"  Note: Could not seed COMMON gateway record: {e}")

    print("Done!")


if __name__ == "__main__":
    main()
