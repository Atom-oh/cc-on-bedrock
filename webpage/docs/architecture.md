# 아키텍처 (Architecture)

import Screenshot from '@site/src/components/Screenshot';
import NetworkFlow from '@site/src/components/diagrams/NetworkFlow';
import AuthFlow from '@site/src/components/diagrams/AuthFlow';
import Ec2Lifecycle from '@site/src/components/diagrams/Ec2Lifecycle';

CC-on-Bedrock의 아키텍처는 가용성, 보안, 그리고 개별 사용자 격리에 중점을 두고 설계되었습니다.

## 인프라 스택 구성

시스템은 6개의 핵심 스택으로 구성되며, 각 스택은 독립적으로 배포 및 관리가 가능합니다.

| 스택 | 주요 리소스 |
|-------|-----------|
| **01-Network** | VPC (10.100.0.0/16), NAT Gateway, VPC Endpoints x8, DNS Firewall |
| **02-Security** | Cognito (Hosted UI + OAuth 2.0), ACM, KMS, WAFv2, Secrets Manager, IAM |
| **03-Usage Tracking** | DynamoDB, Lambda (usage-tracker + budget-check + idle-stop), EventBridge, CloudTrail |
| **04-ECS Infra** | ECS Cluster (Dashboard + Nginx), NLB, CloudFront |
| **05-Dashboard** | Next.js ECS Service, ALB, CloudFront |
| **07-EC2 DevEnv** | EC2-per-user (AMI), Launch Template, DLP Security Groups, DynamoDB |

---

## 네트워크 라우팅 — NLB + Nginx 아키텍처

기존 ALB Listener Rule 방식(100개 제한)에서 **NLB → Nginx Reverse Proxy** 로 전환하여 무제한 사용자 라우팅을 지원합니다.

<NetworkFlow />

### 라우팅 자동화 흐름

```
사용자 컨테이너 시작 → Private IP 할당
  → DynamoDB cc-routing-table에 {subdomain, targetIp, port} 기록
  → DynamoDB Stream → Lambda (nginx-config-gen)
  → S3에 nginx.conf 업로드
  → Nginx ECS 서비스가 5초마다 S3 폴링 → 자동 리로드
```

:::info ALB vs NLB+Nginx
ALB Listener Rule은 최대 100개 제한이 있어 사용자 수에 병목이 됩니다. NLB는 TCP passthrough로 제한 없이 연결하고, Nginx가 Host 헤더 기반으로 사용자별 컨테이너로 라우팅합니다. WebSocket도 3600초 timeout으로 지원합니다.
:::

---

## 인증 & 접근 제어

Cognito + NextAuth.js 기반의 인증 체계와 code-server 비밀번호 동기화 아키텍처입니다.

<AuthFlow />

### Cognito 구성

| 항목 | 설정 |
|------|------|
| **Sign-in** | 이메일 기반 (selfSignUp 비활성) |
| **그룹** | admin, user, dept-manager |
| **Custom Attributes** | subdomain, container_os, resource_tier, security_policy, department, storage_type |
| **비밀번호 정책** | 8자 이상, 대문자 + 숫자 + 특수문자 |
| **OAuth** | Authorization Code Grant, scopes: openid/email/profile |
| **세션** | JWT, 8시간 max age |

### 역할 기반 접근 제어 (RBAC)

| 역할 | 접근 가능 페이지 |
|------|---------------|
| **user** | Home, My Environment, AI Assistant, Analytics |
| **dept-manager** | + Department 관리 |
| **admin** | + Monitoring, Security, Users, Containers, Budgets |

---

## 모니터링 및 분석 (Monitoring & Analytics)
대시보드에서는 인프라 상태를 실시간으로 감시하고 사용량을 분석할 수 있습니다.

각 사용자는 완전히 격리된 EC2 인스턴스를 할당받습니다:

| 리소스 | 격리 방식 |
|--------|----------|
| **EC2 Instance** | 독립 인스턴스 (code-server + Claude Code + Kiro) |
| **EBS Root Volume** | 30GB gp3, Stop/Start 시 자동 보존 |
| **IAM Instance Profile** | Bedrock + SSM + CloudWatch 권한 |
| **Security Group** | 3-tier DLP: Open / Restricted / Locked |
| **Nginx Route** | `{subdomain}.dev.domain` → instance IP:8080 |
| **접근 방식** | SSM Session Manager only (SSH 비활성) |

### EC2 인스턴스 라이프사이클

<Ec2Lifecycle />

<Screenshot
  src="/cc-on-bedrock/img/containers.png"
  alt="Containers"
  caption="컨테이너 관리: 사용자별 독립된 개발 환경 실행 및 제어"
/>

### 인스턴스 사양

| 기본 타입 | vCPU | 메모리 | EBS | 비용 (On-Demand) |
|----------|------|--------|-----|-----------------|
| **t4g.medium** | 2 | 4 GiB | 30GB gp3 | $0.0336/hr |
| **t4g.large** (기본) | 2 | 8 GiB | 30GB gp3 | $0.0672/hr |
| **t4g.xlarge** | 4 | 16 GiB | 50GB gp3 | $0.1344/hr |

:::tip Stop 시 비용
EC2 Stop 상태에서는 **컴퓨트 비용 $0**. EBS 스토리지만 과금 (30GB × $0.08/GB = $2.4/월).
Snapshot이나 S3 백업 불필요 — Stop/Start로 모든 상태 보존.
:::

---

## 모니터링 및 분석

<Screenshot
  src="/cc-on-bedrock/img/monitoring.png"
  alt="Monitoring"
  caption="실시간 인프라 모니터링: ECS 서비스 상태 및 컨테이너 메트릭"
/>

<Screenshot
  src="/cc-on-bedrock/img/Analytics01.png"
  alt="Analytics"
  caption="데이터 분석: 모델 및 부서별 비용 사용량 트렌드 시각화"
/>

---

<Screenshot 
  src="/img/containers.png" 
  alt="Containers" 
  caption="컨테이너 관리: 사용자별 독립된 개발 환경 실행 및 제어" 
/>

## 하이브리드 AI 아키텍처

대시보드와 외부 채널(Slack)은 서로 다른 경로를 통해 AI 서비스를 제공합니다:

| 채널 | 경로 | 응답 시간 | 도구 |
|------|------|----------|------|
| **대시보드** | Browser → Bedrock Converse API (Direct) | 1~5초 (SSE 스트리밍) | 인라인 3개 |
| **Slack/외부** | Bot → AgentCore Runtime → Gateway (MCP) → Lambda | 10~20초 | 8개 MCP Tools |

양쪽 모두 **AgentCore Memory**를 공유하여 사용자별 대화 맥락을 유지합니다.
