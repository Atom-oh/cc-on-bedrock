# Deployment Guide

import DeploymentFlow from '@site/src/components/diagrams/DeploymentFlow';
import Screenshot from '@site/src/components/Screenshot';

Explains the overall process and architectural principles for deploying CC-on-Bedrock to your AWS account.

<DeploymentFlow />

## Prerequisites

| Item | Requirements |
|------|----------|
| **AWS Account** | IAM user/role with AdministratorAccess |
| **Node.js** | v20 or later |
| **AWS CDK CLI** | `npm install -g aws-cdk` |
| **Docker** | For building container images (Ubuntu/AL2023) |

## Deployment Step Details

### Step 1: Network Infrastructure (Network)
Set up the VPC and network environment that forms the foundation of security.

- **VPC**: Uses the 10.100.0.0/16 range.
- **Subnets**: Created across 2 Availability Zones (AZ) with Public/Private subnets.
- **Security**: Communicates with AWS services through VPC Endpoints without traversing the internet.

### Step 2: Security & Authentication (Security)
Deploy Cognito for user authentication and KMS for data encryption.

- **Cognito**: Configure User Pool and Hosted UI for multi-user logins.
- **IAM Roles**: Prepare foundation for dynamic role creation for individual developer control.

### Step 3: Real-time Usage Tracking System (Usage Tracking)
Build a cost-efficient serverless tracking system.

- **CloudTrail**: Log Bedrock API invocation history.
- **EventBridge**: Detect specific API invocation events and trigger Lambda.
- **DynamoDB**: Store real-time usage data per user.

### Step 4: ECS Developer Environment (DevEnv)
Build the container environment for developers.

- **ECS Cluster**: Create a Fargate or EC2-based cluster.
- **ALB/CloudFront**: Configure subdomain routing for each user.
- **EFS**: Persistent file system for user data storage.

### Step 5: Management Dashboard (Dashboard)
Deploy the Next.js application for centralized management.

- **Frontend**: Next.js-based management UI (Home, Analytics, Users, etc.).
- **Deployment**: Ensure availability via EC2 Auto Scaling Group or ECS.

## Architecture Principles (How it Works)

### 1. User Access Flow
1. User accesses `{user}.dev.domain.com`.
2. **CloudFront** receives the request and verifies **Cognito** authentication.
3. If authenticated, routed to the user's **ECS Task** via **ALB**.
4. User proceeds with development through **code-server** in the browser.

### 2. AI Assistant Invocation Flow
1. **Dashboard App**: Browser → Next.js API → Bedrock Converse API (Direct Role invocation).
2. **Claude Code (CLI)**: Terminal in ECS Task → Task IAM Role → Bedrock API (Direct invocation).
3. **Usage Recording**: Bedrock call occurs → CloudTrail → EventBridge → Lambda → DynamoDB update.

:::tip Infrastructure Choice
This project supports **CDK, Terraform, and CloudFormation**. Refer to the README in each folder (`cdk/`, `terraform/`, `cloudformation/`) to deploy with your preferred tool.
:::
