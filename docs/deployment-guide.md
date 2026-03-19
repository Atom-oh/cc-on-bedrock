# CC-on-Bedrock 배포 가이드

## 목차

1. [사전 준비](#1-사전-준비)
2. [Docker 이미지 빌드](#2-docker-이미지-빌드)
3. [인프라 배포](#3-인프라-배포)
   - [CDK 배포](#31-cdk-배포)
   - [Terraform 배포](#32-terraform-배포)
   - [CloudFormation 배포](#33-cloudformation-배포)
4. [배포 후 설정](#4-배포-후-설정)
5. [대시보드 접속](#5-대시보드-접속)
6. [사용자 생성 및 개발환경 시작](#6-사용자-생성-및-개발환경-시작)
7. [문제 해결](#7-문제-해결)

---

## 1. 사전 준비

### 필수 요구사항

| 항목 | 최소 버전 | 설치 확인 |
|------|-----------|-----------|
| AWS 계정 | - | AWS Console 로그인 가능 |
| AWS CLI v2 | 2.15+ | `aws --version` |
| Docker | 24+ | `docker --version` |
| Node.js | 20 LTS | `node --version` |
| npm | 10+ | `npm --version` |
| jq | 1.6+ | `jq --version` |
| Git | 2.40+ | `git --version` |

### IaC 도구별 추가 요구사항

| 도구 | 최소 버전 | 설치 확인 |
|------|-----------|-----------|
| CDK | AWS CDK CLI 2.180+ | `cdk --version` |
| Terraform | 1.5+ | `terraform --version` |
| CloudFormation | (AWS CLI에 포함) | `aws cloudformation help` |

### AWS 계정 설정

1. **IAM 권한**: 배포에 사용하는 IAM 사용자/역할에 `AdministratorAccess` 또는 동등한 권한이 필요합니다.

2. **도메인**: Route 53에 호스팅된 도메인이 필요합니다.
   - 기존 도메인이 없다면 Route 53에서 새 도메인을 등록하세요.
   - 외부 도메인을 사용하는 경우 Route 53으로 네임서버를 위임하세요.

3. **Bedrock 모델 접근**: `ap-northeast-2` (서울) 리전에서 다음 모델이 활성화되어 있어야 합니다.
   - Claude Opus 4.6 (`global.anthropic.claude-opus-4-6-v1[1m]`)
   - Claude Sonnet 4.6 (`global.anthropic.claude-sonnet-4-6[1m]`)
   - AWS Console > Bedrock > Model access에서 활성화

4. **서비스 쿼터 확인**:
   ```bash
   # EC2 인스턴스 한도 (m7g.4xlarge 최소 3대 필요)
   aws service-quotas get-service-quota \
     --service-code ec2 \
     --quota-code L-3819A6DF \
     --region ap-northeast-2
   ```

5. **AWS CLI 프로파일 설정**:
   ```bash
   aws configure
   # 또는 SSO 사용 시
   aws sso login --profile <profile-name>

   # 확인
   aws sts get-caller-identity
   ```

---

## 2. Docker 이미지 빌드

인프라를 배포하기 전에 Docker 이미지를 빌드하고 ECR에 푸시해야 합니다.

### ECR 리포지토리 생성

```bash
cd /path/to/cc-on-bedrock

# ECR 리포지토리 생성
bash scripts/create-ecr-repos.sh
```

### 이미지 빌드 및 푸시

```bash
cd docker

# 모든 이미지 빌드 + ECR 푸시
bash build.sh all all

# 또는 개별적으로:
# LiteLLM 이미지만
bash build.sh all litellm

# Ubuntu devenv 이미지만
bash build.sh all devenv-ubuntu

# AL2023 devenv 이미지만
bash build.sh all devenv-al2023
```

> **참고**: ARM64(Graviton) 기반 이미지입니다. x86 머신에서 빌드 시 Docker Buildx가 필요합니다.
> ```bash
> docker buildx create --use
> docker buildx build --platform linux/arm64 ...
> ```

---

## 3. 인프라 배포

**3가지 IaC 도구 중 하나만 선택하여 배포합니다.** 동일한 아키텍처가 배포됩니다.

### 3.1 CDK 배포

```bash
cd cdk

# 의존성 설치
npm install

# CDK Bootstrap (계정/리전당 최초 1회)
cdk bootstrap aws://<ACCOUNT_ID>/ap-northeast-2

# 도메인 설정 (default.ts를 수정하거나 context로 전달)
# 방법 1: config/default.ts 수정
# 방법 2: context로 전달
cdk deploy --all \
  -c domainName=your-domain.com \
  -c devSubdomain=dev

# 스택 배포 순서는 자동으로 관리됩니다:
# 1. CcOnBedrock-Network
# 2. CcOnBedrock-Security
# 3. CcOnBedrock-LiteLLM
# 4. CcOnBedrock-EcsDevenv
# 5. CcOnBedrock-Dashboard
```

**CDK 개별 스택 배포** (문제 발생 시):
```bash
cdk deploy CcOnBedrock-Network
cdk deploy CcOnBedrock-Security
cdk deploy CcOnBedrock-LiteLLM
cdk deploy CcOnBedrock-EcsDevenv
cdk deploy CcOnBedrock-Dashboard
```

**CDK 제거**:
```bash
cdk destroy --all
```

### 3.2 Terraform 배포

```bash
cd terraform

# tfvars 파일 생성
cp terraform.tfvars.example terraform.tfvars

# terraform.tfvars 편집 - 도메인 변경 필수
# domain_name = "your-domain.com"
# dev_subdomain = "dev"

# 초기화
terraform init

# 배포 계획 확인
terraform plan

# 배포 실행
terraform apply
# 확인 메시지에 'yes' 입력
```

**Terraform 출력 확인**:
```bash
terraform output
# vpc_id, user_pool_id, ecs_cluster_name, dashboard_url 등
```

**Terraform 제거**:
```bash
terraform destroy
```

### 3.3 CloudFormation 배포

```bash
cd cloudformation

# 파라미터 파일 편집
# params/default.json에서 DomainName 변경 필수

# 배포 스크립트 실행
bash deploy.sh

# 또는 도메인만 오버라이드
bash deploy.sh --domain your-domain.com

# 또는 커스텀 파라미터 파일 사용
cp params/default.json params/custom.json
# params/custom.json 편집
bash deploy.sh --params params/custom.json
```

**CloudFormation 제거**:
```bash
bash destroy.sh
```

---

## 4. 배포 후 설정

### 4.1 배포 검증

```bash
# 자동 검증 스크립트 실행
bash scripts/verify-deployment.sh your-domain.com
```

### 4.2 DNS 전파 확인

ACM 인증서 검증과 DNS 전파에 최대 30분이 소요될 수 있습니다.

```bash
# DNS 확인
dig dashboard.your-domain.com
dig test.dev.your-domain.com

# 인증서 상태 확인
aws acm list-certificates --region ap-northeast-2
aws acm list-certificates --region us-east-1
```

### 4.3 첫 번째 관리자 계정 생성

```bash
# Cognito User Pool ID 확인
USER_POOL_ID=$(aws cognito-idp list-user-pools --max-results 10 \
  --query "UserPools[?contains(Name, 'cc-on-bedrock')].Id" --output text)

# 관리자 계정 생성
aws cognito-idp admin-create-user \
  --user-pool-id "$USER_POOL_ID" \
  --username admin@your-company.com \
  --user-attributes \
    Name=email,Value=admin@your-company.com \
    Name=email_verified,Value=true \
    Name=custom:subdomain,Value=admin \
    Name=custom:container_os,Value=ubuntu \
    Name=custom:resource_tier,Value=standard \
    Name=custom:security_policy,Value=open \
  --temporary-password 'TempPass123!'

# admin 그룹에 추가
aws cognito-idp admin-add-user-to-group \
  --user-pool-id "$USER_POOL_ID" \
  --username admin@your-company.com \
  --group-name admin
```

### 4.4 LiteLLM Virtual Key 생성

```bash
# LiteLLM Master Key 확인
MASTER_KEY=$(aws secretsmanager get-secret-value \
  --secret-id cc-on-bedrock/litellm-master-key \
  --query SecretString --output text)

# LiteLLM Internal ALB DNS 확인 (CloudFormation 기준)
LITELLM_ALB=$(aws cloudformation describe-stacks \
  --stack-name cc-on-bedrock-litellm \
  --query "Stacks[0].Outputs[?OutputKey=='InternalAlbDns'].OutputValue" --output text)

# Virtual Key는 Dashboard에서 사용자 생성 시 자동으로 생성됩니다.
# 수동 생성이 필요한 경우 (같은 VPC 내의 EC2에서 실행):
curl -X POST "http://${LITELLM_ALB}:4000/key/generate" \
  -H "Authorization: Bearer ${MASTER_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "models": ["claude-opus-4-6", "claude-sonnet-4-6"],
    "max_budget": 100,
    "budget_duration": "30d",
    "metadata": {"user": "admin"}
  }'
```

---

## 5. 대시보드 접속

1. 브라우저에서 `https://dashboard.your-domain.com` 접속
2. Cognito 로그인 화면에서 관리자 계정으로 로그인
3. 초기 비밀번호 변경 (최초 로그인 시)
4. 대시보드 메인 페이지 표시

### 대시보드 기능

| 메뉴 | 설명 | 권한 |
|------|------|------|
| 홈 | 시스템 상태 개요 | 전체 |
| Analytics | 토큰 사용량, 모델별 비용, 트렌드 차트 | 전체 |
| Monitoring | LiteLLM 프록시 상태, ECS 컨테이너 리소스 | admin |
| Admin | 사용자 CRUD, 컨테이너 관리, API 키 관리 | admin |

---

## 6. 사용자 생성 및 개발환경 시작

### Dashboard에서 사용자 생성 (권장)

1. Admin > Users 메뉴 이동
2. "Add User" 클릭
3. 정보 입력:
   - 이메일: `user01@company.com`
   - 서브도메인: `user01` (user01.dev.your-domain.com)
   - OS: Ubuntu 또는 Amazon Linux 2023
   - 리소스 등급: Light / Standard / Power
   - 보안 정책: Open / Restricted / Locked
4. "Create" 클릭
   - Cognito 사용자 자동 생성
   - LiteLLM Virtual Key 자동 생성
   - ALB 리스너 규칙 자동 생성

### 개발환경 시작

1. 사용자가 `https://dashboard.your-domain.com` 로그인
2. "Start Dev Environment" 클릭
3. ECS Task 시작 (약 2-3분 소요, ASG 스케일아웃 필요 시 5-10분)
4. 상태가 "Ready"가 되면 `https://user01.dev.your-domain.com` 링크 제공
5. 클릭하면 code-server (VS Code Web IDE) 접속
6. Claude Code와 Kiro 사용 가능

### 개발환경 중지

- Dashboard에서 "Stop" 클릭, 또는
- 2시간 비활동 후 자동 중지 (code-server idle detection)
- EFS에 데이터 보존됨 (다음 시작 시 복원)

---

## 7. 문제 해결

### DNS 관련

**증상**: `dashboard.your-domain.com` 접속 불가
```bash
# DNS 전파 확인
dig +short dashboard.your-domain.com

# Route 53 레코드 확인
aws route53 list-resource-record-sets --hosted-zone-id <ZONE_ID> \
  --query "ResourceRecordSets[?contains(Name, 'dashboard')]"
```
- **해결**: DNS 전파에 최대 48시간 소요. CloudFront 배포 상태도 확인.

### ACM 인증서

**증상**: CloudFront 배포 시 인증서 오류
```bash
# 인증서 상태 확인 (us-east-1 필수)
aws acm list-certificates --region us-east-1 \
  --query "CertificateSummaryList[?contains(DomainName, 'your-domain')]"
```
- **해결**: DNS 검증 CNAME 레코드가 Route 53에 생성되었는지 확인. CDK/Terraform은 자동 생성하지만, CloudFormation은 수동 확인 필요할 수 있음.

### ECS Task 시작 실패

**증상**: 개발환경 시작 시 "Task failed to start"
```bash
# 최근 중지된 태스크 확인
aws ecs list-tasks --cluster cc-on-bedrock --desired-status STOPPED --region ap-northeast-2

# 중지 원인 확인
aws ecs describe-tasks --cluster cc-on-bedrock --tasks <TASK_ARN> \
  --query "tasks[0].{stopCode:stopCode,stoppedReason:stoppedReason,containers:containers[*].{name:name,reason:reason,exitCode:exitCode}}"
```
- **원인 1**: ECR 이미지 없음 -> `docker/build.sh all all` 실행
- **원인 2**: ASG 용량 부족 -> ASG max 값 확인
- **원인 3**: IAM 권한 -> ECS Task Execution Role 확인

### LiteLLM 연결 오류

**증상**: Claude Code에서 "Connection refused" 또는 API 오류
```bash
# LiteLLM ALB 타겟 그룹 상태 확인
aws elbv2 describe-target-groups --region ap-northeast-2 \
  --query "TargetGroups[?contains(TargetGroupName, 'litellm')]"

# LiteLLM EC2 로그 확인 (SSM 접속)
aws ssm start-session --target <INSTANCE_ID>
# 접속 후:
sudo docker logs litellm
```
- **해결**: LiteLLM EC2 인스턴스 health check 확인, RDS 연결 확인, Valkey 연결 확인

### RDS 연결 오류

**증상**: LiteLLM이 데이터베이스에 연결하지 못함
```bash
# RDS 상태 확인
aws rds describe-db-instances --region ap-northeast-2 \
  --query "DBInstances[?contains(DBInstanceIdentifier, 'litellm')].{ID:DBInstanceIdentifier,Status:DBInstanceStatus,Endpoint:Endpoint.Address}"

# Security Group 확인
# LiteLLM SG -> RDS SG 인바운드 5432 포트 허용 필요
```

### CloudFront 403 오류

**증상**: 브라우저에서 403 Forbidden
- **원인**: X-Custom-Secret 헤더 불일치
- **해결**:
  ```bash
  # Secrets Manager에서 값 확인
  aws secretsmanager get-secret-value \
    --secret-id cc-on-bedrock/cloudfront-secret \
    --query SecretString --output text
  ```
  CloudFront Origin Custom Header와 ALB 리스너 규칙의 헤더 값이 일치하는지 확인

### 비용 관련

**증상**: 예상보다 높은 비용
- VPC Endpoint 7개: ~$102/월 (각 $7.30/EP/AZ x 2 AZ)
- NAT Gateway 2개: ~$90/월
- 사용하지 않는 리소스 확인: `bash scripts/verify-deployment.sh your-domain.com`
- ECS ASG가 min:0으로 설정되어 있는지 확인 (사용하지 않을 때 0대)

---

## 추가 참고사항

### Bedrock 모델 접근 경로

| 경로 | 용도 | 추적 |
|------|------|------|
| Claude Code -> LiteLLM (Internal ALB) -> Bedrock | 기본 (Primary) | O (LiteLLM) |
| boto3/SDK -> Task Role IAM -> Bedrock VPC Endpoint | 개발용 (Secondary) | X |
| Claude Code -> Task Role IAM -> Bedrock | LiteLLM 장애 시 (Fallback) | X |

### DLP 보안 정책

| 정책 | 파일 다운로드 | 파일 업로드 | 클립보드 | 외부 네트워크 | 확장 설치 |
|------|:---:|:---:|:---:|:---:|:---:|
| open | O | O | O | 전체 허용 | O |
| restricted | X | X | O | 화이트리스트만 | 사전 승인만 |
| locked | X | X | X | 내부만 | X |

### 리소스 등급

| 등급 | vCPU | Memory | 용도 |
|------|------|--------|------|
| light | 1 | 4 GiB | 학습, 간단한 작업 |
| standard | 2 | 8 GiB | 일반 개발 |
| power | 4 | 12 GiB | 대규모 빌드, 복잡한 작업 |
