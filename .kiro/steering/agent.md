# Agent Module

## Role
Bedrock AgentCore Runtime AI Assistant. Strands 프레임워크 기반.

## Key Files
- `agent.py` - Strands Agent + BedrockAgentCoreApp, 5개 @tool 정의
- `Dockerfile` - Python 3.11 ARM64 컨테이너
- `requirements.txt` - bedrock-agentcore, strands-agents, boto3, requests

## Tools
| Tool | Data Source | Description |
|------|-----------|-------------|
| `get_spend_summary` | LiteLLM API | 사용자별 요청/토큰/비용 집계 |
| `get_api_key_budgets` | LiteLLM API | API Key 예산/사용률 |
| `get_system_health` | LiteLLM API | 시스템 상태 |
| `get_container_status` | ECS API | 컨테이너 상태/사용자 할당 |
| `get_container_metrics` | CloudWatch | CPU/Memory/Network 메트릭 |

## Rules
- `ECS_CLUSTER_NAME` 환경변수 필요
- `@app.entrypoint` 데코레이터로 AgentCore Runtime 서비스 계약 준수
- `app.run()`으로 AgentCore가 실행 제어
