# Deployment Guide

## Prerequisites
- AWS CLI v2.15+, Docker 24+, Node.js 20+
- AWS account with Bedrock model access enabled
- Route 53 hosted zone for custom domain

## Step 1: ECR Repositories
```bash
bash scripts/create-ecr-repos.sh
```

## Step 2: Docker Images
```bash
cd docker && bash build.sh all all   # Build + push (ARM64)
```

## Step 3: Deploy Infrastructure
Choose one IaC tool:

### CDK
```bash
cd cdk && npm install
npx cdk bootstrap aws://<ACCOUNT_ID>/ap-northeast-2
npx cdk deploy --all
```

### Terraform
```bash
cd terraform
cp terraform.tfvars.example terraform.tfvars  # Edit values
terraform init && terraform apply
```

### CloudFormation
```bash
cd cloudformation && bash deploy.sh
```

## Step 4: Verify
```bash
bash scripts/verify-deployment.sh your-domain.com   # 23-item check
```

## Step 5: First User
1. Dashboard → Admin → Users → Create User
2. Dashboard → Admin → Containers → Start Container
3. User accesses `https://<subdomain>.dev.your-domain.com`

## Cost Estimate (20 users, Seoul)
~$1,510-1,540/month (excluding Bedrock usage)
