---
sidebar_position: 7
---

# FAQ

import EbsLifecycle from '@site/src/components/diagrams/EbsLifecycle';
import BudgetEnforcement from '@site/src/components/diagrams/BudgetEnforcement';
import NetworkFlow from '@site/src/components/diagrams/NetworkFlow';
import AzPinning from '@site/src/components/diagrams/AzPinning';

자주 묻는 질문과 답변을 정리했습니다.

## 스토리지

### EBS 볼륨은 어떻게 운영되나요? 같은 볼륨을 계속 사용하나요?

**매 시작 시 새 볼륨을 생성하고, 스냅샷에서 복원합니다.**

<EbsLifecycle />

ECS Managed EBS Volume을 사용하여 태스크 시작 시 자동으로 볼륨을 생성/연결합니다. 정지 시에는 스냅샷을 만들고 볼륨을 삭제하여 비용을 절약합니다.

### EBS vs EFS 중 어떤 것을 선택해야 하나요?

| 항목 | EBS | EFS |
|------|-----|-----|
| **성능** | gp3 3000 IOPS, 전용 | 공유, 버스트 |
| **격리** | 사용자별 볼륨 | Access Point 기반 |
| **비용** | $0.08/GB/월 (사용 시만) | $0.30/GB/월 (상시) |
| **확장** | 수동 신청 (40/60/100GB) | 자동 확장 |
| **백업** | 스냅샷 + S3 이중화 | EFS 자체 내구성 |
| **적합** | 대용량 빌드, ML, 고성능 | 경량 개발, 빠른 시작 |

CDK 설정: `storageType: 'ebs'` (기본) 또는 `'efs'`

### EBS 디스크 확장은 어떻게 하나요?

1. **사용자 포털** → 스토리지 탭 → EBS Volume Expansion
2. 희망 크기 선택 (40/60/100 GB) + 사유 입력
3. AI가 리소스 사용 패턴 분석 후 권장 여부 판단
4. 관리자가 `/admin/budgets`에서 승인
5. Lambda가 `ec2.modify_volume()` 또는 다음 시작 시 확장된 크기로 생성

:::note
EBS는 6시간 수정 쿨다운이 있습니다. 리사이즈 후 6시간 내 재수정이 불가합니다.
:::

### 컨테이너 Stop 시 EBS 볼륨은 어떻게 되나요?

**스냅샷을 생성하고 볼륨은 유지합니다.** 같은 AZ면 볼륨 재사용, 다른 AZ면 스냅샷에서 복원합니다.

| 경로 | 동작 | 볼륨 | 스냅샷 |
|------|------|------|--------|
| **User Stop** (대시보드 버튼) | ECS StopTask + 비동기 스냅샷 | 유지 (재사용 가능) | 생성 |
| **Warm-Stop** (유휴 45분) | ECS StopTask + 스냅샷 + 볼륨 삭제 | 삭제 (비용 절약) | 생성 |
| **EOD Batch** (매일 18:00) | 전체 유휴 정리 | 삭제 | 생성 |

:::info EBS는 AZ에 종속됩니다
EBS 볼륨은 생성된 AZ에서만 사용 가능합니다. ASG가 다른 AZ의 EC2에 태스크를 배치하면 기존 볼륨을 마운트할 수 없으므로, **스냅샷은 반드시 필요**합니다 (AZ 독립).
:::

### EBS AZ 고정과 Per-AZ Capacity Provider는 어떻게 동작하나요?

EBS 볼륨은 **생성된 AZ에서만 사용 가능**합니다. 단일 ASG를 사용하면 다른 AZ에 인스턴스를 생성할 수 있어 EBS 마운트가 실패합니다. 이를 해결하기 위해 **EKS Karpenter 스타일의 AZ별 독립 ASG + Capacity Provider**를 사용합니다.

<AzPinning />

### Per-AZ ASG 구성

| 구성 요소 | AZ-a | AZ-c |
|----------|------|------|
| **ASG** | EcsAsg-a (subnet-az-a만) | EcsAsg-c (subnet-az-c만) |
| **Capacity Provider** | cc-cp-a | cc-cp-c |
| **Min/Max** | 0 / 8 | 0 / 8 |
| **Target Capacity** | 80% | 80% |
| **Instance** | m7g.4xlarge (ARM) | m7g.4xlarge (ARM) |

### 핵심 동작 원리

```
사용자 시작 → DynamoDB에서 AZ 조회 (예: "az-a")
  → cc-cp-a Capacity Provider 선택
  → AZ-a에 인스턴스 있음?
    ├─ 있음 → 즉시 배치 (5-10초) + EBS 직접 마운트
    └─ 없음 → ASG가 AZ-a에만 ScaleOut (2-3분)
              (다른 AZ로 절대 가지 않음!)
  → AZ 장애 시: 스냅샷 fallback → 다른 AZ로 복원
```

:::info 단일 ASG vs Per-AZ ASG
단일 ASG는 AZ 균등 분배(Rebalancing)를 시도하여, AZ-a 사용자의 태스크가 pending이어도 AZ-c에 인스턴스를 만들 수 있습니다. Per-AZ ASG는 각 AZ의 Capacity Provider가 독립적으로 스케일링하여 **EBS가 있는 AZ에만 인스턴스를 생성**합니다.
:::

:::caution AZ 장애 대비
스냅샷은 AZ 독립적이므로, AZ 장애 시 다른 AZ에서 복원 가능합니다. Admin이 사용자 AZ를 수동 변경할 수도 있습니다.
:::

### S3 백업은 무엇을 저장하나요?

`/home/coder/workspace/` 디렉토리만 S3에 동기화됩니다 (5분 주기). `.claude/`, `.config/`, `.bashrc.d/` 등 dotfile은 **EBS 스냅샷에만** 보존됩니다. EFS 모드에서는 파일 시스템 자체가 내구성을 보장합니다.

---

## 인증 & 비밀번호

### Cognito 비밀번호와 code-server 비밀번호가 다른가요?

초기에는 동일합니다. Admin이 사용자를 생성하면 **동일한 임시 비밀번호**가 Cognito + Secrets Manager 양쪽에 저장됩니다.

이후 대시보드 Settings 탭에서 비밀번호를 변경하면 **양쪽 동시 업데이트**됩니다:
- Cognito: `AdminSetUserPassword` (대시보드 로그인용)
- Secrets Manager: `PutSecretValue` (code-server 접속용)

:::info
실행 중인 컨테이너에는 재시작 후 새 비밀번호가 적용됩니다.
:::

### SAML/OIDC 연동이 가능한가요?

현재 Cognito Hosted UI 기반 이메일/비밀번호 인증을 사용합니다. Cognito는 SAML 2.0 및 OIDC Identity Provider 연동을 기본 지원하므로, 사내 IdP (Okta, Azure AD, Google Workspace 등)와 통합이 가능합니다. CDK `02-security-stack.ts`에서 설정합니다.

### 역할(admin/user/dept-manager)은 어떻게 관리하나요?

Cognito User Pool의 **그룹**으로 관리됩니다:
- `admin`: 전체 대시보드 접근 (모니터링, 보안, 사용자/컨테이너 관리)
- `dept-manager`: 부서 관리 페이지 접근
- `user`: 기본 — My Environment, AI Assistant, Analytics

NextAuth JWT 세션에 그룹 정보가 포함되고, Middleware에서 라우트별 접근 제어를 수행합니다.

---

## 컨테이너 & 프로비저닝

### 컨테이너 시작에 얼마나 걸리나요?

일반적으로 **1-2분**입니다. SSE 프로비저닝 6단계:

1. 권한 설정 (IAM Role) — 5-15초
2. 스토리지 준비 (EFS Access Point) — 5-10초
3. 환경 구성 (Task Definition) — 3-5초
4. 접근 보안 (Password Store) — 2-3초
5. 컨테이너 시작 (ECS RunTask) — **30-60초** (가장 오래 걸림)
6. 네트워크 연결 (Route Register) — 5-40초

Step 5가 전체 시간의 50-70%를 차지합니다. EC2 Capacity Provider가 인스턴스를 스케일업해야 하면 추가 2-3분이 소요될 수 있습니다.

### 유휴 컨테이너는 어떻게 관리되나요?

**EventBridge 5분 주기 체크** + **자동 Warm-Stop**:

```
5분마다: CPU 5% 미만 + 네트워크 1KB/s 미만 체크
  → 30분 유휴: SNS 경고 알림
  → 45분 유휴: Warm-Stop (SIGTERM → S3 백업 → 스냅샷 → 볼륨 삭제)
  → 매일 18:00 KST: 전체 유휴 컨테이너 일괄 정리

예외: no_auto_stop 태그 또는 Keep-Alive 연장 시 스킵
```

### Keep-Alive는 어떻게 동작하나요?

스토리지 탭에서 "Extend 1 Hour" 버튼을 클릭하면 `keep_alive_until` 타임스탬프가 DynamoDB에 기록됩니다. Warm-stop Lambda는 이 값을 확인하고, 현재 시간이 `keep_alive_until` 이전이면 자동 정지를 건너뜁니다.

### 컨테이너 리소스 티어는 어떻게 다른가요?

| 티어 | vCPU | Memory | 비용 배수 | 용도 |
|------|------|--------|----------|------|
| **Light** | 1 | 4 GiB | 1x | 문서, 경량 작업 |
| **Standard** | 2 | 8 GiB | 2x | 일반 개발 (기본) |
| **Power** | 4 | 12 GiB | 4x | 대규모 빌드, ML |

Ubuntu 24.04 / Amazon Linux 2023 × 3 티어 = 총 **6종 Task Definition**.
부서 정책(`allowedTiers`)으로 사용 가능한 티어를 제한할 수 있습니다.

---

## 네트워크 & 라우팅

### ALB 대신 NLB + Nginx를 사용하는 이유는?

<NetworkFlow />

ALB Listener Rule은 **최대 100개 제한**이 있어 사용자 수에 병목이 됩니다. NLB + Nginx 아키텍처는:

- **NLB**: TCP passthrough, 연결 수 제한 없음
- **Nginx**: Host 헤더 기반 동적 라우팅, DynamoDB Stream으로 자동 설정 업데이트
- **WebSocket**: 3600초 timeout으로 Claude Code 장시간 세션 지원

라우팅 자동화 흐름:
```
컨테이너 시작 → IP 할당 → DynamoDB cc-routing-table 기록
  → DynamoDB Stream → Lambda (nginx-config-gen)
  → S3에 nginx.conf 업로드 → Nginx 5초 폴링 → 자동 리로드
```

### CloudFront와 WAF는 어떻게 구성되나요?

- **CloudFront**: TLS 1.2+ 종단, DDoS 방어 (Shield Standard), 정적 자산 캐싱
- **WAF v2**: AWS Managed Rules (Core, Known Bad Inputs, IP Reputation) + Rate Limiting
- **ALB 보호**: CloudFront Prefix List + `X-Custom-Secret` 헤더로 직접 접근 차단

---

## 예산 & 비용

### 예산 초과 시 무슨 일이 일어나나요?

**자동 단계별 대응** — 각 단계를 클릭하여 상세 동작을 확인하세요:

<BudgetEnforcement />

### 사용량 추적은 어떻게 동작하나요?

서버리스 파이프라인으로 월 ~$5에 운영됩니다:

```
ECS Task (Claude Code) → Bedrock API 호출
  → CloudTrail (자동 기록)
  → EventBridge Rule (bedrock:InvokeModel 매칭)
  → Lambda (usage-tracker) → DynamoDB (사용자/모델/일자별)
```

기존 LiteLLM 프록시($370/월) 대비 **99% 비용 절감**.

### Nginx Proxy를 Fargate로 전환하면 얼마나 절약되나요?

Nginx Reverse Proxy는 매우 경량(0.25 vCPU, 128MB)이지만, **현재 EC2 모드**에서는 사용자 태스크가 없어도 EC2 인스턴스를 유지해야 합니다. **Fargate 전환이 계획되어 있습니다.**

| 시나리오 | EC2 (현재) | Fargate (전환 예정) |
|---------|-----------|------------------|
| **유휴 시** (사용자 0명) | m7g.4xlarge × 2 = ~$800/월 | 0.25vCPU × 2 = **~$18/월** |
| **운영 시** (사용자 있음) | EC2 공존 = 추가 비용 없음 | $18 고정 추가 |

:::tip 전환 계획
Nginx를 Fargate(0.25 vCPU, 512MB, ARM64)로 전환하면 유휴 비용 **97% 절감**. CDK에서 `Ec2TaskDefinition` → `FargateTaskDefinition`, `Ec2Service` → `FargateService`로 변경. HA 2 replica 유지.
:::

### 예상 운영 비용은?

| 항목 | 10 사용자 | 50 사용자 | 100 사용자 |
|------|----------|----------|-----------|
| ECS EC2 (m7g.4xlarge) | ~$400 | ~$1,200 | ~$2,400 |
| Bedrock API | ~$200 | ~$1,000 | ~$2,000 |
| EFS/EBS | ~$20 | ~$100 | ~$200 |
| CloudFront + ALB + NLB | ~$50 | ~$80 | ~$120 |
| DynamoDB + Lambda | ~$5 | ~$10 | ~$20 |
| **Total** | **~$675** | **~$2,390** | **~$4,740** |

:::tip 비용 절감
- Auto Scaling Target 80%로 EC2 절약
- Warm-Stop으로 유휴 시 EBS 스냅샷 전환 (볼륨 비용 제거)
- Reserved Instances / Savings Plans 적용 시 30-40% 추가 절감
:::

---

## 보안

### DLP (Data Loss Prevention) 정책은 어떻게 적용되나요?

3단계 Security Group 기반:

| 정책 | 아웃바운드 | 적합 |
|------|----------|------|
| **Open** | 전체 허용 | 일반 개발자 |
| **Restricted** | VPC 내부 + HTTPS(443)만 | 보안 민감 프로젝트 |
| **Locked** | VPC 내부만 | 규제 환경, 금융 |

추가로 code-server에서 `--disable-file-downloads --disable-file-uploads` 플래그로 파일 유출을 방지합니다 (Restricted/Locked).

### IAM 권한은 어떻게 격리되나요?

사용자별 **전용 IAM Task Role** (`cc-on-bedrock-task-{subdomain}`):

- Bedrock: 특정 모델만 호출 허용 (Claude Opus/Sonnet)
- S3: `users/{subdomain}/*` 경로만 접근
- CloudWatch: 로그 쓰기만
- ECR: 이미지 Pull만
- Permission Boundary: `cc-on-bedrock-task-boundary`로 권한 확장 방지

### DNS Firewall은 무엇을 차단하나요?

5개 AWS 관리형 위협 리스트 + 커스텀 차단:
- Malware domains
- Botnet command & control
- Newly observed domains
- Spyware/Adware
- Custom block list

---

## 개발 & 배포

### CDK 배포 순서가 중요한가요?

**반드시 순서대로 배포해야 합니다:**

```bash
01-Network → 02-Security → 03-Usage Tracking → 04-ECS DevEnv → 05-Dashboard
```

각 스택이 이전 스택의 출력(VPC, Cognito, KMS 등)에 의존합니다. `npx cdk deploy --all` 실행 시 CDK가 자동으로 의존성 순서를 처리합니다.

### Terraform과 CloudFormation도 사용 가능한가요?

동일한 인프라를 3가지 IaC로 구현합니다:
- **CDK (TypeScript)**: 주 개발 도구, 5 스택
- **Terraform (HCL)**: 4 모듈
- **CloudFormation (YAML)**: 4 템플릿 + deploy.sh

CDK가 가장 최신 상태이며, Terraform/CloudFormation은 코어 기능을 지원합니다.

### 다른 리전에 배포할 수 있나요?

CDK context로 오버라이드:
```bash
npx cdk deploy --all -c region=us-west-2 -c vpcCidr=10.200.0.0/16
```

Bedrock 모델 가용성은 리전별로 다릅니다. Opus 4.6은 `us-east-1`, `us-west-2`, `ap-northeast-1`, `ap-northeast-2`에서 사용 가능합니다.
