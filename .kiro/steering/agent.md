# Agent Module

## Role
Bedrock AgentCore Runtime + MCP Gateway 기반 AI Assistant. Strands 프레임워크.

## Key Files
- `agent.py` - Strands Agent + BedrockAgentCoreApp, @tool 정의
- `streamable_http_sigv4.py` - SigV4 인증 HTTP 스트리밍
- `Dockerfile` - Python 3.11 ARM64 컨테이너
- `requirements.txt` - bedrock-agentcore, strands-agents, boto3
- `lambda/cc_ecs_mcp.py` - ECS 컨테이너 관리 MCP tools
- `lambda/cc_cloudwatch_mcp.py` - CloudWatch 메트릭 MCP tools
- `lambda/cc_dynamodb_mcp.py` - DynamoDB 사용량 조회 MCP tools
- `lambda/create_targets.py` - AgentCore Gateway Lambda 타겟 생성 스크립트

## AgentCore Resources
| Resource | ID | Purpose |
|----------|-----|---------|
| Runtime | cconbedrock_assistant_v2 | Strands Agent (PUBLIC mode) |
| Gateway | cconbedrock-gateway | MCP protocol, 3 Lambda targets |
| Memory | cconbedrock_memory | Per-user conversation history |

## MCP Tools (8)
| Lambda | Tools | Description |
|--------|-------|-------------|
| cc_ecs_mcp | list_containers, start_container, stop_container | ECS 컨테이너 관리 |
| cc_cloudwatch_mcp | get_container_metrics, get_cluster_metrics | CloudWatch 메트릭 |
| cc_dynamodb_mcp | get_user_usage, get_cost_summary, get_budget_status | DynamoDB 사용량 |

## Rules
- `@app.entrypoint` 데코레이터로 AgentCore Runtime 서비스 계약 준수
- `app.run()`으로 AgentCore가 실행 제어
- Lambda 타겟 배포: `ACCOUNT_ID=xxx python3 agent/lambda/create_targets.py`
