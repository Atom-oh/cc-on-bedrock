"""
CC-on-Bedrock DynamoDB MCP Lambda - usage tracking, budget, system health
사용량 조회, 예산 현황, 시스템 상태
"""
import json
import os
import boto3
from datetime import datetime, timedelta
from decimal import Decimal
from collections import defaultdict

TABLE_NAME = os.environ.get("USAGE_TABLE_NAME", "cc-on-bedrock-usage")
REGION = os.environ.get("AWS_REGION", os.environ.get("AWS_DEFAULT_REGION", "ap-northeast-2"))


def lambda_handler(event, context):
    params = event if isinstance(event, dict) else json.loads(event)
    t = params.get("tool_name", "")
    args = params.get("arguments", params)

    if not t:
        t = "get_spend_summary"

    try:
        if t == "get_spend_summary":
            return handle_spend_summary(args)
        elif t == "get_budget_status":
            return handle_budget_status(args)
        elif t == "get_system_health":
            return handle_system_health(args)
        elif t == "get_user_usage":
            return handle_user_usage(args)
        elif t == "get_department_usage":
            return handle_department_usage(args)
        return {"statusCode": 400, "body": json.dumps({"error": f"Unknown tool: {t}"})}
    except Exception as e:
        return {"statusCode": 500, "body": json.dumps({"error": str(e)})}


class DecimalEncoder(json.JSONEncoder):
    def default(self, o):
        if isinstance(o, Decimal):
            return float(o)
        return super().default(o)


def scan_usage(start_date=None, end_date=None, user_id=None):
    """Scan DynamoDB for usage records."""
    ddb = boto3.resource("dynamodb", region_name=REGION)
    table = ddb.Table(TABLE_NAME)

    filter_parts = ["begins_with(PK, :userPrefix)"]
    expr_values = {":userPrefix": "USER#"}

    if start_date:
        filter_parts.append("SK >= :startDate")
        expr_values[":startDate"] = start_date
    if end_date:
        filter_parts.append("SK <= :endDate")
        expr_values[":endDate"] = f"{end_date}~"
    if user_id:
        filter_parts.append("PK = :userId")
        expr_values[":userId"] = f"USER#{user_id}"

    items = []
    last_key = None
    while True:
        params = {
            "FilterExpression": " AND ".join(filter_parts),
            "ExpressionAttributeValues": expr_values,
        }
        if last_key:
            params["ExclusiveStartKey"] = last_key
        resp = table.scan(**params)
        items.extend(resp.get("Items", []))
        last_key = resp.get("LastEvaluatedKey")
        if not last_key:
            break
    return items


def handle_spend_summary(args):
    days = int(args.get("days", 7))
    end = datetime.utcnow().strftime("%Y-%m-%d")
    start = (datetime.utcnow() - timedelta(days=days)).strftime("%Y-%m-%d")

    items = scan_usage(start_date=start, end_date=end)

    user_stats = defaultdict(lambda: {"requests": 0, "tokens": 0, "input": 0, "output": 0, "cost": 0.0, "models": set()})
    for item in items:
        uid = item["PK"].replace("USER#", "")
        s = user_stats[uid]
        s["requests"] += int(item.get("requests", 0))
        s["tokens"] += int(item.get("totalTokens", 0))
        s["input"] += int(item.get("inputTokens", 0))
        s["output"] += int(item.get("outputTokens", 0))
        s["cost"] += float(item.get("estimatedCost", 0))
        model = item.get("model", "unknown")
        if model:
            s["models"].add(model)

    total_cost = sum(s["cost"] for s in user_stats.values())
    total_tokens = sum(s["tokens"] for s in user_stats.values())
    total_requests = sum(s["requests"] for s in user_stats.values())

    per_user = {}
    for uid, s in sorted(user_stats.items(), key=lambda x: x[1]["cost"], reverse=True):
        per_user[uid] = {
            "requests": s["requests"],
            "tokens": s["tokens"],
            "input_tokens": s["input"],
            "output_tokens": s["output"],
            "cost": round(s["cost"], 4),
            "models": list(s["models"]),
        }

    return ok({
        "period": f"{start} ~ {end}",
        "total_requests": total_requests,
        "total_tokens": total_tokens,
        "total_cost": round(total_cost, 4),
        "active_users": len(user_stats),
        "daily_avg_cost": round(total_cost / max(days, 1), 4),
        "per_user": per_user,
    })


def handle_budget_status(args):
    daily_budget = float(args.get("daily_budget", 50))
    today = datetime.utcnow().strftime("%Y-%m-%d")
    items = scan_usage(start_date=today, end_date=today)

    user_spend = defaultdict(float)
    for item in items:
        uid = item["PK"].replace("USER#", "")
        user_spend[uid] += float(item.get("estimatedCost", 0))

    users = []
    for uid, spend in sorted(user_spend.items(), key=lambda x: x[1], reverse=True):
        pct = (spend / daily_budget * 100) if daily_budget > 0 else 0
        users.append({
            "user": uid,
            "today_spend": round(spend, 4),
            "budget": daily_budget,
            "utilization_pct": round(pct, 1),
            "status": "BLOCKED" if pct >= 100 else ("WARNING" if pct >= 80 else "OK"),
        })

    return ok({
        "date": today,
        "daily_budget": daily_budget,
        "total_today_spend": round(sum(user_spend.values()), 4),
        "users_over_80pct": sum(1 for u in users if u["utilization_pct"] >= 80),
        "users_blocked": sum(1 for u in users if u["status"] == "BLOCKED"),
        "users": users,
    })


def handle_system_health(args):
    # Check DynamoDB table status
    ddb = boto3.client("dynamodb", region_name=REGION)
    try:
        desc = ddb.describe_table(TableName=TABLE_NAME)
        table_status = desc["Table"]["TableStatus"]
        item_count = desc["Table"]["ItemCount"]
        table_size = desc["Table"]["TableSizeBytes"]
    except Exception:
        table_status = "ERROR"
        item_count = 0
        table_size = 0

    # Check ECS cluster
    ecs = boto3.client("ecs", region_name=REGION)
    try:
        tasks = ecs.list_tasks(cluster="cc-on-bedrock-devenv").get("taskArns", [])
        running_tasks = len(tasks)
    except Exception:
        running_tasks = -1

    return ok({
        "architecture": "Bedrock Direct (no proxy)",
        "usage_db": {"status": table_status, "items": item_count, "sizeBytes": table_size},
        "ecs": {"running_tasks": running_tasks, "cluster": "cc-on-bedrock-devenv"},
        "region": REGION,
        "status": "healthy" if table_status == "ACTIVE" and running_tasks >= 0 else "degraded",
    })


def handle_user_usage(args):
    user_id = args.get("user_id", "")
    days = int(args.get("days", 7))
    if not user_id:
        return {"statusCode": 400, "body": json.dumps({"error": "user_id required"})}

    end = datetime.utcnow().strftime("%Y-%m-%d")
    start = (datetime.utcnow() - timedelta(days=days)).strftime("%Y-%m-%d")
    items = scan_usage(start_date=start, end_date=end, user_id=user_id)

    daily = defaultdict(lambda: {"requests": 0, "tokens": 0, "cost": 0.0})
    models = defaultdict(lambda: {"requests": 0, "tokens": 0, "cost": 0.0})

    for item in items:
        date = item.get("date", "")
        model = item.get("model", "unknown")
        d = daily[date]
        d["requests"] += int(item.get("requests", 0))
        d["tokens"] += int(item.get("totalTokens", 0))
        d["cost"] += float(item.get("estimatedCost", 0))
        m = models[model]
        m["requests"] += int(item.get("requests", 0))
        m["tokens"] += int(item.get("totalTokens", 0))
        m["cost"] += float(item.get("estimatedCost", 0))

    return ok({
        "user": user_id,
        "period": f"{start} ~ {end}",
        "daily": {k: {**v, "cost": round(v["cost"], 4)} for k, v in sorted(daily.items())},
        "models": {k: {**v, "cost": round(v["cost"], 4)} for k, v in sorted(models.items(), key=lambda x: x[1]["cost"], reverse=True)},
    })


def handle_department_usage(args):
    days = int(args.get("days", 7))
    end = datetime.utcnow().strftime("%Y-%m-%d")
    start = (datetime.utcnow() - timedelta(days=days)).strftime("%Y-%m-%d")
    items = scan_usage(start_date=start, end_date=end)

    dept_stats = defaultdict(lambda: {"requests": 0, "tokens": 0, "cost": 0.0, "users": set()})
    for item in items:
        dept = item.get("department", "default")
        uid = item["PK"].replace("USER#", "")
        d = dept_stats[dept]
        d["requests"] += int(item.get("requests", 0))
        d["tokens"] += int(item.get("totalTokens", 0))
        d["cost"] += float(item.get("estimatedCost", 0))
        d["users"].add(uid)

    result = {}
    for dept, d in sorted(dept_stats.items(), key=lambda x: x[1]["cost"], reverse=True):
        result[dept] = {
            "requests": d["requests"],
            "tokens": d["tokens"],
            "cost": round(d["cost"], 4),
            "user_count": len(d["users"]),
        }

    return ok({"period": f"{start} ~ {end}", "departments": result})


def ok(data):
    return {"statusCode": 200, "body": json.dumps(data, cls=DecimalEncoder, default=str, ensure_ascii=False)}
