# Agent Module

## Role
Bedrock AgentCore Runtime + MCP Gateway 기반 AI Assistant (Strands). Slack과 대시보드 `/api/ai/runtime`이 호출한다. 상세는 `agent/CLAUDE.md`.

## Key Files
- `agent.py` - `BedrockAgentCoreApp` 엔트리포인트. Gateway(MCP)에서 도구를 동적으로 받고, 모델은 `BEDROCK_MODEL_ID`(기본 `global.anthropic.claude-sonnet-5`)
- `streamable_http_sigv4.py` - SigV4 서명 streamable HTTP transport
- `lambda/cc_ecs_mcp.py` - `get_container_status`, `get_efs_info`
- `lambda/cc_cloudwatch_mcp.py` - `get_container_metrics`
- `lambda/cc_dynamodb_mcp.py` - `get_spend_summary`, `get_budget_status`, `get_system_health`, `get_user_usage`, `get_department_usage`
- `lambda/create_targets.py` - Gateway(`cconbedrock-gateway`) + Lambda 타깃 생성
- `Dockerfile` (Python 3.11), `requirements.txt`

## AI Assistant 경로
```
Dashboard: Browser → /api/ai → Bedrock Converse (inline tools, 최대 5 iteration)
Slack:     Slack Bot → /api/ai/runtime → AgentCore Runtime → Gateway (MCP) → Lambda
공유:      AgentCore Memory (사용자별 세션 격리)
```

## Notes
- `@app.entrypoint`와 `app.run()`은 AgentCore Runtime 서비스 계약이므로 유지한다.
- AgentCore 리소스는 아직 Terraform 밖에서 만들어진다. 확장 시 Terraform 이관(ADR-001)을 먼저 검토한다.
- ECS/EFS 관련 도구와 프롬프트는 과거 컨테이너 모델의 잔재다. 현재 DevEnv는 per-user EC2 + EBS(ADR-002).
