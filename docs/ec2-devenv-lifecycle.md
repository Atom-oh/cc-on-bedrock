# EC2 DevEnv Instance Lifecycle

EC2-per-user 모드에서 개발 환경 인스턴스의 생성, 보존, 복구 흐름.

## Architecture Overview

```
┌──────────────┐  RunInstances  ┌──────────────┐  StopInstances  ┌──────────────┐
│  DynamoDB    │──instance_id──▶│  EC2 Instance │────────────────▶│  Stopped     │
│  cc-user-    │                │  (running)    │   EBS 자동 보존  │  (EBS 유지)  │
│  instances   │◀──status───────│  code-server  │                 │  비용 $0     │
└──────────────┘                └──────────────┘                  └──────┬───────┘
     PK: user_id (subdomain)                                            │
     instance_id                 StartInstances ◀───────────────────────┘
     status                      30-75초 부팅 → 모든 상태 보존
```

## Key Advantage over ECS

> **EC2 Stop/Start는 EBS volume을 자동 보존한다.**
> Snapshot 불필요, S3 백업 불필요, symlink hack 불필요.
> apt, npm -g, pip 패키지 포함 모든 시스템 상태가 완벽 보존됨.

## Instance Lifecycle States

```
[없음] ──(첫 접속)──▶ [running] ──(idle/user stop)──▶ [stopped] ──(재접속)──▶ [running]
                         │                               │                       │
                    AMI에서 생성                      EBS 보존               StartInstances
                    code-server 자동시작              비용 $0                30-75초
```

## Start Flow

**경로:** `POST /api/user/container` → `action=start`

```
1. DynamoDB cc-user-instances 조회 (PK: subdomain)
   ├─ instance_id 있음 + stopped → StartInstances (30-75초)
   ├─ instance_id 있음 + running → 이미 실행 중
   └─ instance_id 없음 → RunInstances from AMI (첫 사용자)

2. AMI: /cc-on-bedrock/devenv/ami-id (SSM Parameter)
   포함: Ubuntu 24.04 ARM64, Node.js 20, Python 3.12, AWS CLI 2,
         code-server 4.96, Claude Code, Kiro, uv

3. Launch Template: cc-on-bedrock-devenv
   └─ Instance type: t4g.large (config.devenvInstanceType)
   └─ EBS root: 30GB gp3, encrypted, deleteOnTermination: false
   └─ SG: DLP policy별 (open/restricted/locked)
   └─ SSH 비활성 (port 22 없음), SSM Session Manager only

4. Nginx routing: cc-routing-table DynamoDB에 {subdomain → privateIp:8080} 등록

5. code-server: systemd 자동 시작 (enabled)
```

**코드:** `shared/nextjs-app/src/lib/ec2-clients.ts` → `startInstance()`

## Stop Flow

**경로:** `POST /api/user/container` → `action=stop`

```
1. Nginx routing 해제 (DynamoDB cc-routing-table에서 삭제)
2. StopInstances (EBS 자동 보존)
3. DynamoDB status → "stopped"
```

Snapshot, S3 sync, volume detach 전부 불필요.

**코드:** `shared/nextjs-app/src/lib/ec2-clients.ts` → `stopInstance()`

## Idle Detection

**경로:** EventBridge (5분 주기) → `ec2-idle-stop` Lambda

```
AWS/EC2 표준 CloudWatch 메트릭:
  ├─ CPUUtilization < 5% → idle
  ├─ NetworkIn + NetworkOut < 1KB/s → idle
  ├─ Bedrock token 사용 (DynamoDB) → active
  ├─ keep_alive_until > now → skip
  ├─ 30분 연속 idle → SNS 경고
  └─ 45분 연속 idle → StopInstances

EOD Batch (18:00 KST): 모든 running 인스턴스 순회
  ├─ no_auto_stop 태그 → skip
  ├─ keep_alive_until → skip
  ├─ 15분 내 활성 → skip
  └─ 나머지 → StopInstances
```

**코드:** `cdk/lib/lambda/ec2-idle-stop.py` (~220줄)

## AZ 장애 복구 (Admin Only)

일반 운영에서는 불필요. AZ 장애 시에만:

```
1. 장애 AZ의 인스턴스 EBS에서 Snapshot 생성
2. 다른 AZ에서 새 인스턴스 생성 (AMI)
3. Snapshot에서 EBS volume 생성 → 새 인스턴스에 attach
4. DynamoDB instance_id 업데이트
```

## DynamoDB Schema: `cc-user-instances`

| Field | Type | 설명 |
|-------|------|------|
| `user_id` (PK) | String | 사용자 subdomain |
| `instanceId` | String | EC2 인스턴스 ID |
| `username` | String | 사용자 이메일 |
| `department` | String | 부서 |
| `securityPolicy` | String | open / restricted / locked |
| `instanceType` | String | t4g.large 등 |
| `privateIp` | String | VPC private IP |
| `status` | String | running / stopped |
| `keep_alive_until` | String (ISO) | 자동 종료 보호 만료 시간 |
| `createdAt` | String (ISO) | 최초 생성 시간 |
| `updatedAt` | String (ISO) | 마지막 업데이트 |

## Data Persistence

| 경로 | 보존 | 비고 |
|------|:---:|------|
| User Stop | ✅ | EBS 자동 보존 |
| Admin Stop | ✅ | EBS 자동 보존 |
| Idle Stop | ✅ | EBS 자동 보존 |
| EOD Batch | ✅ | EBS 자동 보존 |
| Instance Crash | ✅ | EBS는 인스턴스와 독립 |
| AZ 장애 | ✅ | Admin Snapshot → 다른 AZ 복구 |

## ECS 대비 제거된 것

| 구성요소 | ECS | EC2 |
|---------|:---:|:---:|
| EBS snapshot/restore | 필요 | 불필요 |
| S3 sync (s3-sync.sh) | 필요 | 불필요 |
| ebs-lifecycle Lambda (486줄) | 필요 | 제거 |
| warm-stop Lambda (760줄) | 필요 | ec2-idle-stop (220줄) |
| DynamoDB cc-user-volumes | 필요 | 제거 |
| Docker entrypoint symlink hack | 필요 | 제거 |
| /usr/local.bak + image-id | 필요 | 제거 |
| idle-monitor.sh | 필요 | 제거 (AWS/EC2 표준 메트릭) |
| ECS_IMAGE_PULL_BEHAVIOR | 필요 | 해당없음 |

## AMI 빌드

```bash
bash scripts/build-ami.sh t4g.large 30
```

1. Ubuntu 24.04 ARM64 기본 AMI에서 임시 인스턴스 시작
2. SSM으로 setup-common.sh + setup-claude-code.sh + setup-kiro.sh 실행
3. CloudWatch Agent + code-server systemd 서비스 설정
4. 인스턴스 Stop → AMI 생성 → SSM Parameter Store 저장
5. 임시 인스턴스 Terminate

결과: AMI ID → `/cc-on-bedrock/devenv/ami-id` (SSM Parameter)

## Related Files

| File | 역할 |
|------|------|
| `cdk/lib/07-ec2-devenv-stack.ts` | EC2 인프라 (Launch Template, SG, IAM, DynamoDB) |
| `cdk/lib/lambda/ec2-idle-stop.py` | Idle detection + StopInstances |
| `shared/nextjs-app/src/lib/ec2-clients.ts` | EC2 lifecycle (start/stop/list) |
| `shared/nextjs-app/src/app/api/user/container/route.ts` | User Start/Stop API |
| `shared/nextjs-app/src/app/api/containers/route.ts` | Admin 관리 API |
| `scripts/build-ami.sh` | AMI 빌드 스크립트 |
| `docker/devenv/scripts/setup-common.sh` | AMI 설치 스크립트 (재사용) |
| `docs/decisions/ADR-004-ec2-per-user-devenv.md` | 아키텍처 결정 문서 |
