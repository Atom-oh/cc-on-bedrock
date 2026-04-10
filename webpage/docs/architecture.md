# 아키텍처 (Architecture)

CC-on-Bedrock의 아키텍처는 가용성, 보안, 그리고 개별 사용자 격리에 중점을 두고 설계되었습니다.

## 인프라 스택 구성

시스템은 5개의 핵심 스택으로 구성되며, 각 스택은 독립적으로 배포 및 관리가 가능합니다.

| 스택 | 주요 리소스 |
|-------|-----------|
| **01-Network** | VPC (10.100.0.0/16), NAT Gateway, VPC Endpoints, DNS Firewall |
| **02-Security** | Cognito (Hosted UI), ACM, KMS, Secrets Manager, IAM Roles |
| **03-Usage Tracking** | DynamoDB, Lambda (usage-tracker), EventBridge, CloudTrail |
| **04-ECS DevEnv** | ECS Cluster (EC2 mode), Task Definitions, EFS, ALB, CloudFront |
| **05-Dashboard** | Next.js Standalone, EC2 ASG, ALB, CloudFront, S3 |

## 컨테이너 아키텍처

각 사용자는 독립적인 ECS 태스크를 할당받습니다:

- **1 ECS Task**: 독립된 컨테이너 환경 (code-server + Claude Code + Kiro)
- **1 ENI**: 고유한 프라이빗 IP (`awsvpc` 네트워크 모드)
- **1 IAM Role**: 예산 제어를 위한 사용자별 전용 역할
- **1 ALB Target Group**: 호스트 기반 라우팅 (`{subdomain}.dev.domain.com`)
- **1 EFS Directory**: 사용자별 격리된 파일 시스템 저장소

## 하이브리드 AI 아키텍처

대시보드와 외부 채널(Slack)은 서로 다른 경로를 통해 AI 서비스를 제공합니다:

### 대시보드 (고속 스트리밍)
- **경로**: Browser → /api/ai → Bedrock Converse API (Direct)
- **특징**: 토큰 단위 SSE 스트리밍, 1~5초 응답, 인라인 도구 지원

### Slack/외부 채널 (공유 런타임)
- **경로**: Slack Bot → /api/ai/runtime → AgentCore Runtime → Gateway (MCP) → Lambda
- **특징**: 전체 처리 후 응답, 10~20초 응답, 8개 이상의 전문 도구 지원

모든 경로는 **AgentCore Memory**를 통해 사용자별 세션 격리 및 대화 기록을 공유합니다.
