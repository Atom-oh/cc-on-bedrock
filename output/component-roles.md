# CC-on-Bedrock 컴포넌트별 역할

## 사용자 접속 경로

```
Browser → CloudFront → ALB → EC2/ECS → AWS Services
```

---

## 네트워크 계층 (Stack 01: Network)

| 컴포넌트 | 역할 |
|----------|------|
| **VPC** (10.100.0.0/16) | 모든 리소스가 배치되는 가상 네트워크. 외부 인터넷과 격리된 사설 네트워크 공간 |
| **Public Subnet** (2 AZ) | 인터넷에서 직접 접근 가능한 서브넷. ALB, NAT Gateway 배치 |
| **Private Subnet** (2 AZ) | 인터넷에서 직접 접근 불가. ECS 컨테이너, Dashboard EC2 배치. NAT를 통해 외부 접속 |
| **NAT Gateway** (x2) | Private Subnet의 리소스가 인터넷에 접근할 수 있게 해주는 게이트웨이. AZ별 1개씩 (고가용성) |
| **VPC Endpoints** (8개) | AWS 서비스(Bedrock, ECR, SSM, CloudWatch, S3 등)에 인터넷 없이 VPC 내부 경로로 접근. 보안 강화 + 비용 절감 |
| **Route 53** | DNS 서비스. `*.dev.whchoi.net` → DevEnv CloudFront, `cconbedrock-dashboard.whchoi.net` → Dashboard CloudFront |
| **DNS Firewall** | VPC 레벨 DNS 필터링. 악성 도메인 차단 (5개 AWS 관리 위협 리스트 + 커스텀 차단 목록) |

---

## 보안 계층 (Stack 02: Security)

| 컴포넌트 | 역할 |
|----------|------|
| **Cognito User Pool** | 사용자 인증/관리 서비스. 이메일+패스워드 로그인, 사용자 생성/삭제, 그룹(admin/user) 관리 |
| **Cognito Hosted UI** | Cognito가 제공하는 로그인 웹페이지. `cc-on-bedrock.auth.amazoncognito.com`에서 호스팅 |
| **ACM** (Certificate Manager) | SSL/TLS 인증서 관리. `*.whchoi.net` 와일드카드 인증서 → CloudFront + ALB에서 HTTPS 제공 |
| **KMS** (Key Management Service) | 암호화 키 관리. EBS, Secrets Manager, DynamoDB 데이터 암호화에 사용 |
| **Secrets Manager** | 민감 정보 저장소. NextAuth Secret, CloudFront 시크릿 헤더 값 등 안전하게 보관 |
| **IAM Roles** | 각 서비스의 AWS 권한 정의. ECS Task Role (Bedrock 호출), Dashboard EC2 Role (Cognito/ECS/DynamoDB 관리) |

---

## 사용량 추적 (Stack 03: Usage Tracking)

| 컴포넌트 | 역할 |
|----------|------|
| **CloudTrail** | 모든 AWS API 호출 기록. Bedrock `InvokeModel` 호출을 감지하여 이벤트 발생 |
| **EventBridge** | 이벤트 라우터. CloudTrail의 Bedrock API 이벤트를 감지해서 Lambda 트리거 |
| **Lambda** (usage-tracker) | Bedrock API 호출 정보(사용자, 모델, 토큰)를 DynamoDB에 기록 |
| **Lambda** (budget-check) | 5분마다 실행. 사용자별 비용 합산 → 예산 초과 시 IAM Deny Policy 부착 + SNS 알림 |
| **DynamoDB** | 사용량 데이터 저장소. `PK: USER#{username}, SK: {date}#{model}` 구조. Dashboard가 조회 |
| **SNS** | 예산 초과 알림 전송 (이메일/SMS 등으로 관리자 통보) |

---

## DevEnv 컨테이너 (Stack 04: ECS Dev Environment)

| 컴포넌트 | 역할 |
|----------|------|
| **CloudFront** (DevEnv) | CDN + HTTPS 종단. `*.dev.whchoi.net` 요청을 ALB로 전달. DDoS 방어, 글로벌 엣지 |
| **ALB** (DevEnv) | 로드밸런서. **Host 기반 라우팅** — `user01.dev.whchoi.net` → user01 컨테이너, `user02.dev.whchoi.net` → user02 컨테이너 |
| **ECS Cluster** (EC2 모드) | 컨테이너 오케스트레이션. Docker 컨테이너 스케줄링, 배치, 헬스체크 |
| **EC2 Host** (m7g.4xlarge x8) | ECS 컨테이너가 실제 실행되는 물리 인스턴스. ARM64 Graviton3, 16vCPU/64GiB |
| **Task Definition** (6종) | 컨테이너 스펙 정의. `{OS} x {Tier}` = Ubuntu/AL2023 x Light/Standard/Power |
| **ECS Task** | 실행 중인 컨테이너 인스턴스. 사용자 1명당 1개. code-server + Claude Code + Kiro |
| **EFS** (Elastic File System) | 공유 파일 스토리지. `/home/coder` 마운트. 컨테이너 재시작해도 작업 데이터 유지 |
| **Security Groups** (3종) | 네트워크 방화벽. **Open** (전체 허용) / **Restricted** (제한적) / **Locked** (VPC 내부만) |

---

## Dashboard (Stack 05: Dashboard)

| 컴포넌트 | 역할 |
|----------|------|
| **CloudFront** (Dashboard) | CDN + HTTPS 종단. `cconbedrock-dashboard.whchoi.net` → ALB. X-Custom-Secret 헤더로 직접 ALB 접근 차단 |
| **ALB** (Dashboard) | 로드밸런서. CloudFront에서 온 요청만 받음 (Prefix List + Secret Header 검증) |
| **EC2 ASG** (t4g.xlarge) | Dashboard 서버. Next.js standalone 앱을 PM2로 실행. Min:1 / Max:2 오토스케일링 |
| **Next.js App** | 7페이지 웹 대시보드. 사용량 분석, 모니터링, 사용자/컨테이너 관리, AI 어시스턴트 |
| **S3** (Deploy Bucket) | Dashboard 배포 아티팩트 저장. `npm run build` → tar.gz → S3 업로드 → EC2가 다운로드 |

---

## AI/ML 서비스

| 컴포넌트 | 역할 |
|----------|------|
| **Amazon Bedrock** | AI 모델 호스팅. Claude Opus 4.6 / Sonnet 4.6 모델 제공. ECS Task가 직접 호출 (Direct Mode) |
| **Bedrock VPC Endpoint** | Bedrock API를 VPC 내부에서 호출. 트래픽이 인터넷을 거치지 않음 → 보안 + 저지연 |
| **AgentCore Memory** | AI Assistant의 대화 기억 저장. 이전 대화 맥락을 유지하여 연속적 상담 가능 |

---

## 데이터 흐름 요약

### 사용자 로그인

```
Browser → CloudFront → ALB → Next.js → Cognito OAuth → 인증 완료
```

### 컨테이너 사용 (Claude Code 개발)

```
Browser → CloudFront → ALB (Host 라우팅) → ECS Task (code-server)
code-server 안에서: Claude Code → ECS Task Role → VPC Endpoint → Bedrock
```

### 사용량 추적

```
Bedrock API Call → CloudTrail → EventBridge → Lambda → DynamoDB
Dashboard → DynamoDB 조회 → Analytics 차트 표시
```

### 예산 제어

```
Lambda (5분마다) → DynamoDB 스캔 → 초과 시 → IAM Deny Policy + SNS 알림
```

---

## 보안 다층 방어

```
Layer 1: CloudFront          (HTTPS 종단, DDoS 방어)
Layer 2: ALB                 (X-Custom-Secret 헤더 검증, Prefix List)
Layer 3: Cognito             (OAuth 2.0 사용자 인증)
Layer 4: Security Groups     (네트워크 레벨 접근 제어, 3-tier DLP)
Layer 5: DNS Firewall        (도메인 기반 필터링, 위협 리스트)
Layer 6: IAM                 (Bedrock 모델별 접근 제어, 사용자별 Task Role)
Layer 7: DLP                 (code-server 파일 업/다운로드 제한, 확장 프로그램 제어)
```

---

## Task Definition 사양표

| Task Definition | OS | vCPU | Memory | 용도 |
|----------------|-----|------|--------|------|
| devenv-ubuntu-light | Ubuntu 24.04 | 1 | 4 GiB | 경량 작업, 문서 편집 |
| devenv-ubuntu-standard | Ubuntu 24.04 | 2 | 8 GiB | 일반 개발 (기본) |
| devenv-ubuntu-power | Ubuntu 24.04 | 4 | 12 GiB | 대규모 빌드, ML 작업 |
| devenv-al2023-light | Amazon Linux 2023 | 1 | 4 GiB | AWS 네이티브 경량 작업 |
| devenv-al2023-standard | Amazon Linux 2023 | 2 | 8 GiB | AWS 네이티브 일반 개발 |
| devenv-al2023-power | Amazon Linux 2023 | 4 | 12 GiB | AWS 네이티브 대규모 작업 |

---

## Dashboard 페이지 구성

| 페이지 | 접근 권한 | 주요 기능 |
|--------|----------|----------|
| Home | 전체 | 비용/토큰/사용자/컨테이너 요약, 클러스터 메트릭 |
| AI Assistant | 전체 | Bedrock Converse API 기반 대화형 AI, AgentCore Memory |
| Analytics | 전체 | 모델별 사용량, 부서별 비용, 일별 트렌드, 사용자 리더보드 |
| Monitoring | admin | Container Insights (CPU/Memory/Network), ECS 상태 |
| Security | admin | IAM 정책, DLP 현황, DNS Firewall 규칙, 보안 체크리스트 |
| Users | admin | Cognito 사용자 CRUD, 소팅/필터, 보안 정책 배정 |
| Containers | admin | ECS 컨테이너 시작/중지, 소팅/필터, 중복 방지 |
