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

        # All other requests require CloudFront secret + authenticated user
        location / {{
            set $cf_secret "{cloudfront_secret}";
            if ($http_x_custom_secret != $cf_secret) {{
                return 403 '{{"error":"Forbidden"}}';
            }}
            if ($http_x_auth_user = "") {{
                return 403 '{{"error":"Authentication required"}}';
            }}
            default_type application/json;
            return 503 '{{"error":"Container not running. Please start your development environment from the portal.","code":"CONTAINER_NOT_FOUND"}}';
        }}
    }}

{upstream_entries}

{server_entries}
}}
"""

# Upstream block template — 3 upstreams per user (code-server, frontend, API)
UPSTREAM_TEMPLATE = """    # Upstreams for {subdomain}
    upstream codeserver_{subdomain} {{
        server {container_ip}:8080 max_fails=3 fail_timeout=5s;
        keepalive 32;
    }}
    upstream frontend_{subdomain} {{
        server {container_ip}:3000 max_fails=3 fail_timeout=5s;
        keepalive 16;
    }}
    upstream userapi_{subdomain} {{
        server {container_ip}:8000 max_fails=3 fail_timeout=5s;
        keepalive 16;
    }}
"""

# Server block template — multi-port routing (code-server 8080, frontend 3000, API 8000)
# Routing rules:
#   ?folder=... → code-server (8080)  — code-server IDE
#   /api/...    → userapi (8000)      — user's API server
#   /           → frontend (3000)     — user's frontend dev server
#   code-server internal paths (_static, stable-, vscode-remote-resource) → code-server
SERVER_TEMPLATE = """    # Server block for {subdomain}
    server {{
        listen 80;
        server_name {subdomain}.{domain};

        # Validate CloudFront secret
        set $cf_secret "{cloudfront_secret}";
        if ($http_x_custom_secret != $cf_secret) {{
            return 403 '{{"error":"Forbidden"}}';
        }}

        # Validate authenticated user matches this subdomain (defense-in-depth)
        if ($http_x_auth_user != "{subdomain}") {{
            return 403 '{{"error":"Not authorized for this environment"}}';
        }}

        # Common proxy settings
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header X-Auth-User "";

        # Timeouts for long-running connections (Claude Code sessions)
        proxy_connect_timeout 10s;
        proxy_send_timeout 3600s;
        proxy_read_timeout 3600s;

        # ─── code-server named location ───
        location @codeserver {{
            proxy_pass http://codeserver_{subdomain};
            proxy_intercept_errors on;
            error_page 502 503 504 = @loading_codeserver;
        }}

        location @loading_codeserver {{
            default_type text/html;
            return 503 '<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="5"><title>Starting...</title><style>*{{margin:0;padding:0;box-sizing:border-box}}body{{min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0d1117;color:#c9d1d9;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Noto Sans,Helvetica,Arial,sans-serif}}.c{{text-align:center;max-width:400px;padding:2rem}}.spinner{{width:48px;height:48px;border:4px solid #30363d;border-top-color:#58a6ff;border-radius:50%;animation:spin 1s linear infinite;margin:0 auto 1.5rem}}@keyframes spin{{to{{transform:rotate(360deg)}}}}h1{{font-size:1.25rem;font-weight:600;margin-bottom:.5rem;color:#e6edf3}}p{{font-size:.875rem;color:#8b949e;line-height:1.5}}.badge{{display:inline-flex;align-items:center;gap:6px;margin-top:1rem;padding:4px 12px;background:#161b22;border:1px solid #30363d;border-radius:999px;font-size:.75rem;color:#8b949e}}.dot{{width:6px;height:6px;background:#f0883e;border-radius:50%;animation:pulse 1.5s ease-in-out infinite}}@keyframes pulse{{0%,100%{{opacity:.4}}50%{{opacity:1}}}}</style></head><body><div class="c"><div class="spinner"></div><h1>code-server is starting</h1><p>Your IDE is booting up. This page will automatically refresh.</p><div class="badge"><span class="dot"></span>Warming up</div></div></body></html>';
        }}

        # ─── code-server internal paths (WebSocket, assets, extensions) ───
        location /_static/ {{
            proxy_pass http://codeserver_{subdomain};
        }}
        location /healthz {{
            proxy_pass http://codeserver_{subdomain};
        }}
        location ~ ^/stable-[a-f0-9]+/ {{
            proxy_pass http://codeserver_{subdomain};
        }}
        location ~ ^/vscode-remote-resource/ {{
            proxy_pass http://codeserver_{subdomain};
        }}
        location ~ ^/out/ {{
            proxy_pass http://codeserver_{subdomain};
        }}
        location ~ ^/webview/ {{
            proxy_pass http://codeserver_{subdomain};
        }}

        # ─── User API server (port 8000) ───
        location /api/ {{
            proxy_pass http://userapi_{subdomain};
            proxy_connect_timeout 10s;
            proxy_send_timeout 300s;
            proxy_read_timeout 300s;
            proxy_intercept_errors on;
            error_page 502 503 504 = @noservice_api;
        }}

        location @noservice_api {{
            default_type application/json;
            return 502 '{{"error":"API server is not running on port 8000. Start your API server to access this endpoint.","hint":"Run your server on port 8000 (e.g. uvicorn main:app --port 8000)"}}';
        }}

        # ─── Default: ?folder= → code-server, otherwise → Frontend (port 3000) ───
        location / {{
            # ?folder= parameter → code-server IDE
            if ($arg_folder) {{
                error_page 418 = @codeserver;
                return 418;
            }}
            proxy_pass http://frontend_{subdomain};
            proxy_intercept_errors on;
            error_page 502 503 504 = @noservice_frontend;
        }}

        location @noservice_frontend {{
            default_type text/html;
            return 502 '<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>No Frontend</title><style>*{{margin:0;padding:0;box-sizing:border-box}}body{{min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0d1117;color:#c9d1d9;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Noto Sans,Helvetica,Arial,sans-serif}}.c{{text-align:center;max-width:480px;padding:2rem}}h1{{font-size:1.25rem;font-weight:600;margin-bottom:.75rem;color:#e6edf3}}p{{font-size:.875rem;color:#8b949e;line-height:1.6;margin-bottom:1rem}}code{{background:#161b22;padding:2px 8px;border-radius:4px;font-size:.8rem;color:#79c0ff}}a{{color:#58a6ff;text-decoration:none}}a:hover{{text-decoration:underline}}</style></head><body><div class="c"><h1>Frontend server is not running</h1><p>Start your frontend dev server on <strong>port 3000</strong> to view it here.</p><p><code>npm run dev -- --port 3000</code></p><p style="margin-top:1.5rem;font-size:.8rem"><a href="/?folder=/home/coder">Open code-server IDE instead</a></p></div></body></html>';
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

    # Generate upstream entries (3 upstreams per user: code-server, frontend, API)
    upstream_entries = []
    for route in routes:
        upstream_entries.append(UPSTREAM_TEMPLATE.format(
            subdomain=route["subdomain"],
            container_ip=route["container_ip"],
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
