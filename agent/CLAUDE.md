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
# Build & push (ACCOUNT_ID, REGION, RUNTIME_ID는 환경에 맞게)
docker build --platform linux/arm64 -t ${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/cc-on-bedrock/agent:<tag> agent/
docker push ${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/cc-on-bedrock/agent:<tag>

# AgentCore Runtime 업데이트
aws bedrock-agentcore-control update-agent-runtime \
  --agent-runtime-id ${RUNTIME_ID} \
  --agent-runtime-artifact '{"containerConfiguration":{"containerUri":"'${ACCOUNT_ID}'.dkr.ecr.'${REGION}'.amazonaws.com/cc-on-bedrock/agent:<tag>"}}' \
  --region ${REGION}

# Gateway Lambda 타깃 생성
python3 agent/lambda/create_targets.py
```

## Known gaps
- AgentCore Runtime·Gateway·Memory와 Gateway 타깃은 Terraform 밖에서 생성된다(`create_targets.py`, CLI). Terraform 단일 IaC 원칙(ADR-001)과 맞지 않으므로, 이 영역을 확장할 때는 Terraform 이관을 먼저 검토한다.
- `SKILL_PROMPT`와 `cc_ecs_mcp.py`는 아직 ECS 컨테이너 + EFS 모델을 가정한다. 현재 DevEnv는 per-user EC2 + 2-볼륨 EBS다(ADR-002).

## Rules
- AgentCore Runtime 서비스 계약을 위해 `@app.entrypoint`와 `app.run()`을 유지한다.
- Account ID, Runtime ID, 리전은 환경변수나 SSM으로 받는다.
