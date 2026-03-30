# 배포 가이드 (Deployment Guide)

import DeploymentFlow from '@site/src/components/diagrams/DeploymentFlow';
import Screenshot from '@site/src/components/Screenshot';

CC-on-Bedrock을 AWS 계정에 배포하기 위한 전체 과정과 아키텍처 원리를 설명합니다.

<DeploymentFlow />

## Prerequisites (요구사항)

| 항목 | 요구사항 |
|------|----------|
| **AWS 계정** | AdministratorAccess 권한이 있는 IAM 사용자/역할 |
| **Node.js** | v20 이상 |
| **AWS CDK CLI** | `npm install -g aws-cdk` |
| **Docker** | 컨테이너 이미지 빌드용 (Ubuntu/AL2023) |

## 배포 단계 상세

### Step 1: 네트워크 인프라 구축 (Network)
가장 먼저 VPC와 보안의 기초가 되는 네트워크 환경을 구성합니다.

- **VPC**: 10.100.0.0/16 대역 사용
- **Subnets**: 2개의 가용 영역(AZ)에 걸쳐 Public/Private 서브넷 생성
- **Security**: VPC Endpoints를 통해 인터넷을 거치지 않고 AWS 서비스와 통신

### Step 2: 보안 및 인증 설정 (Security)
사용자 인증을 위한 Cognito와 데이터 암호화를 위한 KMS 등을 배포합니다.

- **Cognito**: 멀티유저 로그인을 위한 User Pool 및 Hosted UI 구성
- **IAM Roles**: 개발자별 개별 권한 제어를 위한 동적 역할 생성 기초 마련

### Step 3: 실시간 사용량 추적 시스템 (Usage Tracking)
비용 효율적인 서버리스 방식의 추적 시스템을 구축합니다.

- **CloudTrail**: Bedrock API 호출 이력 로깅
- **EventBridge**: 특정 API 호출 이벤트 감지 및 Lambda 트리거
- **DynamoDB**: 사용자별 실시간 사용량 데이터 저장

### Step 4: ECS 개발 환경 배포 (DevEnv)
실제 개발자가 사용할 컨테이너 환경을 구축합니다.

- **ECS Cluster**: Fargate 또는 EC2 기반의 클러스터 생성
- **ALB/CloudFront**: 사용자별 서브도메인 라우팅 설정
- **EFS**: 사용자별 데이터 영구 저장을 위한 파일 시스템

### Step 5: 관리 대시보드 배포 (Dashboard)
중앙 집중식 관리를 위한 Next.js 애플리케이션을 배포합니다.

- **Frontend**: Next.js 기반의 관리 UI (Home, Analytics, Users 등)
- **Deployment**: EC2 Auto Scaling Group 또는 ECS를 통한 가용성 확보

## 아키텍처 작동 원리 (How it Works)

### 1. 사용자 접속 흐름 (User Access Flow)
1. 사용자가 `{user}.dev.domain.com` 접속
2. **CloudFront**가 요청을 받아 **Cognito** 인증 여부 확인
3. 인증된 경우 **ALB**를 거쳐 해당 사용자의 **ECS Task**로 라우팅
4. 사용자는 브라우저 상에서 **code-server**를 통해 개발 진행

### 2. AI 어시스턴트 호출 흐름 (AI Assistant Flow)
1. **대시보드 앱**: Browser → Next.js API → Bedrock Converse API (Direct Role 호출)
2. **Claude Code (CLI)**: ECS Task 내 터미널 → Task IAM Role → Bedrock API (Direct 호출)
3. **사용량 기록**: Bedrock 호출 발생 → CloudTrail → EventBridge → Lambda → DynamoDB 업데이트

:::tip 인프라 선택
본 프로젝트는 **CDK, Terraform, CloudFormation** 세 가지 방식을 모두 지원합니다. 각 폴더(`cdk/`, `terraform/`, `cloudformation/`)의 README를 참고하여 선호하는 도구로 배포하세요.
:::
