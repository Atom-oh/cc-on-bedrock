# Usage

A guide on how to install and use CC-on-Bedrock.

## 1. Infrastructure Deployment

The system can be deployed using one of three IaC tools.

### AWS CDK (Recommended)
```bash
cd cdk
npm install
npx cdk deploy --all
```

### Terraform
```bash
cd terraform
terraform init
terraform apply
```

### CloudFormation
```bash
cd cloudformation
bash deploy.sh
```

## 2. Using the Dashboard

Once deployed, you can access the following features via the dashboard:

- **AI Assistant**: Conversational AI with fast Bedrock streaming.
- **Analytics**: Cost trends and usage statistics by model, department, and user.
- **Monitoring**: Real-time status of ECS containers (CPU, Memory, Network).
- **Security**: Manage IAM policies, DLP status, and DNS Firewall block logs.
- **User Management**: Add, authorize, and manage users via Cognito.
- **Container Management**: Start/Stop user-specific ECS containers and manage EFS.

## 3. Connecting to the Development Environment

1. Start your container in the **Containers** menu of the dashboard.
2. Connect to your assigned subdomain (e.g., `user1.dev.domain.com`).
3. A web-based VS Code (code-server) environment will launch.
4. Use `claude` or `kiro` commands in the terminal to interact with the AI agents.
