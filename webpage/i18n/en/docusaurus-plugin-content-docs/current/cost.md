# Cost Management

import CostCalculator from '@site/src/components/InteractiveDoc/CostCalculator';

CC-on-Bedrock provides tools for efficient budget management in large-scale user environments.

<CostCalculator />

## Budget Control Flow

It real-time tracks per-user Bedrock calling costs using a serverless architecture.

```text
ECS Task (Claude Code) → Bedrock API call
  → CloudTrail (auto-logged)
  → EventBridge Rule (match bedrock:InvokeModel)
  → Lambda: usage-tracker → DynamoDB (per-user cost stored)
```

## Budget Control

A Lambda function runs every 5 minutes to automatically control budgets:

1. **DynamoDB Scan**: Sum today's cost per user.
2. **80% reached**: Send SNS warning alert.
3. **100% reached**: Apply IAM Deny Policy to the user's Task Role + Cognito flag set (connection can be blocked).
4. **Next day reset**: Deny Policy is automatically released at midnight.

## Cost Saving Tips

- **Excluding LiteLLM**: Using serverless tracking (CloudTrail + Lambda) instead of LiteLLM proxy saves about $370/month (~stays around $5/month).
- **Adjust Container Resources**: Choose from 3 task definitions (`light`, `standard`, `power`) based on user needs to optimize EC2 spending.
- **Single EFS**: Minimizes fixed costs as multiple users share a single EFS with directory-level isolation.
- **Deactivate Cognito Users**: Instantly stop inactive accounts in Cognito to prevent unnecessary resource allocation.
