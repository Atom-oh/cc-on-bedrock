# Terraform Module

## Role
Terraform HCL로 전체 인프라 배포. **8 modules**, root `main.tf`에서 8개 모두 wire-up.
`-var governance_only=true`로 EC2/ECS DevEnv 스택을 skip하고 Local Governance Mode(ADR-014)만 배포 가능 (CDK `--context governanceOnly=true`와 동등).

## Key Files
- `main.tf` - Root module, 8 모듈 호출 + governance_only conditional
- `variables.tf` - 입력 변수 (CDK `config/default.ts`와 동기)
- `outputs.tf` - 주요 리소스 ID/ARN/URL 출력
- `providers.tf` - AWS provider (ap-northeast-2 default + `aws.us_east_1` alias for WAF/CF)
- `terraform.tfvars.example` - 예제 변수 값 (실배포 환경 매칭)
- `modules/network/` - VPC, Subnets, NAT, VPC Endpoints, Route 53 (lookup/create), DNS Firewall
- `modules/security/` - KMS, Cognito (Hosted UI + AppClient + CliPublicClient), ACM, Secrets Manager, IAM (TaskPermissionBoundary, EcsInfrastructureRole, DashboardEc2Role + 3 managed policies)
- `modules/usage-tracking/` - DynamoDB usage table (+ Streams), 8 추가 DDB 테이블, Lambda (tracker/budget-check/ec2-idle-stop/audit-logger/gateway-manager), Bedrock invocation logging
- `modules/ecs-devenv/` - ECS Cluster + capacity provider, EFS, S3, DLP SGs, ALB, **DevEnv CloudFront** (ADR-016, *.dev.<domain>, WAF 연결)
- `modules/dashboard/` - Dashboard EC2 ASG, ALB, **Dashboard CloudFront** (ADR-016, <dashboard>.<domain>, WAF 연결)
- `modules/waf/` - CLOUDFRONT-scope WebACL (us-east-1, provider alias)
- `modules/ec2-devenv/` - ADR-004 Launch Template + DLP SGs + IAM + `cc-user-instances` DDB
- `modules/local-governance/` - ADR-014 STS Issuer Lambda + Function URL, token-limit-enforcer (usage Stream consumer), limit-reset (cron daily/weekly/monthly), `cc-on-bedrock-limits` DDB

## Plan Sanity
```bash
cd terraform && terraform init && terraform plan
# → Plan: 219 to add (EC2/ECS mode) or 173 (governance_only=true)
```

## Known Gaps vs CDK (parity TODOs)
Code is **deployable** (`terraform plan` succeeds with 0 errors/warnings), but some
deeper CDK constructs are not yet ported:

1. **ECS DevEnv: ALB vs NLB+Nginx** — CDK Stack 04 uses **NLB + Nginx Fargate** for `*.dev.<domain>` host-based routing per user. TF uses a single ALB (working but does not implement per-user subdomain routing). Porting requires Nginx config-gen Lambda + S3 + DDB Streams trigger.
2. **session-validator Lambda@Edge** — CDK 04에 viewer-request Lambda@Edge (NextAuth JWE 쿠키 검증, ADR-013). TF에서는 인증 분기 없는 직통 패스.
3. **ADR-022 UserRoleProvisioner** — CDK Security 스택에 EventBridge `cc-on-bedrock-cognito-user-created` 룰 + Lambda + DLQ + Cognito triggers. TF에 없음 — Local Governance 사용자는 STS Issuer가 lazy create로 처리되므로 deploy 자체에는 영향 없음.
4. **Dashboard ECS Ec2Service** — CDK 05의 ECS Ec2Service는 미포팅. TF는 EC2 ASG + PM2로 placeholder Next.js를 띄움 (Dashboard 컨테이너 배포는 별도 파이프라인 가정).
5. **CliPublicClient OUTPUT export** — CDK는 CFN Output export `cc-cli-public-client-id`. TF는 Output만 제공 (export 개념 없음).

## Commands
```bash
cd terraform && terraform init                                       # Initialize
cd terraform && terraform validate                                   # Validate
cd terraform && terraform fmt -recursive                             # Format
cd terraform && terraform plan                                       # Preview (EC2 mode)
cd terraform && terraform plan -var governance_only=true             # Preview (Local-only)
cd terraform && terraform plan -var hosted_zone_id=Zxxxx              # Reuse existing R53 zone
cd terraform && terraform apply                                       # Deploy
```

## Rules
- `terraform fmt -recursive` 후 커밋
- 모듈 간 의존성은 변수로 전달 (Terraform이 자동 의존성 그래프 구축)
- `terraform.tfvars.example`을 `terraform.tfvars`로 복사 후 값 수정
- CDK와 동일한 인프라를 구현해야 함 — CDK에 새 리소스 추가 시 TF도 반영
- WAF 모듈은 반드시 us-east-1 provider alias (`providers = { aws.us_east_1 = aws.us_east_1 }`) 통해서만 호출
- Lambda 코드는 `cdk/lib/lambda/`를 공유 — `var.lambda_src_dir`로 경로 주입 (별도 복제 금지)
- `cc-routing-table` DDB는 ECS DevEnv 모듈의 Nginx 라우팅 포팅 시 추가 예정 (현재 ec2-idle-stop IAM 정책에 ARN만 참조됨)
