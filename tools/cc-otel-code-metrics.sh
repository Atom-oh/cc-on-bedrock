#!/usr/bin/env bash
# Emit EC2 DevEnv code-activity metrics to an OTEL Collector every timer tick.
set -euo pipefail

WORKSPACE_ROOT="${WORKSPACE_ROOT:-/home/coder/workspace}"
ENDPOINT="${OTEL_EXPORTER_OTLP_ENDPOINT:-${OTEL_COLLECTOR_ENDPOINT:-}}"

if [[ -z "${ENDPOINT}" ]]; then
  exit 0
fi

if [[ "${ENDPOINT}" != */v1/metrics ]]; then
  ENDPOINT="${ENDPOINT%/}/v1/metrics"
fi

INSTANCE_ID="${INSTANCE_ID:-}"
if [[ -z "${INSTANCE_ID}" ]] && command -v curl >/dev/null 2>&1; then
  TOKEN="$(curl -fsS -m 1 -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' 2>/dev/null || true)"
  if [[ -n "${TOKEN}" ]]; then
    INSTANCE_ID="$(curl -fsS -m 1 -H "X-aws-ec2-metadata-token: ${TOKEN}" http://169.254.169.254/latest/meta-data/instance-id 2>/dev/null || true)"
  fi
fi
INSTANCE_ID="${INSTANCE_ID:-unknown}"

payload="$(python3 - "${WORKSPACE_ROOT}" "${INSTANCE_ID}" <<'PY'
import json
import os
import subprocess
import sys
import time
from pathlib import Path

workspace = Path(sys.argv[1])
instance_id = sys.argv[2]
now = time.time_ns()

skip_dirs = {".git", "node_modules", ".next", "dist", "build", "coverage", ".venv", "venv"}
source_suffixes = {
    ".py", ".ts", ".tsx", ".js", ".jsx", ".go", ".rs", ".java", ".kt", ".c",
    ".cc", ".cpp", ".h", ".hpp", ".cs", ".rb", ".php", ".sh", ".tf", ".yaml",
    ".yml", ".json", ".md",
}

def git(repo, *args):
    try:
        return subprocess.check_output(["git", "-C", str(repo), *args], text=True, stderr=subprocess.DEVNULL).strip()
    except Exception:
        return ""

repos = []
if workspace.exists():
    for root, dirs, _files in os.walk(workspace):
        dirs[:] = [d for d in dirs if d not in skip_dirs]
        if ".git" in os.listdir(root):
            repos.append(Path(root))
            dirs[:] = []

commit_total = 0
commit_recent = 0
loc_total = 0
review_markers = 0

for repo in repos:
    count = git(repo, "rev-list", "--count", "HEAD")
    if count.isdigit():
        commit_total += int(count)

    recent = git(repo, "log", "--since=60 seconds ago", "--format=%H")
    if recent:
        commit_recent += len([line for line in recent.splitlines() if line.strip()])

    tracked = git(repo, "ls-files")
    for rel in [line for line in tracked.splitlines() if line.strip()]:
        path = repo / rel
        if path.suffix.lower() not in source_suffixes or not path.is_file():
            continue
        try:
            text = path.read_text(encoding="utf-8", errors="ignore")
        except Exception:
            continue
        loc_total += sum(1 for line in text.splitlines() if line.strip())
        low = text.lower()
        review_markers += low.count("review:") + low.count("reviewed-by:") + low.count("pull request")

attrs = [
    {"key": "service.name", "value": {"stringValue": "cc-on-bedrock-code-metrics"}},
    {"key": "host.id", "value": {"stringValue": instance_id}},
    {"key": "cc.user", "value": {"stringValue": os.environ.get("USER_SUBDOMAIN", os.environ.get("USER", "unknown"))}},
    {"key": "cc.department", "value": {"stringValue": os.environ.get("DEPARTMENT", "unknown")}},
]

def gauge(name, value, description):
    return {
        "name": name,
        "description": description,
        "unit": "1",
        "gauge": {"dataPoints": [{"timeUnixNano": str(now), "asInt": int(value)}]},
    }

payload = {
    "resourceMetrics": [{
        "resource": {"attributes": attrs},
        "scopeMetrics": [{
            "scope": {"name": "cc-otel-code-metrics", "version": "1.0.0"},
            "metrics": [
                gauge("cc.code.repositories", len(repos), "Git repositories under the workspace"),
                gauge("cc.code.commits.total", commit_total, "Total git commits across workspace repositories"),
                gauge("cc.code.commits.last_minute", commit_recent, "Git commits created in the last minute"),
                gauge("cc.code.loc", loc_total, "Tracked nonblank source lines of code"),
                gauge("cc.code.review_markers", review_markers, "Review marker occurrences in tracked files"),
            ],
        }],
    }],
}
print(json.dumps(payload, separators=(",", ":")))
PY
)"

curl -fsS -m 5 -X POST \
  -H "Content-Type: application/json" \
  --data "${payload}" \
  "${ENDPOINT}" >/dev/null
