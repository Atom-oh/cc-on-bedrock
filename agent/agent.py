"""
CC-on-Bedrock AI Assistant Agent
AgentCore Runtime + Gateway (MCP) 구성
awsops 패턴 참조: Strands Agent + 동적 Gateway 라우팅 + Skill Prompt
"""
import json
import logging
import os
from strands import Agent
from strands.models import BedrockModel
from strands.tools.mcp.mcp_client import MCPClient
from botocore.credentials import Credentials
from bedrock_agentcore.runtime import BedrockAgentCoreApp
from streamable_http_sigv4 import streamablehttp_client_with_sigv4
import boto3

# Configure logging
logging.getLogger("strands").setLevel(logging.INFO)
logging.basicConfig(format="%(levelname)s | %(name)s | %(message)s", handlers=[logging.StreamHandler()])

# Initialize AgentCore application
app = BedrockAgentCoreApp()

# Gateway URL (단일 Gateway, 향후 역할별 분리 가능)
GATEWAY_URL = os.environ.get("GATEWAY_URL", "")
GATEWAY_REGION = os.environ.get("AWS_REGION", os.environ.get("AWS_DEFAULT_REGION", "ap-northeast-2"))
SERVICE = "bedrock-agentcore"

# Bedrock Model
model = BedrockModel(
    model_id=os.environ.get("BEDROCK_MODEL_ID", "global.anthropic.claude-sonnet-4-6"),
    region_name=GATEWAY_REGION,
)

# ============================================================================
# Skill Prompt: CC-on-Bedrock 플랫폼 운영 전문가
# ============================================================================
SKILL_PROMPT = """You are CC-on-Bedrock AI Assistant, an expert analyst for a multi-user Claude Code development platform on AWS Bedrock.

## Architecture
- Users run Claude Code in ECS containers with direct Bedrock access via Task Roles (no proxy)
- Usage tracked via CloudTrail → EventBridge → Lambda → DynamoDB
- Budget enforcement: Lambda checks every 5 minutes, IAM Deny Policy on exceed
- EFS shared storage with per-user directory isolation (/home/coder/users/{subdomain}/)

## Decision Patterns — Match user question to tool chain:
| User asks about... | Tool chain |
|---|---|
| 컨테이너 상태, 사용자 목록 | get_container_status |
| CPU, Memory, Network 메트릭 | get_container_metrics |
| 비용, 토큰 사용량, 사용자별 지출 | get_spend_summary |
| 예산 현황, 초과 사용자 | get_budget_status |
| 시스템 상태, 헬스체크 | get_system_health |
| EFS 용량, 스토리지 | get_efs_info |
| 특정 사용자 사용량 | get_user_usage (user_id 필요) |
| 부서별 사용량 비교 | get_department_usage |

## Troubleshooting Workflows:
- Cost spike: get_spend_summary → get_budget_status → get_user_usage (top user)
- Performance: get_container_metrics → get_container_status (check tier)
- Capacity: get_container_status (osDist, tierDist) → get_container_metrics (CPU/Mem %)

## Rules:
- ALWAYS call tools for real-time data — never answer from memory
- Use markdown tables for comparisons
- Highlight warnings: budget >80%, CPU >80%, unhealthy services
- Show costs in USD with 4 decimal places
- Respond in the same language as the user's question
"""

COMMON_FOOTER = "\n\nFormat responses in markdown. Respond in the user's language."


def build_skill_prompt(tools):
    """Build system prompt: static patterns + dynamic tool list from MCP."""
    tool_lines = []
    for t in tools:
        name = t.tool_name
        desc = getattr(t, "description", "") or ""
        short_desc = desc.split(".")[0].strip() if desc else name
        tool_lines.append(f"- **{name}**: {short_desc}")

    tool_section = f"\n\n## Available Tools ({len(tools)}):\n" + "\n".join(tool_lines)
    return SKILL_PROMPT + tool_section + COMMON_FOOTER


def get_aws_credentials():
    """Get current AWS credentials for SigV4 signing."""
    session = boto3.Session()
    creds = session.get_credentials()
    if creds:
        frozen = creds.get_frozen_credentials()
        return frozen.access_key, frozen.secret_key, frozen.token
    return None, None, None


def create_gateway_transport(gateway_url):
    """Create SigV4-signed transport to Gateway."""
    access_key, secret_key, session_token = get_aws_credentials()
    credentials = Credentials(
        access_key=access_key,
        secret_key=secret_key,
        token=session_token,
    )
    return streamablehttp_client_with_sigv4(
        url=gateway_url,
        credentials=credentials,
        service=SERVICE,
        region=GATEWAY_REGION,
    )


def get_all_tools(client):
    """Get all tools from MCP client with pagination."""
    tools = []
    more = True
    token = None
    while more:
        batch = client.list_tools_sync(pagination_token=token)
        tools.extend(batch)
        if batch.pagination_token is None:
            more = False
        else:
            token = batch.pagination_token
    return tools


def build_conversation(payload):
    """Extract user input and conversation history from payload."""
    messages_list = payload.get("messages", [])
    if messages_list and isinstance(messages_list, list):
        history = []
        for msg in messages_list[:-1]:
            role = msg.get("role", "user")
            content = msg.get("content", "")
            if role in ("user", "assistant") and content:
                history.append({"role": role, "content": [{"text": content}]})
        last_msg = messages_list[-1]
        user_input = last_msg.get("content", "")
        return user_input, history

    # Legacy format
    user_input = payload.get("prompt", payload.get("message", ""))
    return user_input, []


# Main handler
@app.entrypoint
def handler(payload):
    user_input, history = build_conversation(payload)
    if not user_input:
        return "No input provided."

    # Gateway URL from payload or environment
    gateway_url = payload.get("gateway_url", GATEWAY_URL or "")

    if not gateway_url:
        logging.warning("No gateway_url provided — running with local tools only")
        # Fallback: Bedrock direct with base prompt
        agent = Agent(
            model=model,
            system_prompt=SKILL_PROMPT + COMMON_FOOTER,
            messages=history if history else None,
        )
        response = agent(user_input)
        return response.message["content"][0]["text"]

    logging.info(f"Gateway: {gateway_url} (history: {len(history)} messages)")

    try:
        mcp_client = MCPClient(lambda: create_gateway_transport(gateway_url))

        with mcp_client:
            tools = get_all_tools(mcp_client)
            tool_names = [t.tool_name for t in tools]
            logging.info(f"MCP tools ({len(tools)}): {tool_names}")

            system_prompt = build_skill_prompt(tools)

            agent = Agent(
                model=model,
                tools=tools,
                system_prompt=system_prompt,
                messages=history if history else None,
            )

            response = agent(user_input)
            return response.message["content"][0]["text"]

    except Exception as e:
        logging.error(f"Gateway MCP error: {e}")
        # Fallback: Bedrock direct without tools — warn about no real-time data
        fallback_notice = "\n\n⚠ IMPORTANT: MCP Gateway connection failed. You cannot access real-time platform data. DO NOT fabricate data. Instead, inform the user that tool connectivity is unavailable and suggest retrying later."
        agent = Agent(
            model=model,
            system_prompt=SKILL_PROMPT + fallback_notice + COMMON_FOOTER,
            messages=history if history else None,
        )
        response = agent(user_input)
        return response.message["content"][0]["text"]


if __name__ == "__main__":
    app.run()
