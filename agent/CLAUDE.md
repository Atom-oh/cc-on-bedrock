# Agent Module

## Role
Bedrock AgentCore Runtime에 배포되는 AI Assistant (Strands). Slack과 대시보드 `/api/ai/runtime`이 호출하며, 도구는 AgentCore Gateway(MCP)의 Lambda 타깃에서 동적으로 가져온다. 대시보드 `/api/ai`는 이 에이전트를 거치지 않고 Bedrock Converse를 직접 호출한다.

## Key Files
- `agent.py` - `BedrockAgentCoreApp` 엔트리포인트(`@app.entrypoint`, `app.run()`). `GATEWAY_URL`(또는 payload의 `gateway_url`)로 MCP 클라이언트를 열어 도구 목록을 받고, 모델은 `BEDROCK_MODEL_ID`(기본 `global.anthropic.claude-sonnet-5`). Gateway 연결이 없거나 실패하면 도구 없이 응답하되 실시간 데이터를 지어내지 않도록 안내한다.
- `streamable_http_sigv4.py` - Gateway 호출용 SigV4 서명 streamable HTTP transport
- `lambda/cc_ecs_mcp.py` (`get_container_status`, `get_efs_info`), `lambda/cc_cloudwatch_mcp.py` (`get_container_metrics`), `lambda/cc_dynamodb_mcp.py` (`get_spend_summary`, `get_budget_status`, `get_system_health`, `get_user_usage`, `get_department_usage`) - Gateway Lambda 타깃 (총 8개 도구)
- `lambda/create_targets.py` - Gateway(`cconbedrock-gateway`)와 Lambda 타깃 생성. `ACCOUNT_ID`가 없으면 STS로 조회
- `Dockerfile` (Python 3.11), `requirements.txt` (bedrock-agentcore, strands-agents, strands-agents-tools, boto3, requests)

## Commands
```bash
# Build and push an explicitly configured immutable image.
: "${ACCOUNT_ID:?set account}" "${REGION:?set region}" "${AGENT_IMAGE_TAG:?set image tag}"
AGENT_IMAGE="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/cc-on-bedrock/agent:${AGENT_IMAGE_TAG}"
docker build --platform linux/arm64 -t "$AGENT_IMAGE" agent/
docker push "$AGENT_IMAGE"

# AgentCore Runtime 업데이트
aws bedrock-agentcore-control update-agent-runtime \
  --agent-runtime-id "${RUNTIME_ID:?set runtime ID}" \
  --agent-runtime-artifact "$(jq -nc --arg uri "$AGENT_IMAGE" '{containerConfiguration:{containerUri:$uri}}')" \
  --region "$REGION"

# Gateway Lambda 타깃 생성
python3 agent/lambda/create_targets.py
```

## Known gaps
Local source checks (no AWS calls):

```bash
python3 -m py_compile agent/agent.py agent/streamable_http_sigv4.py agent/lambda/*.py
```

Compilation does not validate Runtime/Gateway behavior. Live integration requires
configured resources and an isolated test identity; there is no dedicated local
agent behavior test suite here.

- AgentCore Runtime·Gateway·Memory와 Gateway 타깃은 Terraform 밖에서 생성된다(`create_targets.py`, CLI). Terraform 단일 IaC 원칙(ADR-001)과 맞지 않으므로, 이 영역을 확장할 때는 Terraform 이관을 먼저 검토한다.
- `SKILL_PROMPT`와 `cc_ecs_mcp.py`는 아직 ECS 컨테이너 + EFS 모델을 가정한다. 현재 DevEnv는 per-user EC2 + 2-볼륨 EBS다(ADR-002).

## Rules
- The dashboard `/api/ai/runtime` currently requires both a NextAuth session
  (middleware) and its configured bearer key (handler). External bearer-only
  calls are blocked; direct AgentCore invocation is a separate AWS-authenticated path.
- AgentCore Runtime 서비스 계약을 위해 `@app.entrypoint`와 `app.run()`을 유지한다.
- Account ID, Runtime ID, 리전은 환경변수나 SSM으로 받는다.
