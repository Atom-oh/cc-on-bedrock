#!/bin/bash
# Monitors code-server idle status and publishes metrics to CloudWatch
# Custom CC/DevEnv namespace with per-task dimensions for accurate idle detection
# Also writes local /tmp/idle-status for diagnostic purposes

IDLE_THRESHOLD_SECONDS="${IDLE_TIMEOUT_SECONDS:-7200}"  # 2 hours default
METRIC_FILE="/tmp/idle-status"
REGION="${AWS_DEFAULT_REGION:-ap-northeast-2}"

# Extract ECS Task ID from Task Metadata Endpoint v4
get_task_id() {
  if [ -n "${ECS_CONTAINER_METADATA_URI_V4:-}" ]; then
    local task_arn
    task_arn=$(curl -s --max-time 2 "${ECS_CONTAINER_METADATA_URI_V4}/task" 2>/dev/null | \
      python3 -c "import sys,json; print(json.load(sys.stdin).get('TaskARN',''))" 2>/dev/null)
    if [ -n "$task_arn" ]; then
      echo "${task_arn##*/}"
      return
    fi
  fi
  echo ""
}

ECS_TASK_ID=$(get_task_id)
USER_ID="${USER_SUBDOMAIN:-${SUBDOMAIN:-unknown}}"

if [ -z "$ECS_TASK_ID" ]; then
  echo "[idle-monitor] WARNING: Could not determine ECS Task ID, CloudWatch metrics disabled"
fi

publish_metric() {
  local metric_name="$1"
  local value="$2"

  if [ -z "$ECS_TASK_ID" ]; then
    return
  fi

  aws cloudwatch put-metric-data \
    --namespace "CC/DevEnv" \
    --metric-data "[
      {
        \"MetricName\": \"${metric_name}\",
        \"Dimensions\": [
          {\"Name\": \"TaskId\", \"Value\": \"${ECS_TASK_ID}\"},
          {\"Name\": \"UserId\", \"Value\": \"${USER_ID}\"}
        ],
        \"Value\": ${value},
        \"Unit\": \"Percent\"
      }
    ]" \
    --region "$REGION" 2>/dev/null || true
}

while true; do
  sleep 60

  # Check code-server active connections
  ACTIVE_CONNECTIONS=$(curl -s http://localhost:8080/healthz 2>/dev/null | grep -c "alive" || echo "0")

  # Check recent terminal activity (pty writes in last 5 min)
  RECENT_ACTIVITY=$(find /home/coder -name "*.pty" -mmin -5 2>/dev/null | wc -l)

  # Check CPU usage of coder user processes
  CPU_USAGE=$(ps -u coder -o pcpu= 2>/dev/null | awk '{sum+=$1} END {printf "%.0f", sum}')

  if [ "${ACTIVE_CONNECTIONS:-0}" -eq 0 ] && [ "${RECENT_ACTIVITY:-0}" -eq 0 ] && [ "${CPU_USAGE:-0}" -lt 5 ]; then
    # Increment idle counter
    IDLE_COUNT=$(cat "$METRIC_FILE" 2>/dev/null || echo "0")
    IDLE_COUNT=$((IDLE_COUNT + 1))
    echo "$IDLE_COUNT" > "$METRIC_FILE"

    IDLE_MINUTES=$((IDLE_COUNT))
    echo "[idle-monitor] Container idle for ${IDLE_MINUTES} minutes (threshold: $((IDLE_THRESHOLD_SECONDS / 60)) min)"

    # Publish idle CPU metric (0% = fully idle)
    publish_metric "CpuUsage" "${CPU_USAGE:-0}"
    publish_metric "IdleMinutes" "$IDLE_COUNT"
  else
    echo "0" > "$METRIC_FILE"

    # Publish active CPU metric
    publish_metric "CpuUsage" "${CPU_USAGE:-0}"
    publish_metric "IdleMinutes" "0"
  fi
done
