# CC-on-Bedrock 배포 가이드 / Deployment Guide

> 현행 진실은 `docs/decisions/BASELINE.md`와 `docs/architecture.md`이고, 이 가이드는 그 두 문서를 따르는 운영 절차서입니다. 충돌하면 두 문서가 우선합니다.
>
> IaC는 Terraform 단일입니다 (ADR-001: CDK·CloudFormation 폐기). `cdk deploy`, `bash deploy.sh`, stack-NN 이름, LiteLLM, EFS·RDS 경로는 더 이상 없습니다.

## 목차 / Table of Contents

1. [사전 준비 (Prerequisites)](#1-사전-준비-prerequisites)
2. [Docker 이미지 빌드 + ECR 푸시](#2-docker-이미지-빌드--ecr-푸시)
3. [DevEnv AMI 빌드](#3-devenv-ami-빌드)
4. [Terraform 인프라 배포](#4-terraform-인프라-배포)
5. [배포 후 설정 (Post-Deploy)](#5-배포-후-설정-post-deploy)
6. [대시보드 접속](#6-대시보드-접속)
7. [사용자 생성 및 개발환경 시작](#7-사용자-생성-및-개발환경-시작)
8. [문제 해결 (Troubleshooting)](#8-문제-해결-troubleshooting)

---

## 1. 사전 준비 (Prerequisites)

### 필수 도구

| 항목 | 최소 버전 | 설치 확인 |
|------|-----------|-----------|
| AWS 계정 | - | AWS Console 로그인 가능 |
| AWS CLI v2 | 2.15+ | `aws --version` |
| Terraform | 1.5+ | `terraform --version` |
| Docker (Buildx) | 24+ | `docker buildx version` |
| Node.js | 20 LTS | `node --version` |
| jq | 1.6+ | `jq --version` |
| Git | 2.40+ | `git --version` |

> 빠른 점검: `bash scripts/00-check-prerequisites.sh` 로 위 도구/자격 증명을 한 번에 확인할 수 있습니다.

### AWS 계정 설정

1. **IAM 권한**: 배포 IAM 주체에 `AdministratorAccess` 또는 동등 권한이 필요합니다.

2. **도메인 (Route 53)**: Route 53에 호스팅된 도메인이 필요합니다. 외부 도메인을 쓰면 네임서버를 Route 53으로 위임하세요. 호스팅 영역은 `module.network` 가 참조/관리합니다.

3. **Bedrock 모델 접근** (`ap-northeast-2` 서울):
   - Claude Opus 4.8 — `global.anthropic.claude-opus-4-8` (`opus_model_id` 기본값)
   - Claude Sonnet 5 — `global.anthropic.claude-sonnet-5` (`sonnet_model_id` 기본값)
   - Codex를 쓸 경우 OpenAI GPT inference profile (`codex_model_id`, `global.openai.gpt-*`; ADR-014)
   - AWS Console > Bedrock > Model access 에서 활성화.

4. **Bedrock 사용량 메터링 전제 (ADR-005)**: 사용량은 Application Inference Profile + Bedrock Invocation Log → DynamoDB 경로로 집계됩니다. CloudWatch 계정 전역 메트릭이나 LiteLLM 프록시는 쓰지 않습니다. Invocation Log 대상 리소스(S3/DynamoDB 파이프라인)는 `modules/usage-tracking` 에서 생성됩니다.

5. **서비스 쿼터**: per-user DevEnv(기본 `t4g.large`)와 대시보드 ASG(기본 `t4g.xlarge`)용 EC2 vCPU 한도를 확인하세요.
   ```bash
   aws service-quotas get-service-quota \
     --service-code ec2 --quota-code L-3819A6DF --region ap-northeast-2
   ```

6. **CLI 자격 증명**:
   ```bash
   aws configure         # 또는: aws sso login --profile <profile>
   aws sts get-caller-identity
   ```

### Terraform State (S3 backend)

`terraform/providers.tf`는 partial S3 backend(`backend "s3" {}`)이므로, 계정·리전을 코드에 고정하지 않고 `terraform init` 시 `-backend-config`로 넘깁니다 (4장 참고). 권장 값:

```
bucket: cc-on-bedrock-tfstate-<ACCOUNT_ID>
key:    cc-on-bedrock/terraform.tfstate
region: <REGION>   (encrypt=true, use_lockfile=true — use_lockfile은 Terraform >= 1.10 필요)
```

최초 1회 backend 버킷을 만들어 둡니다:

```bash
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
aws s3api create-bucket \
  --bucket "cc-on-bedrock-tfstate-${ACCOUNT_ID}" \
  --region ap-northeast-2 \
  --create-bucket-configuration LocationConstraint=ap-northeast-2
aws s3api put-bucket-versioning \
  --bucket "cc-on-bedrock-tfstate-${ACCOUNT_ID}" \
  --versioning-configuration Status=Enabled
```

---

## 2. Docker 이미지 빌드 + ECR 푸시

Dashboard는 Terraform-managed ECR repo(`cc-on-bedrock/dashboard`)에서 이미지를 pull합니다.
Fresh deploy에서는 repo를 먼저 만들고 이미지를 push한 뒤 전체 apply를 실행해야 합니다.
`scripts/01-create-ecr-repos.sh`는 Terraform 충돌을 피하기 위해 dashboard repo를 만들지 않습니다.

대상 이미지: `cc-on-bedrock/devenv`, `cc-on-bedrock/dashboard`, `cc-on-bedrock/nginx`
(추가로 OTel collector 이미지 — `docker/otel-collector/`).

```bash
cd /path/to/cc-on-bedrock

# Non-Terraform ECR 리포지토리 생성 (devenv/nginx, 재실행 안전)
bash scripts/01-create-ecr-repos.sh

# Dashboard ECR repo bootstrap (fresh deploy 1회 또는 destroy 후 재배포)
terraform -chdir=terraform apply -target=module.security.aws_ecr_repository.dashboard

# 모든 이미지 빌드 + ECR 푸시 (ARM64 / Graviton)
# Production rollout은 IMAGE_TAG를 commit SHA 등 immutable tag로 지정하고,
# terraform.tfvars의 dashboard_image_tag도 같은 값으로 설정합니다.
# Terraform rejects dashboard_image_tag="latest" because ASG refresh depends on
# the tag string changing.
export IMAGE_TAG="$(git rev-parse --short HEAD)"
bash scripts/05-build-docker-images.sh all

# 개별 빌드/푸시 예시 (docker/build.sh [build|push|all] <target>)
#   bash docker/build.sh all devenv-ubuntu
#   bash docker/build.sh all devenv-al2023
#   bash docker/build.sh all dashboard
#   bash docker/build.sh all otel-collector
# 주의: docker/build.sh 의 target `all` 은 제거된 litellm 이미지를 포함해 실패합니다.
```

> ARM64(Graviton) 전용 이미지입니다. `docker/build.sh` 는 `docker buildx --platform linux/arm64` 를 사용합니다. x86 머신에서 빌드 시 buildx/QEMU가 필요합니다.

---

## 3. DevEnv AMI 빌드

per-user EC2 DevEnv (ADR-002)는 ECR 컨테이너가 아니라 AMI 기반 EC2로 실행됩니다.
AMI를 빌드하고 그 ID를 SSM Parameter Store에 등록하면, DevEnv launch template이 이를 읽습니다.

```bash
# Ubuntu / Amazon Linux 2023 AMI 빌드 (ARM64)
bash scripts/build-ami.sh ubuntu
bash scripts/build-ami.sh al2023
```

`build-ami.sh` 는 임시 EC2를 띄워 setup 스크립트를 실행하고, AMI를 생성한 뒤 SSM 파라미터에 AMI ID를 기록합니다:

```
/cc-on-bedrock/devenv/ami-id/ubuntu
/cc-on-bedrock/devenv/ami-id/al2023
/cc-on-bedrock/devenv/ami-id          (legacy alias)
```

> **저장소 모델 (ADR-002, 2-볼륨):** AMI에는 `cc-data-migrate` 부팅 유닛이 포함되어, 인스턴스에 영속 데이터 EBS (`/home/coder`, GP3, `DeleteOnTermination=false`, subdomain 태그)를 마운트/초기화합니다. OS root EBS는 ephemeral입니다 (`DeleteOnTermination=true`, 새 AMI로 교체 가능). Terminate 시에도 데이터 볼륨은 보존됩니다. EFS/RDS는 사용하지 않습니다.

---

## 4. Terraform 인프라 배포

```bash
cd terraform

# tfvars 작성 — 최소 domain_name 변경
cp terraform.tfvars.example terraform.tfvars
# terraform.tfvars 편집:
#   domain_name   = "your-domain.com"
#   dev_subdomain = "dev"
# (옵션) dashboard_subdomain, *_instance_type, subnet CIDR 등

terraform init \
  -backend-config="bucket=cc-on-bedrock-tfstate-<ACCOUNT_ID>" \
  -backend-config="key=cc-on-bedrock/terraform.tfstate" \
  -backend-config="region=<REGION>" -backend-config="encrypt=true" -backend-config="use_lockfile=true"
terraform validate
terraform plan
terraform apply           # 확인 메시지에 'yes'
```

`terraform/main.tf` 가 8개 모듈을 묶어 한 번에 배포합니다:

| 모듈 | 역할 |
|------|------|
| `network` | VPC, Subnets(public/private/isolated), NAT, VPC Endpoints, Route 53 |
| `security` | Cognito, ACM, KMS, Secrets Manager, IAM, task permission boundary (ADR-007) |
| `ecs-devenv` | ECS Cluster, NLB + nginx Fargate, routing DynamoDB, DLP SGs, nginx-config-gen Lambda |
| `ec2-devenv` | per-user EC2 launch template + DLP SGs (ADR-002), permission-boundary 적용 |
| `usage-tracking` | usage DynamoDB(+GSI/Stream), OTel collector (Fargate+NLB:4318, OTLP/HTTP), rollup Lambda |
| `dashboard` | Dashboard EC2 ASG + ALB + CloudFront (us-east-1 ACM) |
| `local-governance` | STS issuer / token-limit enforcer / reset (ADR-006/008) |
| `waf` | CLOUDFRONT-scope WebACL (us-east-1) |

> **Deployment profiles (ADR-006):** `deployment_mode = "governance"` (default) deploys the admin dashboard, usage/budget governance and the local installer, with no `ecs-devenv`/`ec2-devenv` modules, OTEL collector or EC2 schedules. Users install the CLI with `curl -fsSL https://<dashboard>/api/install | bash`, sign in with Cognito and receive 1h STS credentials; no Bedrock API key is issued. `deployment_mode = "devenv"` adds per-user EC2 DevEnvs. An existing tfvars with `governance_only = false` stays on devenv; set `deployment_mode = "devenv"` before removing that line. Onboarding: `docs/runbooks/local-governance-onboarding.md`.

출력 확인:
```bash
terraform output
# vpc_id, user_pool_id, user_pool_client_id, cognito_cli_public_client_id, ecs_cluster_name,
# dashboard_url, dashboard_cloudfront_domain, dashboard_ecr_url, devenv_cloudfront_domain,
# nginx_ecr_url, devenv_launch_template_id, devenv_sg_{open,restricted,locked}_id, sts_issuer_function_url ...
```

제거:
```bash
terraform destroy
```
> 영속 데이터 EBS는 `DeleteOnTermination=false` 라 인스턴스 종료로는 지워지지 않습니다. 완전 삭제 절차는 `docs/runbooks/full-teardown-redeploy.md` 를 따르세요.

---

## 5. 배포 후 설정 (Post-Deploy)

### 5.1 Cognito 인증 + 관리자 계정

`scripts/04-setup-cognito-auth.sh` 가 User Pool Client 설정과 첫 admin 사용자/그룹 생성을 자동화합니다. 수동으로 할 경우:

```bash
USER_POOL_ID=$(cd terraform && terraform output -raw user_pool_id)

aws cognito-idp admin-create-user \
  --user-pool-id "$USER_POOL_ID" \
  --username admin@your-company.com \
  --user-attributes \
    Name=email,Value=admin@your-company.com \
    Name=email_verified,Value=true \
    Name="custom:subdomain",Value=admin \
    Name="custom:department",Value=platform \
    Name="custom:container_os",Value=ubuntu \
    Name="custom:resource_tier",Value=power \
    Name="custom:security_policy",Value=open \
  --temporary-password 'TempPass123!'

aws cognito-idp admin-add-user-to-group \
  --user-pool-id "$USER_POOL_ID" \
  --username admin@your-company.com \
  --group-name admin
```

> 대시보드의 Cognito 설정(User Pool ID, client ID, CLI public client ID)은 Terraform이 runtime env로 주입하고, `NEXTAUTH_SECRET`은 부팅 시 SSM `/cc-on-bedrock/nextauth-secret`에서 읽습니다. `04-setup-cognito-auth.sh`는 별도로 `/cc-on-bedrock/cognito/*` SSM 파라미터를 기록합니다. 사용량/한도의 canonical key는 email입니다 (ADR-005).
>
> Cognito self sign-up은 꺼져 있습니다(`allow_admin_create_user_only = true`). 사용자는 admin이 생성하거나 초대합니다.

### 5.2 배포 검증

```bash
bash scripts/verify-deployment.sh your-domain.com
# CloudFront, ECS(nginx), Dashboard ASG, DynamoDB, Cognito, ECR, SSM,
# Lambda, IAM, EC2 DevEnv AMI, Bedrock 접근을 점검
```

### 5.3 DNS / ACM 전파 확인

ACM 검증 + DNS 전파에 최대 30분이 걸릴 수 있습니다.

```bash
dig +short <dashboard_subdomain>.your-domain.com
dig +short test.dev.your-domain.com
aws acm list-certificates --region ap-northeast-2   # ALB/지역 인증서
aws acm list-certificates --region us-east-1        # CloudFront 인증서 (ADR-003)
```

---

## 6. 대시보드 접속

1. 브라우저에서 `terraform output dashboard_url` 의 주소로 접속
2. 대시보드 로그인 페이지(`/login`)에서 admin 계정 로그인
3. 최초 로그인 시 임시 비밀번호 변경
4. 대시보드 표시

| 메뉴 | 설명 | 권한 |
|------|------|------|
| 홈 | 시스템 상태 개요 | 전체 |
| Analytics | 토큰 사용량/모델별 비용/트렌드 (Inference Profile + Invocation Log → DynamoDB 기반) | 전체 |
| Monitoring | EC2 DevEnv 상태, OTel 코드활동 메트릭 | admin |
| Admin | 사용자 CRUD, DevEnv 관리, 예산/한도 | admin |

---

## 7. 사용자 생성 및 개발환경 시작

### Dashboard에서 사용자 생성 (권장)

1. Admin > Users > "Add User"
2. 입력: 이메일, 서브도메인(`user01` → `user01.dev.your-domain.com`), OS(Ubuntu/AL2023), 리소스 등급, 보안 정책
3. "Create" — Cognito 사용자 생성 + 라우팅/IAM 프로비저닝이 따라옵니다 (ADR-010).

### 개발환경 시작

1. 사용자가 대시보드 로그인 후 "Start Dev Environment"
2. per-user EC2가 시작되고, 영속 데이터 EBS(`/home/coder`)가 마운트됩니다 (ADR-002)
3. 상태가 "Ready"가 되면 `https://user01.dev.your-domain.com` → code-server(VS Code Web)
4. Claude Code / Kiro 사용 가능 (Bedrock 호출은 Application Inference Profile로 귀속)

### 개발환경 중지 / 보존

- 대시보드 "Stop", 또는 유휴 시 자동 Stop/Hibernate (ADR-002)
- 데이터는 영속 데이터 EBS에 보존되어 재시작/OS 전환/AMI 교체에도 유지됩니다 (EFS 아님)

---

## 8. 문제 해결 (Troubleshooting)

### Terraform apply 실패
- ECR 이미지 / AMI(SSM 파라미터) 미존재 → 2·3장 선행. `terraform plan` 으로 drift 확인.
- S3 backend 오류 → 1장의 backend 버킷·`providers.tf` bucket 이름·리전 확인.

### DNS 접속 불가
```bash
dig +short <dashboard_subdomain>.your-domain.com
aws route53 list-resource-record-sets --hosted-zone-id "$(cd terraform && terraform output -raw hosted_zone_id)"
```
DNS 전파 최대 48h. CloudFront 배포 상태도 확인.

### ACM 인증서 (CloudFront)
```bash
aws acm list-certificates --region us-east-1 \
  --query "CertificateSummaryList[?contains(DomainName,'your-domain')]"
```
DNS 검증 CNAME가 Route 53에 생성됐는지 확인 (ADR-003: CloudFront는 us-east-1 인증서).

### DevEnv EC2 시작 실패
- AMI 미등록 → `bash scripts/build-ami.sh <os>` 후 SSM 파라미터 확인.
- launch template/SG 확인: `terraform output devenv_launch_template_id`, `devenv_sg_*_id`.
- IAM permission boundary(ADR-007) 관련은 `scripts/check-policyset-boundary.py --self-test` 로 점검.

### Bedrock 호출 오류
- 모델 access 활성 여부(1장) 및 region(ap-northeast-2) 확인.
- VPC Endpoint / per-user role IAM (boundary 내 grant, ADR-007) 확인.

### CloudFront 403
- X-Custom-Secret 헤더 불일치. CloudFront Origin Custom Header ↔ ALB/NLB 리스너 규칙 헤더 값 일치 확인.
- 값은 Secrets Manager(`module.security` 가 생성)에서 확인.

### 비용
- NAT Gateway / VPC Endpoint / nginx·OTel Fargate 서비스 / 대시보드 ASG가 상시 비용의 큰 부분.
- 미사용 시 DevEnv 인스턴스가 Stop/Hibernate 되는지(ADR-002) 확인. `scripts/verify-deployment.sh` 로 리소스 점검.

---

## 부록: 참고 문서

| 주제 | 위치 |
|------|------|
| 현행 결정 베이스라인 | `docs/decisions/BASELINE.md` |
| 아키텍처 SSOT | `docs/architecture.md` |
| IaC 단일화 결정 | `docs/decisions/ADR-001-iac-terraform.md` |
| 2-볼륨 저장소 | `docs/decisions/ADR-002-devenv-compute-storage.md` |
| IAM 신청·permission boundary | `docs/decisions/ADR-007-iam-access-control.md` |
| Terraform 모듈 상세 | `terraform/CLAUDE.md` |
| 완전 teardown + 재배포 | `docs/runbooks/full-teardown-redeploy.md` |
| Local Governance 온보딩 | `docs/runbooks/local-governance-onboarding.md` |
| 인스턴스 복구 | `docs/runbooks/instance-recovery.md` |
| AI PR-review 패널(Codex 렌즈 셀·Claude 의장) 장애 | `docs/runbooks/pr-review-panel.md` |
