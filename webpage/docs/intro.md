# 소개 (Introduction)

**CC-on-Bedrock**은 AWS Bedrock을 활용한 멀티유저 Claude Code 개발 플랫폼입니다.

각 개발자에게 격리된 Claude Code + Kiro 환경을 Amazon ECS상에서 제공하며, Next.js 대시보드를 통해 중앙 집중식 관리가 가능합니다. 인프라는 CDK(TypeScript), Terraform(HCL), CloudFormation(YAML) 세 가지 IaC 도구로 구현되어 있습니다.

## 주요 특징

- **Bedrock Direct Mode**: Claude Code가 ECS Task Role을 통해 Bedrock을 직접 호출 (Proxy 없음)
- **사용자별 IAM 역할**: 동적 IAM Deny Policy를 통한 개별 예산 제어
- **하이브리드 AI**: 대시보드는 Converse API(빠른 스트리밍), Slack은 AgentCore Runtime 사용
- **7계층 보안**: CloudFront → ALB → Cognito → Security Groups → VPC Endpoints → DNS Firewall → IAM/DLP
- **서버리스 트래킹**: CloudTrail → EventBridge → Lambda → DynamoDB를 활용한 저비용 사용량 추적

## 시스템 아키텍처 요약

![Architecture](/img/cconbedrock_arch.png)

시스템은 크게 5가지 스택으로 구성됩니다:

1. **Network (01)**: VPC 및 프라이빗 네트워크 인프라
2. **Security (02)**: 인증(Cognito), 암호화(KMS), 보안 관리
3. **Usage Tracking (03)**: 실시간 사용량 추적 및 예산 제어
4. **ECS DevEnv (04)**: 개발자용 컨테이너 환경
5. **Dashboard (05)**: 관리 및 AI 비서용 Next.js 웹 플랫폼
