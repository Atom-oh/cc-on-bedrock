OpenAI Codex v0.116.0 (research preview)
--------
workdir: /home/ec2-user/cc-on-bedrock
model: gpt-5.4
provider: openai
approval: never
sandbox: workspace-write [workdir, /tmp, $TMPDIR, /home/ec2-user/.codex/memories]
reasoning effort: none
reasoning summaries: none
session id: 019d2767-7687-7ab1-a2a1-d5978afda85d
--------
user
You are a senior cloud security architect. Review this project (CC-on-Bedrock) for: 1) Hardcoded AWS account IDs, region values, IP addresses, ARNs, or environment-specific values that should be parameterized - check CDK, Terraform, CloudFormation, and Docker files. 2) Security vulnerabilities: overly permissive IAM policies (wildcard permissions), missing encryption, exposed secrets/API keys/credentials, missing security group restrictions, CloudFront/ALB misconfigurations, DLP policy weaknesses, container security issues in Dockerfiles. 3) Sensitive data exposure: accidentally committed secrets, .env files, or credentials. Output findings in markdown with severity ratings (Critical/High/Medium/Low) for each issue. Include file paths and line references.
warning: Codex could not find system bubblewrap at /usr/bin/bwrap. Please install bubblewrap with your package manager. Codex will use the vendored bubblewrap in the meantime.
mcp startup: no servers
codex
Reviewing the repo for environment-specific hardcoding, security weaknesses, and exposed sensitive data. I’m starting by inventorying infrastructure and container-related files, then I’ll inspect IAM, networking, encryption, and any checked-in secrets with line-level references.
exec
/bin/bash -lc "rg --files -g '"'!*node_modules*'"' -g '"'!*.git*'"' | rg '("'^|/)(cdk|terraform|tf|cloudformation|docker|Dockerfile|docker-compose|compose|template|templates|yaml|yml|json|env|'"\\.env|policy|policies)'" in /home/ec2-user/cc-on-bedrock succeeded in 0ms:
tests/docker/test-scripts.sh
tests/docker/test-litellm.sh
tests/docker/test-devenv.sh
terraform/variables.tf
terraform/terraform.tfvars.example
terraform/providers.tf
terraform/outputs.tf
terraform/modules/security/variables.tf
terraform/modules/security/outputs.tf
terraform/modules/security/main.tf
terraform/modules/network/variables.tf
terraform/modules/network/outputs.tf
terraform/modules/network/main.tf
terraform/modules/litellm/variables.tf
terraform/modules/litellm/outputs.tf
terraform/modules/litellm/main.tf
terraform/modules/ecs-devenv/variables.tf
terraform/modules/ecs-devenv/outputs.tf
terraform/modules/ecs-devenv/main.tf
terraform/modules/dashboard/variables.tf
exec
/bin/bash -lc "rg -n --hidden -g '"'!*node_modules*'"' -g '"'!*.git*'"' -e 'AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|aws_secret_access_key|BEGIN RSA PRIVATE KEY|BEGIN PRIVATE KEY|xox[baprs]-|AIza[0-9A-Za-z\\-_]{35}|ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]+|-----BEGIN' ." in /home/ec2-user/cc-on-bedrock exited 1 in 0ms:

exec
/bin/bash -lc "rg -n --hidden -g '"'!*node_modules*'"' -g '"'!*.git*'"' -e '\\b(arn:aws[a-z-]*:["'^'"\\s\"'\"'\"'<>]+|[0-9]{12}|([0-9]{1,3}\\.){3}[0-9]{1,3}|us-east-1|us-west-2|eu-west-1|ap-southeast-1)\\b' ." in /home/ec2-user/cc-on-bedrock succeeded in 0ms:
./terraform/variables.tf:21:  default     = "10.0.0.0/16"
./terraform/variables.tf:26:  default = "10.0.1.0/24"
./terraform/variables.tf:31:  default = "10.0.2.0/24"
./terraform/variables.tf:36:  default = "10.0.16.0/20"
./terraform/variables.tf:41:  default = "10.0.32.0/20"
./terraform/variables.tf:46:  default = "10.0.100.0/23"
./terraform/variables.tf:51:  default = "10.0.102.0/23"
./terraform/terraform.tfvars.example:8:vpc_cidr              = "10.0.0.0/16"
./terraform/terraform.tfvars.example:9:public_subnet_cidr_a  = "10.0.1.0/24"
./terraform/terraform.tfvars.example:10:public_subnet_cidr_c  = "10.0.2.0/24"
./terraform/terraform.tfvars.example:11:private_subnet_cidr_a = "10.0.16.0/20"
./terraform/terraform.tfvars.example:12:private_subnet_cidr_c = "10.0.32.0/20"
./terraform/terraform.tfvars.example:13:isolated_subnet_cidr_a = "10.0.100.0/23"
./terraform/terraform.tfvars.example:14:isolated_subnet_cidr_c = "10.0.102.0/23"
./terraform/modules/security/main.tf:258:  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
./terraform/modules/security/main.tf:263:  policy_arn = "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly"
./terraform/modules/security/main.tf:275:    resources = ["arn:aws:secretsmanager:*:${data.aws_caller_identity.current.account_id}:secret:cc-on-bedrock/*"]
./terraform/modules/security/main.tf:298:  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
./terraform/modules/security/main.tf:328:      "arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/cc-on-bedrock-ecs-task",
./terraform/modules/security/main.tf:329:      "arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/cc-on-bedrock-ecs-task-execution",
codex
The first pass already surfaced concrete hardcoded account/region values and several `0.0.0.0/0` rules. I’m reading the infrastructure definitions directly now to confirm which are real security findings versus expected defaults or documentation-only examples.
exec
/bin/bash -lc "nl -ba cdk/config/default.ts | sed -n '1,220p'" in /home/ec2-user/cc-on-bedrock succeeded in 0ms:
     1	export interface CcOnBedrockConfig {
     2	  // Network
     3	  vpcName: string;
     4	  vpcCidr: string;
     5	  publicSubnetCidrA: string;
     6	  publicSubnetCidrC: string;
     7	  privateSubnetCidrA: string;
     8	  privateSubnetCidrC: string;
     9	  isolatedSubnetCidrA: string;
    10	  isolatedSubnetCidrC: string;
    11	
    12	  // Domain
    13	  domainName: string;
    14	  devSubdomain: string;
    15	
    16	  // Models
    17	  opusModelId: string;
    18	  sonnetModelId: string;
    19	
    20	  // Compute (LiteLLM removed - direct Bedrock access)
exec
/bin/bash -lc "nl -ba cdk/lib/05-dashboard-stack.ts | sed -n '100,170p'" in /home/ec2-user/cc-on-bedrock succeeded in 0ms:
   100	        deviceName: '/dev/xvda',
   101	        volume: ec2.BlockDeviceVolume.ebs(30, {
   102	          volumeType: ec2.EbsDeviceVolumeType.GP3,
   103	          encrypted: true,
   104	        }),
   105	      }],
   106	      userData: ec2.UserData.custom([
   107	        '#!/bin/bash',
   108	        'set -euo pipefail',
   109	        '',
   110	        '# Install Node.js 20 (direct binary)',
   111	        'ARCH=$(uname -m)',
   112	        'if [ "$ARCH" = "aarch64" ]; then NODE_ARCH="arm64"; else NODE_ARCH="x64"; fi',
   113	        'curl -fsSL "https://nodejs.org/dist/v20.18.3/node-v20.18.3-linux-${NODE_ARCH}.tar.gz" -o /tmp/node.tar.gz',
   114	        'tar -xzf /tmp/node.tar.gz -C /usr/local --strip-components=1',
   115	        'rm /tmp/node.tar.gz',
   116	        '',
   117	        '# Install PM2',
   118	        'npm install -g pm2',
   119	        '',
exec
/bin/bash -lc "nl -ba cdk/cdk.context.json | sed -n '1,120p'" in /home/ec2-user/cc-on-bedrock succeeded in 0ms:
     1	{
     2	  "availability-zones:account=061525506239:region=ap-northeast-2": [
     3	    "ap-northeast-2a",
     4	    "ap-northeast-2b",
     5	    "ap-northeast-2c",
     6	    "ap-northeast-2d"
     7	  ]
     8	}
exec
/bin/bash -lc "nl -ba shared/nextjs-app/src/lib/aws-clients.ts | sed -n '1,340p'" in /home/ec2-user/cc-on-bedrock succeeded in 0ms:
     1	import {
     2	  CognitoIdentityProviderClient,
     3	  AdminCreateUserCommand,
     4	  AdminDeleteUserCommand,
     5	  AdminDisableUserCommand,
     6	  AdminEnableUserCommand,
     7	  AdminGetUserCommand,
     8	  AdminUpdateUserAttributesCommand,
     9	  AdminAddUserToGroupCommand,
    10	  ListUsersCommand,
    11	  type AttributeType,
    12	} from "@aws-sdk/client-cognito-identity-provider";
    13	import {
    14	  ECSClient,
    15	  RunTaskCommand,
    16	  StopTaskCommand,
    17	  DescribeTasksCommand,
    18	  ListTasksCommand,
    19	} from "@aws-sdk/client-ecs";
    20	import {
exec
/bin/bash -lc "nl -ba agent/lambda/create_targets.py | sed -n '1,230p'" in /home/ec2-user/cc-on-bedrock succeeded in 0ms:
     1	"""
     2	Create CC-on-Bedrock Gateway + Lambda Targets
     3	Usage: ACCOUNT_ID=061525506239 python3 agent/lambda/create_targets.py
     4	
     5	1. Creates 3 Lambda functions (cc-ecs-mcp, cc-cloudwatch-mcp, cc-dynamodb-mcp)
     6	2. Creates Gateway (cconbedrock-gateway)
     7	3. Registers Lambda targets on Gateway
     8	"""
     9	import boto3
    10	import json
    11	import os
    12	import sys
    13	import zipfile
    14	import io
    15	import time
    16	
    17	REGION = os.environ.get("REGION", "ap-northeast-2")
    18	ACCOUNT_ID = os.environ.get("ACCOUNT_ID", "061525506239")
    19	LAMBDA_ROLE = os.environ.get("LAMBDA_ROLE", f"arn:aws:iam::{ACCOUNT_ID}:role/cc-on-bedrock-agentcore-lambda")
    20	GATEWAY_ROLE = os.environ.get("GATEWAY_ROLE", f"arn:aws:iam::{ACCOUNT_ID}:role/cc-on-bedrock-agentcore-gateway")
exec
/bin/bash -lc "nl -ba shared/nextjs-app/src/app/api/ai/runtime/route.ts | sed -n '1,120p'" in /home/ec2-user/cc-on-bedrock succeeded in 0ms:
     1	/**
     2	 * AI Assistant Runtime API Route (for Slack / External clients)
     3	 * Architecture: Client → InvokeAgentRuntime → Gateway (MCP) → Lambda Tools
     4	 *
     5	 * This endpoint is for external integrations (Slack, CLI, API clients).
     6	 * Dashboard uses /api/ai (Converse API direct) for faster streaming.
     7	 */
     8	import { NextRequest, NextResponse } from "next/server";
     9	import {
    10	  BedrockAgentCoreClient,
    11	  InvokeAgentRuntimeCommand,
    12	} from "@aws-sdk/client-bedrock-agentcore";
    13	
    14	const region = process.env.AWS_REGION ?? "ap-northeast-2";
    15	const RUNTIME_ARN = process.env.AGENTCORE_RUNTIME_ARN
    16	  ?? "arn:aws:bedrock-agentcore:ap-northeast-2:061525506239:runtime/cconbedrock_assistant_v2-Rpg8UUGdQt";
    17	const GATEWAY_URL = process.env.AGENTCORE_GATEWAY_URL
    18	  ?? "https://cconbedrock-gateway-u1p3qlbsz6.gateway.bedrock-agentcore.ap-northeast-2.amazonaws.com/mcp";
    19	
    20	function getClient() {
exec
/bin/bash -lc "nl -ba cdk/lib/02-security-stack.ts | sed -n '1,280p'" in /home/ec2-user/cc-on-bedrock succeeded in 0ms:
     1	import * as cdk from 'aws-cdk-lib';
     2	import * as cognito from 'aws-cdk-lib/aws-cognito';
     3	
     4	import * as kms from 'aws-cdk-lib/aws-kms';
     5	import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
     6	import * as iam from 'aws-cdk-lib/aws-iam';
     7	import * as route53 from 'aws-cdk-lib/aws-route53';
     8	import { Construct } from 'constructs';
     9	import { CcOnBedrockConfig } from '../config/default';
    10	
    11	export interface SecurityStackProps extends cdk.StackProps {
    12	  config: CcOnBedrockConfig;
    13	  hostedZone: route53.IHostedZone;
    14	}
    15	
    16	export class SecurityStack extends cdk.Stack {
    17	  public readonly userPool: cognito.UserPool;
    18	  public readonly userPoolClient: cognito.UserPoolClient;
    19	  public readonly encryptionKey: kms.Key;
    20	  // TODO: Remove litellmMasterKeySecret, valkeyAuthSecret, and litellmEc2Role
exec
/bin/bash -lc "nl -ba cdk/lib/04-ecs-devenv-stack.ts | sed -n '1,420p'" in /home/ec2-user/cc-on-bedrock succeeded in 0ms:
     1	import * as cdk from 'aws-cdk-lib';
     2	import * as ec2 from 'aws-cdk-lib/aws-ec2';
     3	import * as ecs from 'aws-cdk-lib/aws-ecs';
     4	import * as efs from 'aws-cdk-lib/aws-efs';
     5	import * as ecr from 'aws-cdk-lib/aws-ecr';
     6	import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
     7	import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
     8	import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
     9	import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
    10	import * as route53 from 'aws-cdk-lib/aws-route53';
    11	import * as route53targets from 'aws-cdk-lib/aws-route53-targets';
    12	import * as acm from 'aws-cdk-lib/aws-certificatemanager';
    13	import * as iam from 'aws-cdk-lib/aws-iam';
    14	import * as kms from 'aws-cdk-lib/aws-kms';
    15	import * as logs from 'aws-cdk-lib/aws-logs';
    16	import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
    17	import { Construct } from 'constructs';
    18	import { CcOnBedrockConfig } from '../config/default';
    19	
    20	export interface EcsDevenvStackProps extends cdk.StackProps {
exec
/bin/bash -lc "nl -ba terraform/modules/litellm/main.tf | sed -n '1,320p'" in /home/ec2-user/cc-on-bedrock succeeded in 0ms:
     1	###############################################################################
     2	# LiteLLM Module - Internal ALB, ASG, RDS PostgreSQL, Serverless Valkey, ECR
     3	# Equivalent to cdk/lib/03-litellm-stack.ts
     4	###############################################################################
     5	
     6	data "aws_caller_identity" "current" {}
     7	data "aws_region" "current" {}
     8	
     9	# ---- RDS Credentials (created here to match CDK's cross-stack pattern) -------
    10	resource "random_password" "rds_password" {
    11	  length  = 24
    12	  special = false
    13	}
    14	
    15	resource "aws_secretsmanager_secret" "rds_credentials" {
    16	  name = "cc-on-bedrock/rds-credentials"
    17	}
    18	
    19	resource "aws_secretsmanager_secret_version" "rds_credentials" {
    20	  secret_id = aws_secretsmanager_secret.rds_credentials.id
exec
/bin/bash -lc "nl -ba cdk/lib/03-usage-tracking-stack.ts | sed -n '1,260p'" in /home/ec2-user/cc-on-bedrock succeeded in 0ms:
     1	import * as cdk from 'aws-cdk-lib';
     2	import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
     3	import * as lambda from 'aws-cdk-lib/aws-lambda';
     4	import * as events from 'aws-cdk-lib/aws-events';
     5	import * as targets from 'aws-cdk-lib/aws-events-targets';
     6	import * as iam from 'aws-cdk-lib/aws-iam';
     7	import * as kms from 'aws-cdk-lib/aws-kms';
     8	import * as cognito from 'aws-cdk-lib/aws-cognito';
     9	import * as sns from 'aws-cdk-lib/aws-sns';
    10	import * as logs from 'aws-cdk-lib/aws-logs';
    11	import { Construct } from 'constructs';
    12	import { CcOnBedrockConfig } from '../config/default';
    13	import * as path from 'path';
    14	
    15	export interface UsageTrackingStackProps extends cdk.StackProps {
    16	  config: CcOnBedrockConfig;
    17	  encryptionKey: kms.Key;
    18	  userPool: cognito.UserPool;
    19	}
    20	
exec
/bin/bash -lc "nl -ba terraform/modules/security/main.tf | sed -n '1,380p'" in /home/ec2-user/cc-on-bedrock succeeded in 0ms:
     1	###############################################################################
     2	# Security Module - Cognito, ACM, KMS, Secrets Manager, IAM
     3	# Equivalent to cdk/lib/02-security-stack.ts
     4	###############################################################################
     5	
     6	data "aws_caller_identity" "current" {}
     7	data "aws_region" "current" {}
     8	
     9	locals {
    10	  dev_domain       = "*.${var.dev_subdomain}.${var.domain_name}"
    11	  dashboard_domain = "dashboard.${var.domain_name}"
    12	}
    13	
    14	# ---- KMS Encryption Key -----------------------------------------------------
    15	resource "aws_kms_key" "this" {
    16	  description         = "CC-on-Bedrock encryption key for EBS, RDS, EFS"
    17	  enable_key_rotation = true
    18	}
    19	
    20	resource "aws_kms_alias" "this" {
exec
/bin/bash -lc "nl -ba terraform/modules/ecs-devenv/main.tf | sed -n '1,430p'" in /home/ec2-user/cc-on-bedrock succeeded in 0ms:
     1	###############################################################################
     2	# ECS DevEnv Module - Cluster, Task Definitions, EFS, ALB, CloudFront, DLP SGs
     3	# Equivalent to cdk/lib/04-ecs-devenv-stack.ts
     4	###############################################################################
     5	
     6	data "aws_caller_identity" "current" {}
     7	data "aws_region" "current" {}
     8	
     9	# ---- IAM: ECS Task Role (created here to match CDK pattern) -----------------
    10	data "aws_iam_policy_document" "ecs_tasks_assume" {
    11	  statement {
    12	    actions = ["sts:AssumeRole"]
    13	    principals {
    14	      type        = "Service"
    15	      identifiers = ["ecs-tasks.amazonaws.com"]
    16	    }
    17	  }
    18	}
    19	
    20	resource "aws_iam_role" "ecs_task" {
codex
I’ve confirmed several findings across CDK and Terraform. Next I’m checking the CloudFormation equivalents, Dockerfiles, and any checked-in env files so the report covers all requested surfaces instead of only one IaC implementation.
exec
/bin/bash -lc "find . -path '*/node_modules' -prune -o \\( -name '.env' -o -name '.env.*' -o -name '*.pem' -o -name '*.key' -o -name '*credentials*' -o -name 'id_rsa' \\) -print" in /home/ec2-user/cc-on-bedrock succeeded in 0ms:
./shared/nextjs-app/.env.example
exec
/bin/bash -lc "nl -ba cloudformation/02-security.yaml | sed -n '1,340p'" in /home/ec2-user/cc-on-bedrock succeeded in 0ms:
     1	AWSTemplateFormatVersion: '2010-09-09'
     2	Description: >-
     3	  CC-on-Bedrock Security Stack - Cognito, ACM, KMS, Secrets Manager, IAM.
     4	  Equivalent to cdk/lib/02-security-stack.ts and terraform/modules/security.
     5	
     6	Parameters:
     7	  DomainName:
     8	    Type: String
     9	    Default: example.com
    10	  DevSubdomain:
    11	    Type: String
    12	    Default: dev
    13	  HostedZoneId:
    14	    Type: String
    15	    Description: Route 53 Hosted Zone ID (from 01-network stack)
    16	
    17	Resources:
    18	  # ---------- KMS Encryption Key -----------------------------------------------
    19	  EncryptionKey:
    20	    Type: AWS::KMS::Key
exec
/bin/bash -lc "nl -ba cloudformation/04-ecs-devenv.yaml | sed -n '1,420p'" in /home/ec2-user/cc-on-bedrock succeeded in 0ms:
     1	AWSTemplateFormatVersion: '2010-09-09'
     2	Description: >-
     3	  CC-on-Bedrock ECS DevEnv Stack - Cluster, Task Definitions, EFS, ALB, CloudFront, DLP SGs.
     4	  Equivalent to cdk/lib/04-ecs-devenv-stack.ts and terraform/modules/ecs-devenv.
     5	
     6	Parameters:
     7	  VpcId:
     8	    Type: AWS::EC2::VPC::Id
     9	  VpcCidr:
    10	    Type: String
    11	  PublicSubnetAId:
    12	    Type: AWS::EC2::Subnet::Id
    13	  PublicSubnetCId:
    14	    Type: AWS::EC2::Subnet::Id
    15	  PrivateSubnetAId:
    16	    Type: AWS::EC2::Subnet::Id
    17	  PrivateSubnetCId:
    18	    Type: AWS::EC2::Subnet::Id
    19	  IsolatedSubnetAId:
    20	    Type: AWS::EC2::Subnet::Id
exec
/bin/bash -lc "nl -ba cloudformation/03-litellm.yaml | sed -n '1,340p'" in /home/ec2-user/cc-on-bedrock succeeded in 0ms:
     1	AWSTemplateFormatVersion: '2010-09-09'
     2	Description: >-
     3	  CC-on-Bedrock LiteLLM Stack - Internal ALB, ASG, RDS PostgreSQL, Serverless Valkey, ECR.
     4	  Equivalent to cdk/lib/03-litellm-stack.ts and terraform/modules/litellm.
     5	
     6	Parameters:
     7	  VpcId:
     8	    Type: AWS::EC2::VPC::Id
     9	  VpcCidr:
    10	    Type: String
    11	  PrivateSubnetAId:
    12	    Type: AWS::EC2::Subnet::Id
    13	  PrivateSubnetCId:
    14	    Type: AWS::EC2::Subnet::Id
    15	  IsolatedSubnetAId:
    16	    Type: AWS::EC2::Subnet::Id
    17	  IsolatedSubnetCId:
    18	    Type: AWS::EC2::Subnet::Id
    19	  KmsKeyArn:
    20	    Type: String
exec
/bin/bash -lc "nl -ba cloudformation/05-dashboard.yaml | sed -n '1,320p'" in /home/ec2-user/cc-on-bedrock succeeded in 0ms:
     1	AWSTemplateFormatVersion: '2010-09-09'
     2	Description: >-
     3	  CC-on-Bedrock Dashboard Stack - EC2 ASG, ALB, CloudFront, Route 53.
     4	  Equivalent to cdk/lib/05-dashboard-stack.ts and terraform/modules/dashboard.
     5	
     6	Parameters:
     7	  VpcId:
     8	    Type: AWS::EC2::VPC::Id
     9	  VpcCidr:
    10	    Type: String
    11	  PublicSubnetAId:
    12	    Type: AWS::EC2::Subnet::Id
    13	  PublicSubnetCId:
    14	    Type: AWS::EC2::Subnet::Id
    15	  PrivateSubnetAId:
    16	    Type: AWS::EC2::Subnet::Id
    17	  PrivateSubnetCId:
    18	    Type: AWS::EC2::Subnet::Id
    19	  KmsKeyArn:
    20	    Type: String
exec
/bin/bash -lc 'for f in agent/Dockerfile docker/litellm/Dockerfile docker/devenv/Dockerfile.ubuntu docker/devenv/Dockerfile.al2023; do echo "FILE:$f"; nl -ba "$f"; done' in /home/ec2-user/cc-on-bedrock succeeded in 0ms:
FILE:agent/Dockerfile
     1	FROM python:3.11-slim
     2	
     3	WORKDIR /app
     4	
     5	RUN apt-get update && apt-get install -y --no-install-recommends gcc && rm -rf /var/lib/apt/lists/*
     6	
     7	RUN pip install --no-cache-dir \
     8	    strands-agents \
     9	    strands-agents-tools \
    10	    boto3 \
    11	    "bedrock-agentcore<=0.1.5" \
    12	    mcp \
    13	    httpx \
    14	    httpx-sse \
    15	    aws-requests-auth
    16	
    17	COPY streamable_http_sigv4.py .
    18	COPY agent.py .
    19	
exec
/bin/bash -lc "nl -ba docker/devenv/scripts/entrypoint.sh | sed -n '1,260p'" in /home/ec2-user/cc-on-bedrock succeeded in 0ms:
     1	#!/bin/bash
     2	set -euo pipefail
     3	
     4	echo "=== CC-on-Bedrock Devenv Container Starting ==="
     5	
     6	USER_HOME="/home/coder"
     7	SECURITY_POLICY="${SECURITY_POLICY:-open}"
     8	SUBDOMAIN="${USER_SUBDOMAIN:-default}"
     9	
    10	# --- Per-user EFS directory isolation ---
    11	# EFS is mounted at /home/coder (shared root).
    12	# Each user gets their own subdirectory: /home/coder/users/{subdomain}/
    13	# code-server workspace points to the user's directory.
    14	EFS_USER_DIR="$USER_HOME/users/$SUBDOMAIN"
    15	USER_WORKSPACE="$EFS_USER_DIR/workspace"
    16	USER_DATA_DIR="$EFS_USER_DIR/.local/share/code-server"
    17	USER_CONFIG_DIR="$EFS_USER_DIR/.config"
    18	
    19	echo "Setting up user directory: $EFS_USER_DIR"
    20	
exec
/bin/bash -lc "nl -ba shared/nextjs-app/.env.example | sed -n '1,220p'" in /home/ec2-user/cc-on-bedrock succeeded in 0ms:
     1	# NextAuth
     2	NEXTAUTH_URL=https://dashboard.example.com
     3	NEXTAUTH_SECRET=your-nextauth-secret-here
     4	
     5	# Cognito
     6	COGNITO_CLIENT_ID=your-cognito-client-id
     7	COGNITO_CLIENT_SECRET=your-cognito-client-secret
     8	COGNITO_ISSUER=https://cognito-idp.ap-northeast-2.amazonaws.com/ap-northeast-2_XXXXXXXXX
     9	
    10	# LiteLLM
    11	LITELLM_API_URL=http://litellm-internal-alb.example.com:4000
    12	LITELLM_MASTER_KEY=sk-litellm-master-key
    13	
    14	# AWS
    15	AWS_REGION=ap-northeast-2
    16	ECS_CLUSTER_NAME=cc-on-bedrock-cluster
    17	COGNITO_USER_POOL_ID=ap-northeast-2_XXXXXXXXX
    18	
    19	# Domain
    20	DOMAIN_NAME=example.com
exec
/bin/bash -lc "nl -ba docker/devenv/scripts/setup-common.sh | sed -n '1,320p'" in /home/ec2-user/cc-on-bedrock succeeded in 0ms:
     1	#!/bin/bash
     2	set -euo pipefail
     3	
     4	echo "=== CC-on-Bedrock Devenv: Common Setup ==="
     5	
     6	# Detect OS
     7	if [ -f /etc/os-release ]; then
     8	  . /etc/os-release
     9	  OS_ID="$ID"
    10	else
    11	  echo "ERROR: Cannot detect OS"
    12	  exit 1
    13	fi
    14	
    15	echo "Detected OS: $OS_ID"
    16	
    17	# --- Package Manager Setup ---
    18	install_packages() {
    19	  case "$OS_ID" in
    20	    ubuntu)
exec
/bin/bash -lc "nl -ba docker/litellm/scripts/entrypoint.sh | sed -n '1,260p'" in /home/ec2-user/cc-on-bedrock succeeded in 0ms:
     1	#!/bin/bash
     2	set -euo pipefail
     3	
     4	echo "=== CC-on-Bedrock LiteLLM Proxy Starting ==="
     5	
     6	CONFIG_FILE="/app/litellm-config.yaml"
     7	REGION="${AWS_DEFAULT_REGION:-ap-northeast-2}"
     8	
     9	# --- Fetch secrets from Secrets Manager (if ARNs provided) ---
    10	fetch_secret() {
    11	  local secret_id="$1"
    12	  aws secretsmanager get-secret-value \
    13	    --secret-id "$secret_id" \
    14	    --region "$REGION" \
    15	    --query 'SecretString' \
    16	    --output text 2>/dev/null
    17	}
    18	
    19	if [ -n "${LITELLM_MASTER_KEY_SECRET_ARN:-}" ]; then
    20	  export LITELLM_MASTER_KEY=$(fetch_secret "$LITELLM_MASTER_KEY_SECRET_ARN")
exec
/bin/bash -lc "rg -n --hidden -g '"'!*node_modules*'"' -g '"'!*.git*'"' -e 'password|secret|token|api[_-]?key|private[_-]?key|access[_-]?key' shared/nextjs-app agent docker cdk terraform cloudformation" in /home/ec2-user/cc-on-bedrock succeeded in 0ms:
terraform/modules/security/outputs.tf:29:output "litellm_master_key_secret_arn" {
terraform/modules/security/outputs.tf:30:  value = aws_secretsmanager_secret.litellm_master_key.arn
terraform/modules/security/outputs.tf:33:output "cloudfront_secret_arn" {
terraform/modules/security/outputs.tf:34:  value = aws_secretsmanager_secret.cloudfront_secret.arn
terraform/modules/security/outputs.tf:37:output "cloudfront_secret_value" {
terraform/modules/security/outputs.tf:38:  value     = random_password.cloudfront_secret.result
terraform/modules/security/outputs.tf:42:output "valkey_auth_secret_arn" {
terraform/modules/security/outputs.tf:43:  value = aws_secretsmanager_secret.valkey_auth.arn
terraform/modules/security/main.tf:31:  password_policy {
terraform/modules/security/main.tf:36:    temporary_password_validity_days = 7
terraform/modules/security/main.tf:68:    name                = "litellm_api_key"
terraform/modules/security/main.tf:187:resource "random_password" "litellm_master_key" {
terraform/modules/security/main.tf:192:resource "aws_secretsmanager_secret" "litellm_master_key" {
terraform/modules/security/main.tf:196:resource "aws_secretsmanager_secret_version" "litellm_master_key" {
terraform/modules/security/main.tf:197:  secret_id     = aws_secretsmanager_secret.litellm_master_key.id
terraform/modules/security/main.tf:198:  secret_string = random_password.litellm_master_key.result
terraform/modules/security/main.tf:201:resource "random_password" "cloudfront_secret" {
terraform/modules/security/main.tf:206:resource "aws_secretsmanager_secret" "cloudfront_secret" {
terraform/modules/security/main.tf:207:  name = "cc-on-bedrock/cloudfront-secret"
terraform/modules/security/main.tf:210:resource "aws_secretsmanager_secret_version" "cloudfront_secret" {
codex
The repo doesn’t appear to have committed live credentials or `.env` files beyond `.env.example`, which is good. I did find potential secret exposure through Terraform outputs and several auth/network control gaps, so I’m validating those before I write the report.
exec
/bin/bash -lc "nl -ba terraform/modules/security/outputs.tf | sed -n '1,120p'" in /home/ec2-user/cc-on-bedrock succeeded in 0ms:
     1	output "user_pool_id" {
     2	  value = aws_cognito_user_pool.this.id
     3	}
     4	
     5	output "user_pool_arn" {
     6	  value = aws_cognito_user_pool.this.arn
     7	}
     8	
     9	output "user_pool_client_id" {
    10	  value = aws_cognito_user_pool_client.this.id
    11	}
    12	
    13	output "devenv_certificate_arn" {
    14	  value = aws_acm_certificate.devenv.arn
    15	}
    16	
    17	output "dashboard_certificate_arn" {
    18	  value = aws_acm_certificate.dashboard.arn
    19	}
    20	
exec
/bin/bash -lc "nl -ba cloudformation/05-dashboard.yaml | sed -n '196,236p'" in /home/ec2-user/cc-on-bedrock succeeded in 0ms:
   196	  # ---------- CloudFront Distribution ------------------------------------------
   197	  DashboardCloudFront:
   198	    Type: AWS::CloudFront::Distribution
   199	    Properties:
   200	      DistributionConfig:
   201	        Comment: CC-on-Bedrock Dashboard
   202	        Enabled: true
   203	        Origins:
   204	          - Id: dashboard-alb
   205	            DomainName: !GetAtt DashboardAlb.DNSName
   206	            CustomOriginConfig:
   207	              HTTPPort: 80
   208	              HTTPSPort: 443
   209	              OriginProtocolPolicy: https-only
   210	              OriginSSLProtocols:
   211	                - TLSv1.2
   212	            OriginCustomHeaders:
   213	              - HeaderName: X-Custom-Secret
   214	                HeaderValue: !Sub '{{resolve:secretsmanager:${CloudFrontSecretArn}:SecretString}}'
   215	        DefaultCacheBehavior:
exec
/bin/bash -lc "nl -ba cloudformation/04-ecs-devenv.yaml | sed -n '560,660p'" in /home/ec2-user/cc-on-bedrock succeeded in 0ms:
   560	      LoadBalancerArn: !Ref DevenvAlb
   561	      Port: 443
   562	      Protocol: HTTPS
   563	      Certificates:
   564	        - CertificateArn: !Ref DevEnvCertificateArn
   565	      SslPolicy: ELBSecurityPolicy-TLS13-1-2-2021-06
   566	      DefaultActions:
   567	        - Type: fixed-response
   568	          FixedResponseConfig:
   569	            ContentType: text/plain
   570	            MessageBody: Forbidden
   571	            StatusCode: '403'
   572	
   573	  # ---------- CloudFront Distribution ------------------------------------------
   574	  DevenvCloudFront:
   575	    Type: AWS::CloudFront::Distribution
   576	    Properties:
   577	      DistributionConfig:
   578	        Comment: CC-on-Bedrock Dev Environment
   579	        Enabled: true
exec
/bin/bash -lc "nl -ba cdk/lib/03-litellm-stack.ts | sed -n '1,260p'" in /home/ec2-user/cc-on-bedrock succeeded in 0ms:
     1	import * as cdk from 'aws-cdk-lib';
     2	import * as ec2 from 'aws-cdk-lib/aws-ec2';
     3	import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
     4	import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
     5	import * as rds from 'aws-cdk-lib/aws-rds';
     6	import * as elasticache from 'aws-cdk-lib/aws-elasticache';
     7	import * as ecr from 'aws-cdk-lib/aws-ecr';
     8	import * as iam from 'aws-cdk-lib/aws-iam';
     9	import * as kms from 'aws-cdk-lib/aws-kms';
    10	import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
    11	import { Construct } from 'constructs';
    12	import { CcOnBedrockConfig } from '../config/default';
    13	
    14	export interface LitellmStackProps extends cdk.StackProps {
    15	  config: CcOnBedrockConfig;
    16	  vpc: ec2.Vpc;
    17	  encryptionKey: kms.Key;
    18	  litellmEc2Role: iam.Role;
    19	  litellmMasterKeySecret: secretsmanager.Secret;
    20	  valkeyAuthSecret: secretsmanager.Secret;
exec
/bin/bash -lc "nl -ba terraform/modules/dashboard/main.tf | sed -n '1,280p'" in /home/ec2-user/cc-on-bedrock succeeded in 0ms:
     1	###############################################################################
     2	# Dashboard Module - EC2 ASG, ALB, CloudFront
     3	# Equivalent to cdk/lib/05-dashboard-stack.ts
     4	###############################################################################
     5	
     6	data "aws_region" "current" {}
     7	
     8	# ---- Security Groups ---------------------------------------------------------
     9	resource "aws_security_group" "alb" {
    10	  name_prefix = "cc-dashboard-alb-"
    11	  description = "Dashboard ALB SG"
    12	  vpc_id      = var.vpc_id
    13	
    14	  # CloudFront managed prefix list for ap-northeast-2
    15	  ingress {
    16	    description     = "Allow CloudFront"
    17	    from_port       = 443
    18	    to_port         = 443
    19	    protocol        = "tcp"
    20	    prefix_list_ids = ["pl-22a6434b"]
exec
/bin/bash -lc "nl -ba cdk/lib/05-dashboard-stack.ts | sed -n '1,260p'" in /home/ec2-user/cc-on-bedrock succeeded in 0ms:
     1	import * as cdk from 'aws-cdk-lib';
     2	import * as ec2 from 'aws-cdk-lib/aws-ec2';
     3	import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
     4	import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
     5	import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
     6	import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
     7	import * as route53 from 'aws-cdk-lib/aws-route53';
     8	import * as route53targets from 'aws-cdk-lib/aws-route53-targets';
     9	import * as acm from 'aws-cdk-lib/aws-certificatemanager';
    10	import * as iam from 'aws-cdk-lib/aws-iam';
    11	import * as kms from 'aws-cdk-lib/aws-kms';
    12	import * as cognito from 'aws-cdk-lib/aws-cognito';
    13	import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
    14	import { Construct } from 'constructs';
    15	import { CcOnBedrockConfig } from '../config/default';
    16	
    17	export interface DashboardStackProps extends cdk.StackProps {
    18	  config: CcOnBedrockConfig;
    19	  vpc: ec2.Vpc;
    20	  encryptionKey: kms.Key;
exec
/bin/bash -lc "rg -n 'X-Custom-Secret|cloudfront-secret|CloudFrontSecret' cdk cloudformation terraform shared/nextjs-app" in /home/ec2-user/cc-on-bedrock succeeded in 0ms:
cloudformation/deploy.sh:147:CLOUDFRONT_SECRET_ARN=$(get_output "${STACK_PREFIX}-security" "CloudFrontSecretArn")
cloudformation/deploy.sh:173:    CloudFrontSecretArn="${CLOUDFRONT_SECRET_ARN}" \
cloudformation/deploy.sh:202:    CloudFrontSecretArn="${CLOUDFRONT_SECRET_ARN}" \
cloudformation/05-dashboard.yaml:29:  CloudFrontSecretArn:
cloudformation/05-dashboard.yaml:213:              - HeaderName: X-Custom-Secret
cloudformation/05-dashboard.yaml:214:                HeaderValue: !Sub '{{resolve:secretsmanager:${CloudFrontSecretArn}:SecretString}}'
terraform/modules/security/main.tf:207:  name = "cc-on-bedrock/cloudfront-secret"
cloudformation/04-ecs-devenv.yaml:34:  CloudFrontSecretArn:
cloudformation/04-ecs-devenv.yaml:590:              - HeaderName: X-Custom-Secret
cloudformation/04-ecs-devenv.yaml:591:                HeaderValue: !Sub '{{resolve:secretsmanager:${CloudFrontSecretArn}:SecretString}}'
cdk/lib/05-dashboard-stack.ts:196:            'X-Custom-Secret': cloudfrontSecret.secretValue.unsafeUnwrap(),
cloudformation/02-security.yaml:155:  CloudFrontSecret:
cloudformation/02-security.yaml:158:      Name: cc-on-bedrock/cloudfront-secret
cloudformation/02-security.yaml:315:  CloudFrontSecretArn:
cloudformation/02-security.yaml:317:    Value: !Ref CloudFrontSecret
cloudformation/02-security.yaml:319:      Name: cc-on-bedrock-cloudfront-secret-arn
cdk/lib/02-security-stack.ts:107:    this.cloudfrontSecret = new secretsmanager.Secret(this, 'CloudFrontSecret', {
cdk/lib/02-security-stack.ts:108:      secretName: 'cc-on-bedrock/cloudfront-secret',
terraform/modules/ecs-devenv/main.tf:425:      name  = "X-Custom-Secret"
terraform/modules/dashboard/main.tf:199:      name  = "X-Custom-Secret"
exec
/bin/bash -lc "nl -ba cdk/lib/04-ecs-devenv-stack.ts | sed -n '296,318p'" in /home/ec2-user/cc-on-bedrock succeeded in 0ms:
   296	    });
   297	
   298	    // CloudFront Distribution
   299	    const distribution = new cloudfront.Distribution(this, 'DevenvCf', {
   300	      defaultBehavior: {
   301	        origin: new origins.LoadBalancerV2Origin(this.alb, {
   302	          protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
   303	          httpPort: 80,
   304	        }),
   305	        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
   306	        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
   307	        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
   308	        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
   309	      },
   310	      // Note: CloudFront cert must be in us-east-1, handled separately
   311	      comment: 'CC-on-Bedrock Dev Environment',
   312	    });
   313	
   314	    // Route 53 Wildcard Record
   315	    new route53.ARecord(this, 'DevEnvWildcard', {
exec
/bin/bash -lc "rg -n 'rootDirectory|EFSVolumeConfiguration|efs-workspace|volumeConfigurations|mountPoints|accessPoint|access point' shared/nextjs-app/src/lib/aws-clients.ts shared/nextjs-app/src -g '"'!*.map'"'" in /home/ec2-user/cc-on-bedrock exited 1 in 0ms:

exec
/bin/bash -lc "nl -ba shared/nextjs-app/src/lib/aws-clients.ts | sed -n '316,520p'" in /home/ec2-user/cc-on-bedrock succeeded in 0ms:
   316	export async function startContainer(
   317	  input: StartContainerInput
   318	): Promise<string> {
   319	  const taskDefKey = `${input.containerOs}-${input.resourceTier}`;
   320	  const taskDefinition = TASK_DEFINITION_MAP[taskDefKey];
   321	  if (!taskDefinition) {
   322	    throw new Error(`Invalid container config: ${taskDefKey}`);
   323	  }
   324	
   325	  // Duplicate check: prevent multiple containers for the same user
   326	  const existing = await listContainers();
   327	  const userContainers = existing.filter(
   328	    (c) =>
   329	      (c.username === input.username || c.subdomain === input.subdomain) &&
   330	      (c.status === "RUNNING" || c.status === "PENDING" || c.status === "PROVISIONING")
   331	  );
   332	  if (userContainers.length > 0) {
   333	    throw new Error(
   334	      `User "${input.username}" already has a running container (${userContainers[0].taskId}). Stop it first.`
   335	    );
codex
# Security Review Findings

1. **High** Predictable fallback password for every dev container.
The dashboard injects `CODESERVER_PASSWORD` with a hardcoded default of `CcOnBedrock2026!` whenever the env var is absent, and the container entrypoint uses that password for `code-server` auth. That creates a known shared credential across internet-facing user workspaces.
Files: [aws-clients.ts#L367](\/home\/ec2-user\/cc-on-bedrock\/shared\/nextjs-app\/src\/lib\/aws-clients.ts#L367), [entrypoint.sh#L124](\/home\/ec2-user\/cc-on-bedrock\/docker\/devenv\/scripts\/entrypoint.sh#L124)

2. **High** Runtime API can become unauthenticated if `RUNTIME_API_KEY` is not set.
The route explicitly allows all requests when the API key is unset, while also shipping hardcoded runtime ARN and gateway URL defaults pointing at a real environment. If this endpoint is exposed, it can become an unauthenticated proxy into Bedrock AgentCore.
Files: [route.ts#L15](\/home\/ec2-user\/cc-on-bedrock\/shared\/nextjs-app\/src\/app\/api\/ai\/runtime\/route.ts#L15), [route.ts#L27](\/home\/ec2-user\/cc-on-bedrock\/shared\/nextjs-app\/src\/app\/api\/ai\/runtime\/route.ts#L27)

3. **High** CDK dev environment ALB is publicly reachable over HTTP, bypassing CloudFront controls.
The CDK path allows `0.0.0.0/0` to port 80 on the ALB and configures CloudFront to use `HTTP_ONLY` to the origin. That means the origin can be reached directly without CloudFront/TLS, and the `cloudfrontSecret` passed into the stack is not enforced anywhere in this path.
Files: [04-ecs-devenv-stack.ts#L262](\/home\/ec2-user\/cc-on-bedrock\/cdk\/lib\/04-ecs-devenv-stack.ts#L262), [04-ecs-devenv-stack.ts#L269](\/home\/ec2-user\/cc-on-bedrock\/cdk\/lib\/04-ecs-devenv-stack.ts#L269), [04-ecs-devenv-stack.ts#L301](\/home\/ec2-user\/cc-on-bedrock\/cdk\/lib\/04-ecs-devenv-stack.ts#L301)

4. **High** Dashboard/admin IAM permissions are overly broad.
The dashboard EC2 role can run/stop ECS tasks and manage ALB target groups/rules with `Resource: "*"`, and the CDK dashboard stack adds broad Bedrock, AgentCore, CloudWatch, and security-inspection permissions on `*`. A compromise of the dashboard host would have wide control-plane blast radius.
Files: [02-security-stack.ts#L160](\/home\/ec2-user\/cc-on-bedrock\/cdk\/lib\/02-security-stack.ts#L160), [05-dashboard-stack.ts#L38](\/home\/ec2-user\/cc-on-bedrock\/cdk\/lib\/05-dashboard-stack.ts#L38), [main.tf#L320](\/home\/ec2-user\/cc-on-bedrock\/terraform\/modules\/security\/main.tf#L320), [02-security.yaml#L241](\/home\/ec2-user\/cc-on-bedrock\/cloudformation\/02-security.yaml#L241)

5. **Medium** “Restricted” DLP egress is not actually restricted.
The restricted security group still allows HTTPS to `0.0.0.0/0`, so it is not a whitelist and does not materially prevent data exfiltration over arbitrary TLS destinations.
Files: [04-ecs-devenv-stack.ts#L113](\/home\/ec2-user\/cc-on-bedrock\/cdk\/lib\/04-ecs-devenv-stack.ts#L113), [main.tf#L125](\/home\/ec2-user\/cc-on-bedrock\/terraform\/modules\/ecs-devenv\/main.tf#L125), [04-ecs-devenv.yaml#L136](\/home\/ec2-user\/cc-on-bedrock\/cloudformation\/04-ecs-devenv.yaml#L136)

6. **Medium** Shared EFS is mounted at `/` with no enforced per-user root or access point isolation.
The IaC comments say per-user root override or access points should be used, but the task definitions mount the full filesystem and the `RunTask` call does not override the volume config. The entrypoint only organizes users into subdirectories, which is weaker than real filesystem isolation and risks cross-tenant access.
Files: [04-ecs-devenv-stack.ts#L235](\/home\/ec2-user\/cc-on-bedrock\/cdk\/lib\/04-ecs-devenv-stack.ts#L235), [main.tf#L345](\/home\/ec2-user\/cc-on-bedrock\/terraform\/modules\/ecs-devenv\/main.tf#L345), [04-ecs-devenv.yaml#L325](\/home\/ec2-user\/cc-on-bedrock\/cloudformation\/04-ecs-devenv.yaml#L325), [aws-clients.ts#L343](\/home\/ec2-user\/cc-on-bedrock\/shared\/nextjs-app\/src\/lib\/aws-clients.ts#L343)

7. **Medium** Terraform exposes the CloudFront origin secret through outputs/state.
`cloudfront_secret_value` is marked `sensitive`, but it is still stored in Terraform state and then passed into downstream modules. That increases secret exposure to anyone with state/backend access.
Files: [outputs.tf#L37](\/home\/ec2-user\/cc-on-bedrock\/terraform\/modules\/security\/outputs.tf#L37), [main.tf#L199](\/home\/ec2-user\/cc-on-bedrock\/terraform\/modules\/dashboard\/main.tf#L199)

8. **Low** Multiple hardcoded environment-specific values should be parameterized.
I found hardcoded AWS account IDs, regions, domain names, runtime ARNs, gateway URLs, CIDRs, and bucket names embedded in deployable code and config. These reduce portability and increase the chance of cross-environment mistakes.
Files: [default.ts#L27](\/home\/ec2-user\/cc-on-bedrock\/cdk\/config\/default.ts#L27), [cdk.context.json#L2](\/home\/ec2-user\/cc-on-bedrock\/cdk\/cdk.context.json#L2), [05-dashboard-stack.ts#L122](\/home\/ec2-user\/cc-on-bedrock\/cdk\/lib\/05-dashboard-stack.ts#L122), [create_targets.py#L17](\/home\/ec2-user\/cc-on-bedrock\/agent\/lambda\/create_targets.py#L17), [aws-clients.ts#L47](\/home\/ec2-user\/cc-on-bedrock\/shared\/nextjs-app\/src\/lib\/aws-clients.ts#L47), [route.ts#L14](\/home\/ec2-user\/cc-on-bedrock\/shared\/nextjs-app\/src\/app\/api\/ai\/runtime\/route.ts#L14)

9. **Low** Container hardening is weak in the Docker build path.
The Dockerfiles install unpinned packages from the network at build time, several use `curl | bash`, and none set a non-root `USER`. That is not an immediate compromise by itself, but it increases supply-chain and container breakout risk.
Files: [agent/Dockerfile#L1](\/home\/ec2-user\/cc-on-bedrock\/agent\/Dockerfile#L1), [docker/litellm/Dockerfile#L7](\/home\/ec2-user\/cc-on-bedrock\/docker\/litellm\/Dockerfile#L7), [setup-common.sh#L74](\/home\/ec2-user\/cc-on-bedrock\/docker\/devenv\/scripts\/setup-common.sh#L74), [setup-common.sh#L98](\/home\/ec2-user\/cc-on-bedrock\/docker\/devenv\/scripts\/setup-common.sh#L98)

No confirmed live secrets or credentials appear to be committed in the repo. I only found a placeholder example file at [\.env.example#L1](\/home\/ec2-user\/cc-on-bedrock\/shared\/nextjs-app\/.env.example#L1).
tokens used
104,200
# Security Review Findings

1. **High** Predictable fallback password for every dev container.
The dashboard injects `CODESERVER_PASSWORD` with a hardcoded default of `CcOnBedrock2026!` whenever the env var is absent, and the container entrypoint uses that password for `code-server` auth. That creates a known shared credential across internet-facing user workspaces.
Files: [aws-clients.ts#L367](\/home\/ec2-user\/cc-on-bedrock\/shared\/nextjs-app\/src\/lib\/aws-clients.ts#L367), [entrypoint.sh#L124](\/home\/ec2-user\/cc-on-bedrock\/docker\/devenv\/scripts\/entrypoint.sh#L124)

2. **High** Runtime API can become unauthenticated if `RUNTIME_API_KEY` is not set.
The route explicitly allows all requests when the API key is unset, while also shipping hardcoded runtime ARN and gateway URL defaults pointing at a real environment. If this endpoint is exposed, it can become an unauthenticated proxy into Bedrock AgentCore.
Files: [route.ts#L15](\/home\/ec2-user\/cc-on-bedrock\/shared\/nextjs-app\/src\/app\/api\/ai\/runtime\/route.ts#L15), [route.ts#L27](\/home\/ec2-user\/cc-on-bedrock\/shared\/nextjs-app\/src\/app\/api\/ai\/runtime\/route.ts#L27)

3. **High** CDK dev environment ALB is publicly reachable over HTTP, bypassing CloudFront controls.
The CDK path allows `0.0.0.0/0` to port 80 on the ALB and configures CloudFront to use `HTTP_ONLY` to the origin. That means the origin can be reached directly without CloudFront/TLS, and the `cloudfrontSecret` passed into the stack is not enforced anywhere in this path.
Files: [04-ecs-devenv-stack.ts#L262](\/home\/ec2-user\/cc-on-bedrock\/cdk\/lib\/04-ecs-devenv-stack.ts#L262), [04-ecs-devenv-stack.ts#L269](\/home\/ec2-user\/cc-on-bedrock\/cdk\/lib\/04-ecs-devenv-stack.ts#L269), [04-ecs-devenv-stack.ts#L301](\/home\/ec2-user\/cc-on-bedrock\/cdk\/lib\/04-ecs-devenv-stack.ts#L301)

4. **High** Dashboard/admin IAM permissions are overly broad.
The dashboard EC2 role can run/stop ECS tasks and manage ALB target groups/rules with `Resource: "*"`, and the CDK dashboard stack adds broad Bedrock, AgentCore, CloudWatch, and security-inspection permissions on `*`. A compromise of the dashboard host would have wide control-plane blast radius.
Files: [02-security-stack.ts#L160](\/home\/ec2-user\/cc-on-bedrock\/cdk\/lib\/02-security-stack.ts#L160), [05-dashboard-stack.ts#L38](\/home\/ec2-user\/cc-on-bedrock\/cdk\/lib\/05-dashboard-stack.ts#L38), [main.tf#L320](\/home\/ec2-user\/cc-on-bedrock\/terraform\/modules\/security\/main.tf#L320), [02-security.yaml#L241](\/home\/ec2-user\/cc-on-bedrock\/cloudformation\/02-security.yaml#L241)

5. **Medium** “Restricted” DLP egress is not actually restricted.
The restricted security group still allows HTTPS to `0.0.0.0/0`, so it is not a whitelist and does not materially prevent data exfiltration over arbitrary TLS destinations.
Files: [04-ecs-devenv-stack.ts#L113](\/home\/ec2-user\/cc-on-bedrock\/cdk\/lib\/04-ecs-devenv-stack.ts#L113), [main.tf#L125](\/home\/ec2-user\/cc-on-bedrock\/terraform\/modules\/ecs-devenv\/main.tf#L125), [04-ecs-devenv.yaml#L136](\/home\/ec2-user\/cc-on-bedrock\/cloudformation\/04-ecs-devenv.yaml#L136)

6. **Medium** Shared EFS is mounted at `/` with no enforced per-user root or access point isolation.
The IaC comments say per-user root override or access points should be used, but the task definitions mount the full filesystem and the `RunTask` call does not override the volume config. The entrypoint only organizes users into subdirectories, which is weaker than real filesystem isolation and risks cross-tenant access.
Files: [04-ecs-devenv-stack.ts#L235](\/home\/ec2-user\/cc-on-bedrock\/cdk\/lib\/04-ecs-devenv-stack.ts#L235), [main.tf#L345](\/home\/ec2-user\/cc-on-bedrock\/terraform\/modules\/ecs-devenv\/main.tf#L345), [04-ecs-devenv.yaml#L325](\/home\/ec2-user\/cc-on-bedrock\/cloudformation\/04-ecs-devenv.yaml#L325), [aws-clients.ts#L343](\/home\/ec2-user\/cc-on-bedrock\/shared\/nextjs-app\/src\/lib\/aws-clients.ts#L343)

7. **Medium** Terraform exposes the CloudFront origin secret through outputs/state.
`cloudfront_secret_value` is marked `sensitive`, but it is still stored in Terraform state and then passed into downstream modules. That increases secret exposure to anyone with state/backend access.
Files: [outputs.tf#L37](\/home\/ec2-user\/cc-on-bedrock\/terraform\/modules\/security\/outputs.tf#L37), [main.tf#L199](\/home\/ec2-user\/cc-on-bedrock\/terraform\/modules\/dashboard\/main.tf#L199)

8. **Low** Multiple hardcoded environment-specific values should be parameterized.
I found hardcoded AWS account IDs, regions, domain names, runtime ARNs, gateway URLs, CIDRs, and bucket names embedded in deployable code and config. These reduce portability and increase the chance of cross-environment mistakes.
Files: [default.ts#L27](\/home\/ec2-user\/cc-on-bedrock\/cdk\/config\/default.ts#L27), [cdk.context.json#L2](\/home\/ec2-user\/cc-on-bedrock\/cdk\/cdk.context.json#L2), [05-dashboard-stack.ts#L122](\/home\/ec2-user\/cc-on-bedrock\/cdk\/lib\/05-dashboard-stack.ts#L122), [create_targets.py#L17](\/home\/ec2-user\/cc-on-bedrock\/agent\/lambda\/create_targets.py#L17), [aws-clients.ts#L47](\/home\/ec2-user\/cc-on-bedrock\/shared\/nextjs-app\/src\/lib\/aws-clients.ts#L47), [route.ts#L14](\/home\/ec2-user\/cc-on-bedrock\/shared\/nextjs-app\/src\/app\/api\/ai\/runtime\/route.ts#L14)

9. **Low** Container hardening is weak in the Docker build path.
The Dockerfiles install unpinned packages from the network at build time, several use `curl | bash`, and none set a non-root `USER`. That is not an immediate compromise by itself, but it increases supply-chain and container breakout risk.
Files: [agent/Dockerfile#L1](\/home\/ec2-user\/cc-on-bedrock\/agent\/Dockerfile#L1), [docker/litellm/Dockerfile#L7](\/home\/ec2-user\/cc-on-bedrock\/docker\/litellm\/Dockerfile#L7), [setup-common.sh#L74](\/home\/ec2-user\/cc-on-bedrock\/docker\/devenv\/scripts\/setup-common.sh#L74), [setup-common.sh#L98](\/home\/ec2-user\/cc-on-bedrock\/docker\/devenv\/scripts\/setup-common.sh#L98)

No confirmed live secrets or credentials appear to be committed in the repo. I only found a placeholder example file at [\.env.example#L1](\/home\/ec2-user\/cc-on-bedrock\/shared\/nextjs-app\/.env.example#L1).
