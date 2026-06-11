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

# ─── Custom Port Routes validation (ADR-027, B-H1/B-M3 defense-in-depth) ───
import re
import ipaddress

# Empty default → RFC1918-private-only fail-safe (C1: avoid platform-wide outage if env unwired).
# CDK wires the real VPC CIDR; when set, membership is enforced strictly.
VPC_CIDR = os.environ.get("VPC_CIDR", "")
INSTANCE_TABLE = os.environ.get("INSTANCE_TABLE", "cc-user-instances")
MAX_CUSTOM_ROUTES = 5

_SUBDOMAIN_RE = re.compile(r"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$")
_SUBPATH_RE = re.compile(r"^/[a-z0-9][a-z0-9-]*(/[a-z0-9][a-z0-9-]*)*$")
RESERVED_PATHS = (
    "/_static", "/healthz", "/stable-", "/vscode-remote-resource",
    "/out", "/webview", "/manifest.json", "/health", "/nginx-status",
)
RESERVED_PORTS = (8080,)


def is_valid_subdomain(s):
    return bool(isinstance(s, str) and _SUBDOMAIN_RE.match(s))


def _is_reserved_path(p):
    return any(
        p == rp or p.startswith(rp + "/") or (rp.endswith("-") and p.startswith(rp))
        for rp in RESERVED_PATHS
    )


def is_valid_route_path(p):
    if not isinstance(p, str):
        return False
    if p != "/" and not _SUBPATH_RE.match(p):
        return False
    return not _is_reserved_path(p)


def is_valid_route_port(port):
    return isinstance(port, int) and 1024 <= port <= 65535 and port not in RESERVED_PORTS


def is_valid_container_ip(ip, cidr=None):
    cidr = VPC_CIDR if cidr is None else cidr
    try:
        addr = ipaddress.ip_address(ip)
    except (ValueError, TypeError):
        return False
    if not addr.is_private:
        return False
    if not cidr:
        return True  # C1 fail-safe: RFC1918-private only when CIDR unset
    try:
        return addr in ipaddress.ip_network(cidr)
    except ValueError:
        return True  # malformed CIDR → private-only (don't hard-reject)


def validate_routes(subdomain, routes):
    """보간 전 전수 검증. 반환: (valid_routes, status_list). subdomain 무효면 전체 거부.

    C2/C3 defense-in-depth (config-gen은 API 검증을 신뢰하지 않음):
      - 비-dict 항목 skip, path/port 개별 검증
      - 중복 path/port 제거(first wins), root('/') 최대 1개, MAX_CUSTOM_ROUTES cap
    중복/초과 행을 렌더하면 nginx -t 실패 → 공유 프록시 전체 reload 거부.
    """
    if not is_valid_subdomain(subdomain):
        logger.warning("Rejecting all routes: invalid subdomain %r", subdomain)
        return [], [
            {"path": (r.get("path", "?") if isinstance(r, dict) else "?"),
             "state": "rejected", "reason": "invalid subdomain"}
            for r in routes
        ]
    status = []
    valid = []
    seen_paths = set()
    seen_ports = set()
    has_root = False
    for r in routes:
        if not isinstance(r, dict):
            logger.warning("skip non-dict route entry: %r", r)
            continue
        path, port = r.get("path"), r.get("port")
        spath = str(path)  # routeStatus.path is typed string in the API/UI — coerce poison input
        if not is_valid_route_path(path):
            logger.warning("skip route path=%r (invalid/reserved)", path)
            status.append({"path": spath, "state": "rejected", "reason": "invalid or reserved path"})
        elif not is_valid_route_port(port):
            logger.warning("skip route path=%r port=%r (invalid/reserved port)", path, port)
            status.append({"path": spath, "state": "rejected", "reason": "invalid or reserved port"})
        elif path in seen_paths or port in seen_ports:
            logger.warning("skip duplicate route path=%r port=%r", path, port)
            status.append({"path": path, "state": "rejected", "reason": "duplicate path or port"})
        elif path == "/" and has_root:
            status.append({"path": path, "state": "rejected", "reason": "multiple root routes"})
        elif len(valid) >= MAX_CUSTOM_ROUTES:
            status.append({"path": path, "state": "rejected", "reason": "exceeds max routes"})
        else:
            valid.append({"path": path, "port": int(port), "label": str(r.get("label", ""))})
            status.append({"path": path, "state": "ok"})
            seen_paths.add(path)
            seen_ports.add(port)
            if path == "/":
                has_root = True
    return valid, status


# 공통 proxy 지시문. H6: location에 proxy_set_header가 있으면 server-level이 상속되지 않으므로
# X-Auth-User 스크럽 + X-Forwarded-* 를 여기서 반드시 재선언 (백엔드로 인증헤더 누출/누락 방지).
_CUSTOM_COMMON = (
    "        proxy_pass http://custom_{sub}_{port};\n"
    "        proxy_http_version 1.1;\n"
    "        proxy_set_header Host $host;\n"
    "        proxy_set_header X-Real-IP $remote_addr;\n"
    "        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n"
    "        proxy_set_header X-Forwarded-Proto $scheme;\n"
    "        proxy_set_header Upgrade $http_upgrade;\n"
    "        proxy_set_header Connection $connection_upgrade;\n"
    '        proxy_set_header X-Auth-User "";\n'
    "        proxy_read_timeout 3600s;\n"
    "        proxy_send_timeout 3600s;\n"
    "        proxy_intercept_errors on;\n"
    "        error_page 502 503 504 = @noservice_frontend;\n"  # M10: friendly page when app down
)


def render_custom_upstreams(subdomain, valid_routes, container_ip):
    out = []
    for r in valid_routes:
        out.append(
            f"    upstream custom_{subdomain}_{r['port']} {{\n"
            f"        server {container_ip}:{r['port']} max_fails=3 fail_timeout=5s;\n"
            f"        keepalive 16;\n"
            f"    }}\n"
        )
    return "\n".join(out)


def render_custom_locations(subdomain, valid_routes):
    out = []
    for r in valid_routes:
        path, port = r["path"], r["port"]
        common = _CUSTOM_COMMON.format(sub=subdomain, port=port)
        if path == "/":
            out.append(
                "        location / {\n"
                "            if ($arg_folder) { error_page 418 = @codeserver; return 418; }\n"
                f"{common}"
                "        }\n"
            )
        else:
            out.append(
                f"        location = {path} {{\n{common}        }}\n"
                f"        location ^~ {path}/ {{\n{common}        }}\n"
            )
    return "\n".join(out)


# 루트 custom route가 없을 때의 fallback `location /`.
# ?folder= → code-server, 그 외 → @noservice_frontend 안내 페이지.
FALLBACK_ROOT = (
    "        # Fallback root (no custom root route)\n"
    "        location / {\n"
    "            if ($arg_folder) { error_page 418 = @codeserver; return 418; }\n"
    "            error_page 404 = @noservice_frontend;\n"
    "            return 404;\n"
    "        }\n"
)


def write_route_status(subdomain, status):
    """route별 반영 결과를 cc-user-instances 에 기록 (best-effort).

    H4: API GET이 user-instances 에서 routeStatus 를 읽으므로 거기에 써야 UI에 노출됨.
    H5: cc-routing-table 에 쓰면 그 테이블의 Stream이 이 Lambda를 재트리거 → 피드백 루프.
        user-instances 는 config-gen 을 트리거하지 않으므로 안전.
    M9: attribute_exists(user_id) 로 인스턴스 행이 있을 때만 기록(phantom 행 방지).
    """
    table = dynamodb.Table(INSTANCE_TABLE)
    try:
        table.update_item(
            Key={"user_id": subdomain},
            ConditionExpression="attribute_exists(user_id)",
            UpdateExpression="SET routeStatus = :s",
            ExpressionAttributeValues={":s": status},
        )
    except ClientError as e:
        logger.warning("routeStatus write skipped for %s: %s", subdomain, e)

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
            default_type text/html;
            return 503 '<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="5"><title>Starting...</title><style>*{{margin:0;padding:0;box-sizing:border-box}}body{{min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0d1117;color:#c9d1d9;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Noto Sans,Helvetica,Arial,sans-serif}}.c{{text-align:center;max-width:400px;padding:2rem}}.spinner{{width:48px;height:48px;border:4px solid #30363d;border-top-color:#58a6ff;border-radius:50%;animation:spin 1s linear infinite;margin:0 auto 1.5rem}}@keyframes spin{{to{{transform:rotate(360deg)}}}}h1{{font-size:1.25rem;font-weight:600;margin-bottom:.5rem;color:#e6edf3}}p{{font-size:.875rem;color:#8b949e;line-height:1.5}}.badge{{display:inline-flex;align-items:center;gap:6px;margin-top:1rem;padding:4px 12px;background:#161b22;border:1px solid #30363d;border-radius:999px;font-size:.75rem;color:#8b949e}}.dot{{width:6px;height:6px;background:#f0883e;border-radius:50%;animation:pulse 1.5s ease-in-out infinite}}@keyframes pulse{{0%,100%{{opacity:.4}}50%{{opacity:1}}}}</style></head><body><div class="c"><div class="spinner"></div><h1>Environment is starting</h1><p>Your development environment is being configured. This page will automatically refresh.</p><div class="badge"><span class="dot"></span>Warming up</div></div></body></html>';
        }}
    }}

{upstream_entries}

{server_entries}
}}
"""

# Upstream block template — code-server (8080) built-in only.
# frontend(3000)/API(8000) and any other ports now come from customRoutes (ADR-027).
UPSTREAM_TEMPLATE = """    # Upstream for {subdomain} (code-server, built-in)
    upstream codeserver_{subdomain} {{
        server {container_ip}:8080 max_fails=3 fail_timeout=5s;
        keepalive 32;
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
        location /manifest.json {{
            proxy_pass http://codeserver_{subdomain};
        }}
        # Match BOTH `/stable-<hash>/...` (asset paths) AND `/stable-<hash>?...`
        # (WebSocket reconnection endpoint — no trailing slash, query string only).
        # The previous regex required `/` after the hash, which missed the WS path
        # and silently fell back to frontend:3000 → "WebSocket close with status code 1006".
        location ~ ^/stable-[a-f0-9]+(/|$|\?) {{
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

        # ─── User custom port routes (ADR-027) — root + subpaths from customRoutes ───
        # Generated per-user: root "/" (if defined) + "= /path" & "^~ /path/" for each.
        # When no root route exists, a fallback "location /" is appended.
{custom_locations}

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
                raw_routes = item.get("customRoutes", "[]")
                try:
                    parsed_routes = (
                        json.loads(raw_routes) if isinstance(raw_routes, str) else (raw_routes or [])
                    )
                except (ValueError, TypeError):
                    parsed_routes = []
                if not isinstance(parsed_routes, list):  # C3: non-list poison pill guard
                    logger.warning("customRoutes for %s is not a list (%r) — ignoring",
                                   item.get("subdomain"), type(parsed_routes).__name__)
                    parsed_routes = []
                routes.append({
                    "subdomain": item["subdomain"],
                    "container_ip": item.get("container_ip") or item.get("targetIp", ""),
                    "port": int(item.get("port", 8080)),
                    "custom_routes": parsed_routes,
                })

        # Handle pagination
        if "LastEvaluatedKey" in response:
            scan_kwargs["ExclusiveStartKey"] = response["LastEvaluatedKey"]
        else:
            break

    logger.info(f"Found {len(routes)} active routes")

    # Generate upstream + server entries with per-value validation (B-H1/B-M3).
    upstream_entries = []
    server_entries = []
    for route in routes:
        sub = route["subdomain"]
        cip = route["container_ip"]
        if not is_valid_subdomain(sub):
            logger.warning("skip invalid subdomain=%r", sub)
            continue
        if not is_valid_container_ip(cip):
            logger.warning("skip subdomain=%r: invalid container_ip=%r", sub, cip)
            continue
        valid, status = validate_routes(sub, route["custom_routes"])

        # code-server upstream (8080) — always built-in
        upstream_entries.append(UPSTREAM_TEMPLATE.format(subdomain=sub, container_ip=cip))
        custom_up = render_custom_upstreams(sub, valid, cip)
        if custom_up:
            upstream_entries.append(custom_up)

        custom_locations = render_custom_locations(sub, valid)
        if not any(r["path"] == "/" for r in valid):
            custom_locations = (custom_locations + "\n" + FALLBACK_ROOT) if custom_locations else FALLBACK_ROOT

        server_entries.append(SERVER_TEMPLATE.format(
            subdomain=sub,
            domain=DEV_DOMAIN,
            cloudfront_secret=CLOUDFRONT_SECRET,
            custom_locations=custom_locations,
        ))
        write_route_status(sub, status)

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
