# Security and Architectural Review: CC-on-Bedrock

This report outlines the security and architectural findings for the CC-on-Bedrock project, conducted by Gemini.

## Summary Table

| ID | Finding | Severity | Category |
|:---|:---|:---|:---|
| 01 | Cross-User Data Access via Shared UID/EFS | **Critical** | Data Isolation |
| 02 | ALB Open to `0.0.0.0/0` on Port 80 | **High** | Network Security |
| 03 | Missing CloudFront Origin Secret Enforcement | **High** | Infrastructure Security |
| 04 | Permissive IAM Wildcard Permissions (Bedrock) | **High** | IAM |
| 05 | Hardcoded Environment-Specific Values | **Medium** | Configuration |
| 06 | Ineffective DLP Restricted Security Group | **Medium** | DLP / Data Exfiltration |
| 07 | Containers Running as Root | **Medium** | Container Security |
| 08 | Unencrypted CloudFront-to-ALB Communication | **Low** | Encryption in Transit |

---

## Findings Detail

### 01. Cross-User Data Access via Shared UID/EFS
*   **Severity**: **Critical**
*   **Location**: `docker/devenv/scripts/entrypoint.sh`, `cdk/lib/04-ecs-devenv-stack.ts`
*   **Description**: All dev environment containers share the same EFS file system and use the same UID (`coder`) for the `code-server` process. While the entrypoint creates subdirectories per user (`/home/coder/users/{subdomain}`), there is no technical enforcement (UID/GID isolation or EFS Access Points) preventing a user from using the terminal to access, modify, or delete files belonging to other users on the shared mount.
*   **Recommendation**: Use **AWS EFS Access Points** with forced POSIX identities (different UID per user) and set the `rootDirectory` dynamically in the ECS Task Definition at runtime.

### 02. ALB Open to `0.0.0.0/0` on Port 80
*   **Severity**: **High**
*   **Location**: `cdk/lib/04-ecs-devenv-stack.ts` (Line 251)
*   **Description**: The security group for the DevEnv ALB explicitly allows ingress on port 80 from `anyIpv4()`. This exposes the ALB directly to the internet, allowing attackers to bypass CloudFront security controls (e.g., WAF, Geo-blocking).
*   **Recommendation**: Restrict port 80/443 ingress to the CloudFront Managed Prefix List (`pl-22a6434b` for `ap-northeast-2`).

### 03. Missing CloudFront Origin Secret Enforcement
*   **Severity**: **High**
*   **Location**: `cdk/lib/04-ecs-devenv-stack.ts`
*   **Description**: Unlike the Dashboard stack, the DevEnv stack does not implement or enforce a custom header (e.g., `X-Custom-Secret`) check on the ALB. This allows anyone who discovers the ALB DNS name to access the development environments directly without passing through CloudFront.
*   **Recommendation**: Implement a Listener Rule on the ALB that only forwards traffic containing the correct `X-Custom-Secret` header, and return a 403 for all other requests.

### 04. Permissive IAM Wildcard Permissions (Bedrock)
*   **Severity**: **High**
*   **Location**: `cdk/lib/05-dashboard-stack.ts` (Lines 48-70), `cdk/lib/04-ecs-devenv-stack.ts` (Line 158)
*   **Description**: Multiple IAM roles (Dashboard EC2 Role, ECS Instance Role) are granted `bedrock:InvokeModel` with `Resource: "*"`. This violates the principle of least privilege.
*   **Recommendation**: Restrict the `Resource` ARN to the specific Claude 3.5/3.0 model ARNs required for the application.

### 05. Hardcoded Environment-Specific Values
*   **Severity**: **Medium**
*   **Location**: Multiple files (e.g., `shared/nextjs-app/src/lib/aws-clients.ts`, `cdk/lib/05-dashboard-stack.ts`)
*   **Description**: AWS Account ID `061525506239` and region `ap-northeast-2` are hardcoded as defaults or explicitly in infrastructure and application code. This makes the project difficult to deploy in other environments and leaks infrastructure details.
*   **Recommendation**: Parameterize these values using CDK/Terraform variables and inject them via Environment Variables at runtime.

### 06. Ineffective DLP Restricted Security Group
*   **Severity**: **Medium**
*   **Location**: `cdk/lib/04-ecs-devenv-stack.ts` (Line 114)
*   **Description**: The "Restricted" security group allows all outbound HTTPS traffic (`0.0.0.0/0:443`). Since most modern data exfiltration occurs over HTTPS, this rule does not provide meaningful data loss prevention.
*   **Recommendation**: Use a proper whitelist of IP ranges or leverage **AWS Network Firewall** / **Route 53 Resolver DNS Firewall** for domain-level egress control.

### 07. Containers Running as Root
*   **Severity**: **Medium**
*   **Location**: `agent/Dockerfile`, `docker/litellm/Dockerfile`
*   **Description**: Several containers do not specify a non-root `USER` in their Dockerfiles. If an attacker gains shell access or exploits a vulnerability in the application (especially in the Bedrock Agent), they will have root privileges within the container.
*   **Recommendation**: Create a non-privileged user (e.g., `appuser`) and use the `USER` instruction in the Dockerfile.

### 08. Unencrypted CloudFront-to-ALB Communication
*   **Severity**: **Low**
*   **Location**: `cdk/lib/04-ecs-devenv-stack.ts` (Line 280)
*   **Description**: The CloudFront distribution for the dev environment is configured to use `HTTP_ONLY` when communicating with the ALB origin. This means traffic is unencrypted while traversing the AWS network.
*   **Recommendation**: Use `HTTPS_ONLY` for the Origin Protocol Policy and ensure the ALB has a valid ACM certificate.
