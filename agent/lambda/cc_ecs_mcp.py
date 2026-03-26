"""
CC-on-Bedrock ECS MCP Lambda - container status, EFS info
컨테이너 상태 조회, EFS 정보 제공
"""
import json
import os
import boto3

CLUSTER = os.environ.get("ECS_CLUSTER_NAME", "cc-on-bedrock-devenv")
EFS_ID = os.environ.get("EFS_FILE_SYSTEM_ID", "")


def lambda_handler(event, context):
    params = event if isinstance(event, dict) else json.loads(event)
    t = params.get("tool_name", "")
    args = params.get("arguments", params)

    if not t:
        t = "get_container_status"

    try:
        if t == "get_container_status":
            return handle_container_status(args)
        elif t == "get_efs_info":
            return handle_efs_info(args)
        return {"statusCode": 400, "body": json.dumps({"error": f"Unknown tool: {t}"})}
    except Exception as e:
        return {"statusCode": 500, "body": json.dumps({"error": str(e)})}


def handle_container_status(args):
    ecs = boto3.client("ecs")
    cluster = args.get("cluster", CLUSTER)

    task_arns = ecs.list_tasks(cluster=cluster, maxResults=100).get("taskArns", [])
    if not task_arns:
        return ok({"total": 0, "running": 0, "containers": [], "osDist": {}, "tierDist": {}})

    tasks = ecs.describe_tasks(cluster=cluster, tasks=task_arns, include=["TAGS"]).get("tasks", [])

    containers = []
    os_dist = {}
    tier_dist = {}

    for t in tasks:
        tags = {tag["key"]: tag["value"] for tag in (t.get("tags") or [])}
        td_name = t.get("taskDefinitionArn", "").split("/")[-1].split(":")[0]

        # Extract OS and tier from task definition name
        container_os = "al2023" if "al2023" in td_name else "ubuntu"
        tier = "power" if "power" in td_name else ("light" if "light" in td_name else "standard")

        # CPU/Memory from tier
        cpu_map = {"light": 1024, "standard": 2048, "power": 4096}
        mem_map = {"light": 4096, "standard": 8192, "power": 12288}

        ip = None
        for att in (t.get("attachments") or []):
            for d in (att.get("details") or []):
                if d.get("name") == "privateIPv4Address":
                    ip = d.get("value")

        status = t.get("lastStatus", "UNKNOWN")
        if status == "RUNNING":
            os_dist[container_os] = os_dist.get(container_os, 0) + 1
            tier_dist[tier] = tier_dist.get(tier, 0) + 1

        containers.append({
            "user": tags.get("username", tags.get("subdomain", "")),
            "subdomain": tags.get("subdomain", ""),
            "department": tags.get("department", ""),
            "status": status,
            "os": container_os,
            "tier": tier,
            "cpu": cpu_map.get(tier, 2048),
            "memory": mem_map.get(tier, 8192),
            "ip": ip,
            "startedAt": str(t.get("startedAt", "")),
            "execEnabled": t.get("enableExecuteCommand", False),
        })

    running = sum(1 for c in containers if c["status"] == "RUNNING")
    return ok({
        "cluster": cluster,
        "total": len(containers),
        "running": running,
        "osDist": os_dist,
        "tierDist": tier_dist,
        "containers": containers,
    })


def handle_efs_info(args):
    efs = boto3.client("efs")
    fs_id = args.get("fileSystemId", EFS_ID)

    resp = efs.describe_file_systems(FileSystemId=fs_id)
    fs = resp["FileSystems"][0] if resp.get("FileSystems") else {}
    size = fs.get("SizeInBytes", {})

    mounts = efs.describe_mount_targets(FileSystemId=fs_id).get("MountTargets", [])

    return ok({
        "fileSystemId": fs_id,
        "name": fs.get("Name", ""),
        "state": fs.get("LifeCycleState", "unknown"),
        "sizeBytes": size.get("Value", 0),
        "sizeStandard": size.get("ValueInStandard", 0),
        "sizeIA": size.get("ValueInIA", 0),
        "mountTargets": len(mounts),
        "encrypted": fs.get("Encrypted", False),
    })


def ok(data):
    return {"statusCode": 200, "body": json.dumps(data, default=str, ensure_ascii=False)}
