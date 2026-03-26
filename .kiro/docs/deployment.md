# Deployment Guide

## Prerequisites
- AWS CLI v2.15+, Docker 24+, Node.js 20+
- AWS account with Bedrock model access enabled (Opus 4.6, Sonnet 4.6, Haiku 4.5)
- Route 53 hosted zone for custom domain

## Step 1: ECR Repositories
```bash
bash scripts/create-ecr-repos.sh
```

## Step 2: Docker Images
```bash
cd docker && bash build.sh all all   # Build + push (ARM64)
```

## Step 3: Deploy Infrastructure (choose one)
```bash
# CDK
cd cdk && npm install && npx cdk bootstrap aws://<ACCOUNT_ID>/ap-northeast-2
npx cdk deploy --all

# Terraform
cd terraform && cp terraform.tfvars.example terraform.tfvars
terraform init && terraform apply

# CloudFormation
cd cloudformation && bash deploy.sh
```

## Step 4: AgentCore Setup
```bash
ACCOUNT_ID=xxx python3 agent/lambda/create_targets.py
```

## Step 5: Verify
```bash
bash scripts/verify-deployment.sh your-domain.com
```

## Step 6: Test Data (optional)
```bash
bash scripts/create-test-users-30.sh
python3 scripts/generate-usage-data.py
```
