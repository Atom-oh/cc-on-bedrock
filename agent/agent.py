"""
CC-on-Bedrock AI Assistant Agent
Deployed on Bedrock AgentCore Runtime with Strands framework.
Provides platform analytics, user management, and cost insights.
"""
import os
import json
import boto3
import requests
from datetime import datetime, timedelta
from strands import Agent, tool
from strands.models.bedrock import BedrockModel
from bedrock_agentcore.runtime import BedrockAgentCoreApp

os.environ["BYPASS_TOOL_CONSENT"] = "true"

# ── Configuration ──
REGION = os.environ.get("AWS_REGION", "ap-northeast-2")
LITELLM_URL = os.environ.get("LITELLM_API_URL", "")
LITELLM_KEY = os.environ.get("LITELLM_MASTER_KEY", "")
ECS_CLUSTER = os.environ.get("ECS_CLUSTER_NAME", "cc-on-bedrock-devenv")

# ── AWS Clients ──
ecs_client = boto3.client("ecs", region_name=REGION)
cloudwatch_client = boto3.client("cloudwatch", region_name=REGION)


def litellm_get(path):
    """Call LiteLLM API."""
    if not LITELLM_URL:
        return {"error": "LITELLM_URL not configured"}
    headers = {"Authorization": f"Bearer {LITELLM_KEY}"} if LITELLM_KEY else {}
    try:
        resp = requests.get(f"{LITELLM_URL}{path}", headers=headers, timeout=10)
        return resp.json()
    except Exception as e:
        return {"error": str(e)}


# ── Tools ──

@tool
def get_spend_summary() -> str:
    """Get total spend, token usage, and per-user breakdown from LiteLLM proxy."""
    logs = litellm_get("/spend/logs")
    if isinstance(logs, dict) and "error" in logs:
        return json.dumps(logs)

    keys = litellm_get("/spend/keys")
    key_map = {}
    if isinstance(keys, list):
        for k in keys:
            tail = (k.get("token", ""))[-8:]
            user = (k.get("metadata") or {}).get("user") or k.get("key_alias", "").replace("-key", "")
            if tail:
                key_map[tail] = user

    user_stats = {}
    for log in (logs if isinstance(logs, list) else []):
        tail = (log.get("api_key", ""))[-8:]
        user = key_map.get(tail, tail or "unknown")
        stat = user_stats.setdefault(user, {"requests": 0, "tokens": 0, "input": 0, "output": 0, "spend": 0.0, "models": set()})
        stat["requests"] += 1
        stat["tokens"] += log.get("total_tokens", 0)
        stat["input"] += log.get("prompt_tokens", 0)
        stat["output"] += log.get("completion_tokens", 0)
        stat["spend"] += log.get("spend", 0)
        model = (log.get("model", "")).replace("bedrock/", "").replace("global.anthropic.", "")
        if model:
            stat["models"].add(model)

    total_spend = sum(s["spend"] for s in user_stats.values())
    total_tokens = sum(s["tokens"] for s in user_stats.values())
    total_requests = sum(s["requests"] for s in user_stats.values())

    result = {
        "total_requests": total_requests,
        "total_tokens": total_tokens,
        "total_spend": round(total_spend, 6),
        "active_users": len(user_stats),
        "per_user": {
            u: {**{k: v for k, v in s.items() if k != "models"}, "models": list(s["models"]), "spend": round(s["spend"], 6)}
            for u, s in sorted(user_stats.items(), key=lambda x: x[1]["spend"], reverse=True)
        },
    }
    return json.dumps(result, ensure_ascii=False)


@tool
def get_api_key_budgets() -> str:
    """Get all API key budget status including spend, limits, and utilization."""
    keys = litellm_get("/spend/keys")
    if isinstance(keys, dict) and "error" in keys:
        return json.dumps(keys)

    data = []
    for k in (keys if isinstance(keys, list) else []):
        alias = k.get("key_alias", "")
        if not alias:
            continue
        user = (k.get("metadata") or {}).get("user", alias.replace("-key", ""))
        spend = k.get("spend", 0)
        budget = k.get("max_budget")
        data.append({
            "user": user,
            "spend": round(spend, 6),
            "max_budget": budget,
            "utilization": f"{(spend / budget * 100):.1f}%" if budget else "unlimited",
            "last_active": k.get("last_active"),
        })
    return json.dumps(data, ensure_ascii=False)


@tool
def get_system_health() -> str:
    """Get system health: proxy, database, cache, model count."""
    health = litellm_get("/health/readiness")
    model_info = litellm_get("/model/info")
    model_count = len(model_info.get("data", [])) if isinstance(model_info, dict) else 0
    return json.dumps({
        "status": health.get("status", "unknown"),
        "db": health.get("db", "unknown"),
        "cache": health.get("cache", "unknown"),
        "litellm_version": health.get("litellm_version", "unknown"),
        "model_count": model_count,
    }, ensure_ascii=False)


@tool
def get_container_status() -> str:
    """Get ECS container status with user assignments."""
    try:
        task_arns = ecs_client.list_tasks(cluster=ECS_CLUSTER, maxResults=100).get("taskArns", [])
        if not task_arns:
            return json.dumps({"total": 0, "running": 0, "containers": []})

        tasks = ecs_client.describe_tasks(cluster=ECS_CLUSTER, tasks=task_arns, include=["TAGS"]).get("tasks", [])
        containers = []
        for t in tasks:
            tags = {tag["key"]: tag["value"] for tag in (t.get("tags") or [])}
            td = (t.get("taskDefinitionArn", "").split("/")[-1].split(":")[0])
            ip = None
            for att in (t.get("attachments") or []):
                for d in (att.get("details") or []):
                    if d.get("name") == "privateIPv4Address":
                        ip = d.get("value")
            containers.append({
                "user": tags.get("username", tags.get("subdomain", "")),
                "status": t.get("lastStatus", ""),
                "task_def": td,
                "ip": ip,
                "started": str(t.get("startedAt", "")),
            })

        running = sum(1 for c in containers if c["status"] == "RUNNING")
        return json.dumps({"total": len(containers), "running": running, "containers": containers}, ensure_ascii=False)
    except Exception as e:
        return json.dumps({"error": str(e)})


@tool
def get_container_metrics() -> str:
    """Get CloudWatch Container Insights: CPU, memory, network utilization."""
    try:
        end = datetime.utcnow()
        start = end - timedelta(minutes=10)

        queries = [
            {"Id": "cpu", "MetricStat": {"Metric": {"Namespace": "ECS/ContainerInsights", "MetricName": "CpuUtilized", "Dimensions": [{"Name": "ClusterName", "Value": ECS_CLUSTER}]}, "Period": 300, "Stat": "Average"}},
            {"Id": "cpuR", "MetricStat": {"Metric": {"Namespace": "ECS/ContainerInsights", "MetricName": "CpuReserved", "Dimensions": [{"Name": "ClusterName", "Value": ECS_CLUSTER}]}, "Period": 300, "Stat": "Average"}},
            {"Id": "mem", "MetricStat": {"Metric": {"Namespace": "ECS/ContainerInsights", "MetricName": "MemoryUtilized", "Dimensions": [{"Name": "ClusterName", "Value": ECS_CLUSTER}]}, "Period": 300, "Stat": "Average"}},
            {"Id": "memR", "MetricStat": {"Metric": {"Namespace": "ECS/ContainerInsights", "MetricName": "MemoryReserved", "Dimensions": [{"Name": "ClusterName", "Value": ECS_CLUSTER}]}, "Period": 300, "Stat": "Average"}},
            {"Id": "netRx", "MetricStat": {"Metric": {"Namespace": "ECS/ContainerInsights", "MetricName": "NetworkRxBytes", "Dimensions": [{"Name": "ClusterName", "Value": ECS_CLUSTER}]}, "Period": 300, "Stat": "Sum"}},
            {"Id": "netTx", "MetricStat": {"Metric": {"Namespace": "ECS/ContainerInsights", "MetricName": "NetworkTxBytes", "Dimensions": [{"Name": "ClusterName", "Value": ECS_CLUSTER}]}, "Period": 300, "Stat": "Sum"}},
        ]

        result = cloudwatch_client.get_metric_data(StartTime=start, EndTime=end, MetricDataQueries=queries)
        vals = {}
        for r in result.get("MetricDataResults", []):
            vals[r["Id"]] = r["Values"][0] if r["Values"] else 0

        cpu_used, cpu_res = vals.get("cpu", 0), vals.get("cpuR", 0)
        mem_used, mem_res = vals.get("mem", 0), vals.get("memR", 0)

        return json.dumps({
            "cpu_utilized": round(cpu_used, 1),
            "cpu_reserved": round(cpu_res, 0),
            "cpu_pct": f"{(cpu_used / cpu_res * 100):.1f}%" if cpu_res > 0 else "0%",
            "memory_utilized_mib": round(mem_used, 0),
            "memory_reserved_mib": round(mem_res, 0),
            "memory_pct": f"{(mem_used / mem_res * 100):.1f}%" if mem_res > 0 else "0%",
            "network_rx_bytes": round(vals.get("netRx", 0)),
            "network_tx_bytes": round(vals.get("netTx", 0)),
        }, ensure_ascii=False)
    except Exception as e:
        return json.dumps({"error": str(e)})


# ── System Prompt ──
SYSTEM_PROMPT = """You are CC-on-Bedrock AI Assistant, an expert analyst for a multi-user Claude Code development platform on AWS Bedrock.

You have access to tools that query real-time platform data. ALWAYS use tools to get current data before answering.

Available tools:
- get_spend_summary: User spend/token data with per-user breakdown
- get_api_key_budgets: API key budget utilization and limits
- get_system_health: Proxy, DB, cache, model status
- get_container_status: ECS container assignments and status
- get_container_metrics: CloudWatch CPU/Memory/Network metrics

Guidelines:
- Call relevant tools first, then analyze the data
- Use markdown tables for comparisons
- Highlight warnings (budget >80%, unhealthy services)
- Be specific with numbers and percentages
- Respond in the same language as the user's question
"""

# ── Agent Setup ──
model = BedrockModel(
    model_id="global.anthropic.claude-sonnet-4-6",
    region_name=REGION,
)

agent = Agent(
    model=model,
    tools=[get_spend_summary, get_api_key_budgets, get_system_health, get_container_status, get_container_metrics],
    system_prompt=SYSTEM_PROMPT,
)

# ── AgentCore Runtime ──
app = BedrockAgentCoreApp()


@app.entrypoint
def invoke(payload, context):
    """Handler for agent invocation."""
    messages = payload.get("messages", [])
    prompt = payload.get("prompt", "")

    if messages:
        # Use last user message
        user_msg = next((m["content"] for m in reversed(messages) if m.get("role") == "user"), prompt)
    else:
        user_msg = prompt

    if not user_msg:
        user_msg = "현재 플랫폼 상태를 요약해주세요."

    result = agent(user_msg)
    return {"result": str(result.message)}


if __name__ == "__main__":
    app.run()
