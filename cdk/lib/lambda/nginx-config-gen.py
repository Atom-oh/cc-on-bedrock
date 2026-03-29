"""
Nginx Config Generator Lambda for CC-on-Bedrock Enterprise

Triggered by DynamoDB Stream on cc-routing-table.
Generates nginx.conf with dynamic upstream/server blocks from routing entries.
Uploads to S3 for Nginx containers to poll and reload.

DynamoDB routing-table schema:
  PK: subdomain (String) - e.g., "user1", "alice"
  container_ip (String) - e.g., "10.0.1.50"
  port (Number) - e.g., 8080
  status (String) - "active" | "stopping" | "stopped"
  updated_at (String) - ISO timestamp
"""

import json
import logging
import os
from datetime import datetime
from typing import Any

import boto3
from botocore.exceptions import ClientError

# Configure logging
logger = logging.getLogger()
logger.setLevel(logging.INFO)

# Environment variables
REGION = os.environ.get("AWS_REGION", "ap-northeast-2")
ROUTING_TABLE = os.environ.get("ROUTING_TABLE", "cc-routing-table")
CONFIG_BUCKET = os.environ.get("CONFIG_BUCKET", "")
CONFIG_KEY = os.environ.get("CONFIG_KEY", "nginx/nginx.conf")
DEV_DOMAIN = os.environ.get("DEV_DOMAIN", "dev.example.com")
CLOUDFRONT_SECRET = os.environ.get("CLOUDFRONT_SECRET", "")

# AWS clients
dynamodb = boto3.resource("dynamodb", region_name=REGION)
s3 = boto3.client("s3", region_name=REGION)

# Nginx config template
NGINX_TEMPLATE = """# Auto-generated nginx config for CC-on-Bedrock Enterprise
# Generated at: {generated_at}
# Active routes: {route_count}
# CloudFront terminates TLS; Nginx listens on port 80 only

worker_processes auto;
error_log /var/log/nginx/error.log warn;
pid /var/run/nginx.pid;

events {{
    worker_connections 4096;
    use epoll;
    multi_accept on;
}}

http {{
    include /etc/nginx/mime.types;
    default_type application/octet-stream;

    log_format main '$remote_addr - $remote_user [$time_local] "$request" '
                    '$status $body_bytes_sent "$http_referer" '
                    '"$http_user_agent" "$http_x_forwarded_for" '
                    'host="$host" upstream="$upstream_addr"';

    access_log /var/log/nginx/access.log main;

    sendfile on;
    tcp_nopush on;
    tcp_nodelay on;
    keepalive_timeout 65;
    types_hash_max_size 2048;

    # Increase buffer sizes for WebSocket and large requests
    proxy_buffer_size 128k;
    proxy_buffers 4 256k;
    proxy_busy_buffers_size 256k;
    large_client_header_buffers 4 16k;

    # WebSocket support
    map $http_upgrade $connection_upgrade {{
        default upgrade;
        '' close;
    }}

    # Default server - health checks + reject unknown hosts
    server {{
        listen 80 default_server;
        server_name _;

        # Health check (no auth - NLB uses IP, no custom headers)
        location /health {{
            access_log off;
            return 200 'ok';
            add_header Content-Type text/plain;
        }}

        location /nginx-status {{
            stub_status on;
            access_log off;
        }}

        # All other requests require CloudFront secret
        location / {{
            set $cf_secret "{cloudfront_secret}";
            if ($http_x_custom_secret != $cf_secret) {{
                return 403 '{{"error":"Forbidden"}}';
            }}
            default_type application/json;
            return 503 '{{"error":"Container not running. Please start your development environment from the portal.","code":"CONTAINER_NOT_FOUND"}}';
        }}
    }}

{upstream_entries}

{server_entries}
}}
"""

# Upstream block template
UPSTREAM_TEMPLATE = """    # Upstream for {subdomain}
    upstream user_{subdomain} {{
        server {container_ip}:{port} max_fails=3 fail_timeout=30s;
        keepalive 32;
    }}
"""

# Server block template
SERVER_TEMPLATE = """    # Server block for {subdomain}
    server {{
        listen 80;
        server_name {subdomain}.{domain};

        # Validate CloudFront secret
        set $cf_secret "{cloudfront_secret}";
        if ($http_x_custom_secret != $cf_secret) {{
            return 403 '{{"error":"Forbidden"}}';
        }}

        # Proxy settings
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;

        # Timeouts for long-running connections (Claude Code sessions)
        proxy_connect_timeout 60s;
        proxy_send_timeout 3600s;
        proxy_read_timeout 3600s;

        location / {{
            proxy_pass http://user_{subdomain};
        }}
    }}
"""


def handler(event: dict, context: Any) -> dict:
    """
    Lambda handler triggered by DynamoDB Stream.
    Regenerates nginx config on any routing table change.
    """
    logger.info(f"Received event with {len(event.get('Records', []))} records")

    try:
        # Generate new config from all active routes
        config = generate_nginx_config()

        # Upload to S3
        upload_config(config)

        return {
            "statusCode": 200,
            "body": json.dumps({
                "message": "Nginx config updated successfully",
                "timestamp": datetime.utcnow().isoformat(),
            }),
        }

    except ClientError as e:
        logger.error(f"AWS ClientError: {e}")
        return {
            "statusCode": 500,
            "body": json.dumps({"error": f"AWS error: {e.response['Error']['Message']}"}),
        }
    except Exception as e:
        logger.error(f"Unexpected error: {e}", exc_info=True)
        return {
            "statusCode": 500,
            "body": json.dumps({"error": f"Internal error: {str(e)}"}),
        }


def generate_nginx_config() -> str:
    """
    Scan DynamoDB routing table and generate nginx config.
    Only includes routes with status='active'.
    """
    table = dynamodb.Table(ROUTING_TABLE)

    # Scan all items (for small-medium deployments; use GSI for large scale)
    routes = []
    scan_kwargs = {}

    while True:
        response = table.scan(**scan_kwargs)
        items = response.get("Items", [])

        for item in items:
            if item.get("status") == "active":
                routes.append({
                    "subdomain": item["subdomain"],
                    "container_ip": item.get("container_ip") or item.get("targetIp", ""),
                    "port": int(item.get("port", 8080)),
                })

        # Handle pagination
        if "LastEvaluatedKey" in response:
            scan_kwargs["ExclusiveStartKey"] = response["LastEvaluatedKey"]
        else:
            break

    logger.info(f"Found {len(routes)} active routes")

    # Generate upstream entries
    upstream_entries = []
    for route in routes:
        upstream_entries.append(UPSTREAM_TEMPLATE.format(
            subdomain=route["subdomain"],
            container_ip=route["container_ip"],
            port=route["port"],
        ))

    # Generate server entries
    server_entries = []
    for route in routes:
        server_entries.append(SERVER_TEMPLATE.format(
            subdomain=route["subdomain"],
            domain=DEV_DOMAIN,
            cloudfront_secret=CLOUDFRONT_SECRET,
        ))

    # Render final config
    config = NGINX_TEMPLATE.format(
        generated_at=datetime.utcnow().isoformat(),
        route_count=len(routes),
        cloudfront_secret=CLOUDFRONT_SECRET,
        upstream_entries="\n".join(upstream_entries),
        server_entries="\n".join(server_entries),
    )

    return config


def upload_config(config: str) -> None:
    """Upload nginx config to S3."""
    if not CONFIG_BUCKET:
        logger.warning("CONFIG_BUCKET not set, skipping S3 upload")
        return

    logger.info(f"Uploading config to s3://{CONFIG_BUCKET}/{CONFIG_KEY}")

    s3.put_object(
        Bucket=CONFIG_BUCKET,
        Key=CONFIG_KEY,
        Body=config.encode("utf-8"),
        ContentType="text/plain",
        Metadata={
            "generated-at": datetime.utcnow().isoformat(),
            "generator": "cc-on-bedrock-nginx-config-gen",
        },
    )

    logger.info("Config uploaded successfully")


# For local testing
if __name__ == "__main__":
    # Mock event (DynamoDB Stream event)
    test_event = {
        "Records": [
            {
                "eventName": "INSERT",
                "dynamodb": {
                    "NewImage": {
                        "subdomain": {"S": "user1"},
                        "container_ip": {"S": "10.0.1.50"},
                        "port": {"N": "8080"},
                        "status": {"S": "active"},
                    }
                }
            }
        ]
    }

    # Set test environment
    os.environ["ROUTING_TABLE"] = "cc-routing-table"
    os.environ["CONFIG_BUCKET"] = "test-bucket"
    os.environ["DEV_DOMAIN"] = "dev.example.com"
    os.environ["CLOUDFRONT_SECRET"] = "test-secret-value"

    # Generate config (without S3 upload)
    config = generate_nginx_config()
    print(config)
