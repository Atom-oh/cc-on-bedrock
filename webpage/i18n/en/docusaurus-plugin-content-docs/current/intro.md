# Introduction

import Screenshot from '@site/src/components/Screenshot';

**CC-on-Bedrock** is a multi-user Claude Code development platform powered by AWS Bedrock.

It provides each developer with an isolated Claude Code + Kiro environment running on Amazon ECS, with centralized management through a Next.js dashboard. The infrastructure is implemented using three IaC tools: CDK (TypeScript), Terraform (HCL), and CloudFormation (YAML).

<Screenshot 
  src="/img/cconbedrock_arch.png" 
  alt="CC-on-Bedrock Architecture" 
  caption="Full System Architecture: From user access to Bedrock API invocation" 
/>

## Key Features

- **Bedrock Direct Mode**: Claude Code calls Bedrock directly via ECS Task Role (no proxy).
- **Per-user IAM Roles**: Individual budget control with dynamic IAM Deny Policy.
- **Hybrid AI**: Dashboard uses Converse API (fast streaming), Slack uses AgentCore Runtime.
- **7-Layer Security**: CloudFront → ALB → Cognito → Security Groups → VPC Endpoints → DNS Firewall → IAM/DLP.
- **Serverless Tracking**: Low-cost usage tracking via CloudTrail → EventBridge → Lambda → DynamoDB.

## System Configuration Overview

The system consists of 5 core stacks:

1. **Network (01)**: VPC and private network infrastructure.
2. **Security (02)**: Authentication (Cognito), Encryption (KMS), and security management.
3. **Usage Tracking (03)**: Real-time usage tracking and budget control.
4. **ECS DevEnv (04)**: Container environments for developers.
5. **Dashboard (05)**: Next.js web platform for administration and AI assistance.
