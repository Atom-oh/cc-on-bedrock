"""
Budget Check Lambda (runs every 5 minutes)
Checks DynamoDB for users exceeding daily budget.
Actions:
  80%: SNS warning alert
  100%: Attach IAM Deny Policy to per-user Task Role + Cognito flag + SNS alert
  Next day: Remove Deny Policy automatically
"""
import os
import json
import boto3
from datetime import datetime

TABLE_NAME = os.environ.get("USAGE_TABLE_NAME", "cc-on-bedrock-usage")
ECS_CLUSTER = os.environ.get("ECS_CLUSTER_NAME", "cc-on-bedrock-devenv")
DAILY_BUDGET = float(os.environ.get("DAILY_BUDGET_USD", "50"))
USER_POOL_ID = os.environ.get("COGNITO_USER_POOL_ID", "")
SNS_TOPIC_ARN = os.environ.get("SNS_TOPIC_ARN", "")
TASK_ROLE_PREFIX = "cc-on-bedrock-task"
DENY_POLICY_NAME = "BudgetExceededDeny"

dynamodb = boto3.resource("dynamodb")
table = dynamodb.Table(TABLE_NAME)
iam_client = boto3.client("iam")
cognito_client = boto3.client("cognito-idp")
sns_client = boto3.client("sns")


def get_today_usage():
    """Scan DynamoDB for all USER# entries today."""
    today = datetime.utcnow().strftime("%Y-%m-%d")
    result = table.scan(
        FilterExpression="begins_with(PK, :prefix) AND begins_with(SK, :today)",
        ExpressionAttributeValues={":prefix": "USER#", ":today": today},
    )
    user_spend = {}
    for item in result.get("Items", []):
        user = item["PK"].replace("USER#", "")
        cost = float(item.get("estimatedCost", 0))
        dept = item.get("department", "default")
        if user in user_spend:
            user_spend[user]["cost"] += cost
        else:
            user_spend[user] = {"cost": cost, "department": dept}
    return user_spend


def attach_deny_policy(subdomain: str):
    """Attach IAM Deny Policy to user's per-user Task Role."""
    role_name = f"{TASK_ROLE_PREFIX}-{subdomain}"
    deny_policy = json.dumps({
        "Version": "2012-10-17",
        "Statement": [{
            "Sid": "BudgetExceededDenyBedrock",
            "Effect": "Deny",
            "Action": [
                "bedrock:InvokeModel",
                "bedrock:InvokeModelWithResponseStream",
                "bedrock:Converse",
                "bedrock:ConverseStream",
            ],
            "Resource": "*",
        }],
    })
    try:
        iam_client.put_role_policy(
            RoleName=role_name,
            PolicyName=DENY_POLICY_NAME,
            PolicyDocument=deny_policy,
        )
        print(f"[DENY] Attached to {role_name}")
        return True
    except Exception as e:
        print(f"[DENY] Failed for {role_name}: {e}")
        return False


def remove_deny_policy(subdomain: str):
    """Remove IAM Deny Policy from user's Task Role (next-day reset)."""
    role_name = f"{TASK_ROLE_PREFIX}-{subdomain}"
    try:
        iam_client.delete_role_policy(
            RoleName=role_name,
            PolicyName=DENY_POLICY_NAME,
        )
        print(f"[ALLOW] Removed deny from {role_name}")
        return True
    except iam_client.exceptions.NoSuchEntityException:
        return False  # No deny policy exists
    except Exception as e:
        print(f"[ALLOW] Failed for {role_name}: {e}")
        return False


def check_deny_exists(subdomain: str) -> bool:
    """Check if Deny Policy already exists on user's role."""
    role_name = f"{TASK_ROLE_PREFIX}-{subdomain}"
    try:
        iam_client.get_role_policy(
            RoleName=role_name,
            PolicyName=DENY_POLICY_NAME,
        )
        return True
    except:
        return False


def set_cognito_budget_flag(username: str, exceeded: bool):
    """Set budget_exceeded flag in Cognito user attributes."""
    if not USER_POOL_ID:
        return
    try:
        result = cognito_client.list_users(
            UserPoolId=USER_POOL_ID,
            Filter=f'custom:subdomain = "{username}"',
            Limit=1,
        )
        users = result.get("Users", [])
        if users:
            cognito_client.admin_update_user_attributes(
                UserPoolId=USER_POOL_ID,
                Username=users[0]["Username"],
                UserAttributes=[
                    {"Name": "custom:budget_exceeded", "Value": str(exceeded).lower()},
                ],
            )
    except Exception as e:
        print(f"Cognito update failed for {username}: {e}")


def handler(event, context):
    """Check budgets and enforce limits via per-user IAM Deny Policy."""
    user_spend = get_today_usage()
    all_known_users = set(user_spend.keys())
    over_budget = []
    warnings = []
    denied = 0
    released = 0

    for user, data in user_spend.items():
        pct = (data["cost"] / DAILY_BUDGET) * 100 if DAILY_BUDGET > 0 else 0

        if pct >= 100:
            over_budget.append({
                "user": user, "cost": data["cost"],
                "department": data["department"], "pct": pct,
            })
        elif pct >= 80:
            warnings.append({
                "user": user, "cost": data["cost"],
                "department": data["department"], "pct": pct,
            })

    # 80%: Send warning alert
    if warnings and SNS_TOPIC_ARN:
        msg = f"CC-on-Bedrock Budget Warnings (daily limit: ${DAILY_BUDGET}):\n\n"
        msg += "\n".join(
            f"- {w['user']} ({w['department']}): ${w['cost']:.4f} ({w['pct']:.1f}%)"
            for w in warnings
        )
        try:
            sns_client.publish(TopicArn=SNS_TOPIC_ARN, Subject="[CC-on-Bedrock] Budget Warning", Message=msg)
        except Exception as e:
            print(f"SNS warning failed: {e}")

    # 100%: Attach IAM Deny Policy + Cognito flag
    for item in over_budget:
        user = item["user"]
        print(f"OVER BUDGET: {user} ({item['department']}) ${item['cost']:.4f} ({item['pct']:.1f}%)")

        if attach_deny_policy(user):
            denied += 1
        set_cognito_budget_flag(user, True)

    if over_budget and SNS_TOPIC_ARN:
        msg = f"CC-on-Bedrock Budget EXCEEDED - Bedrock Access Denied:\n\n"
        msg += "\n".join(
            f"- {o['user']} ({o['department']}): ${o['cost']:.4f} ({o['pct']:.1f}% of ${DAILY_BUDGET})"
            for o in over_budget
        )
        try:
            sns_client.publish(TopicArn=SNS_TOPIC_ARN, Subject="[CC-on-Bedrock] Budget Exceeded - Access Denied", Message=msg)
        except Exception as e:
            print(f"SNS alert failed: {e}")

    # Release users who are NOT over budget but still have Deny Policy
    over_budget_users = {o["user"] for o in over_budget}
    for user in all_known_users:
        if user not in over_budget_users:
            if remove_deny_policy(user):
                released += 1
                set_cognito_budget_flag(user, False)

    return {
        "checked": len(user_spend),
        "over_budget": len(over_budget),
        "denied": denied,
        "released": released,
        "warnings": len(warnings),
        "daily_budget_usd": DAILY_BUDGET,
        "timestamp": datetime.utcnow().isoformat(),
    }
