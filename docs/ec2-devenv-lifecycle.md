# EC2 DevEnv Instance Lifecycle

EC2-per-user 모드에서 개발 환경 인스턴스의 생성, 보존, 복구 흐름.

## Architecture Overview

```
┌──────────────┐  RunInstances  ┌──────────────┐  StopInstances  ┌──────────────┐
│  DynamoDB    │──instance_id──▶│  EC2 Instance │────────────────▶│  Stopped     │
│  cc-user-    │   dataVolumeId │  (running)    │  두 EBS 모두 보존 │  (EBS 유지)  │
│  instances   │◀──status───────│  code-server  │                 │  비용 $0     │
└──────────────┘                └──────────────┘                  └──────┬───────┘
     PK: user_id (subdomain)                                            │
     instanceId, dataVolumeId    StartInstances ◀───────────────────────┘
     dataVolumeAz, status        30-75초 부팅 → 모든 상태 보존
```

## 2-Volume 모델 (ADR-032)

> per-user EC2는 **2개의 EBS 볼륨**으로 구성된다:
> - **Root EBS (ephemeral OS)** — AMI에서 옴. OS·시스템 패키지·code-server 바이너리.
>   교체 가능. 사용자 데이터를 담지 않는다.
> - **Data EBS (persistent)** — `/home/coder` 전체(workspace + `.claude` + dotfiles 등).
>   `DeleteOnTermination=false`, subdomain 태그로 식별되어 재생성·AMI교체·OS전환을
>   가로질러 재연결된다. **이것이 영속의 권위 단위다.**
>
> 권위 식별자는 DynamoDB `cc-user-instances`의 `dataVolumeId` + `dataVolumeAz`이며,
> 마운트는 device name이 아닌 EBS volume-id 기준이다(LABEL=CCDATA). 상세는 ADR-032.

## Key Advantage over ECS

> **EC2 Stop/Start는 두 EBS volume을 자동 보존한다.**
> Snapshot 불필요, S3 백업 불필요, symlink hack 불필요.
> apt, npm -g, pip 패키지 포함 모든 시스템 상태가 완벽 보존됨.

## Instance Lifecycle States

```
[없음] ──(첫 접속)──▶ [running] ──(idle/user stop)──▶ [stopped] ──(재접속)──▶ [running]
                         │                               │                       │
                    AMI + data EBS 생성              두 EBS 보존            StartInstances
                    code-server 자동시작              비용 $0                30-75초
```

## Start Flow

**경로:** `POST /api/user/container` → `action=start`

```
1. DynamoDB cc-user-instances 조회 (PK: subdomain)
   ├─ instanceId 있음 + stopped → StartInstances (30-75초, data EBS attached 유지)
   ├─ instanceId 있음 + running → 이미 실행 중
   ├─ instanceId 없음 + dataVolumeId 있음 → 데이터 볼륨 AZ에 핀해 재생성 후 reattach
   └─ instanceId 없음 + dataVolumeId 없음 → 신규 사용자 (born-attached, 아래 3)

2. AMI: /cc-on-bedrock/devenv/ami-id (SSM Parameter)
   포함: Amazon Linux 2023 ARM64, Node.js 20, Python 3.12, AWS CLI 2,
         code-server, Claude Code, Kiro, uv,
         cc-data-migrate.service (born-attached/재연결 시 /home/coder 마운트)

3. Launch Template: cc-on-bedrock-devenv + RunInstances BlockDeviceMappings
   └─ Instance type: t4g.large (var.devenv_instance_type)
   └─ Root EBS: 30GB gp3, encrypted (ephemeral OS)
   └─ Data EBS: /dev/sdf, gp3, encrypted, DeleteOnTermination=false (신규 시 born-attached)
   │           launch 후 volume-id 해석 → CreateTags(cc:role=data) → DynamoDB dataVolumeId/Az 기록
   └─ SG: DLP policy별 (open/restricted/locked)
   └─ SSH 비활성 (port 22 없음), SSM Session Manager only

4. Nginx routing: cc-routing-table DynamoDB에 {subdomain → privateIp:8080} 등록

5. /home/coder 마운트: cc-data-migrate.service가 dataVolumeId attach 대기 후 마운트
   (빈 볼륨이면 mkfs LABEL=CCDATA, 기존 FS면 마운트만)

6. code-server: systemd 자동 시작 (enabled)
```

**코드:** `shared/nextjs-app/src/lib/ec2-clients.ts` → `startInstance()`
(데이터 볼륨 로직: `data-volume.ts`, `data-volume-userdata.ts`, `data-volume-ssm.ts`)
**Terraform:** `terraform/modules/ec2-devenv/` (launch template, cc-user-instances 테이블)

## Stop Flow

**경로:** `POST /api/user/container` → `action=stop`

```
1. Nginx routing 해제 (DynamoDB cc-routing-table에서 삭제)
2. StopInstances (두 EBS 모두 attached 유지, 전원만 off)
3. DynamoDB status → "stopped"
```

Snapshot, S3 sync, volume detach 전부 불필요. 데이터 볼륨은 root와 함께 attach된 채 유지된다.

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

**코드:** `lambda/ec2-idle-stop.py` (~220줄)
**Terraform:** EventBridge schedule + Lambda 배선은 `terraform/modules/usage-tracking/`,
hibernation schedule은 `terraform/modules/ec2-devenv/`.

## AZ 장애 복구 (Admin Only)

일반 운영에서는 불필요. 데이터는 persistent data EBS에 있으므로(ADR-032),
같은 AZ 재생성은 단순 reattach다. **다른 AZ로의 이전만** 아래 절차가 필요하다:

```
1. (가능하면) 장애 AZ의 데이터 볼륨에서 Snapshot 생성
2. 다른 AZ에서 Snapshot → EBS volume 복원 (EBS는 AZ 종속)
3. 그 AZ의 Subnet에 핀해 새 인스턴스 생성 (root AMI) → 데이터 볼륨 reattach
4. DynamoDB instanceId / dataVolumeId / dataVolumeAz 업데이트
```

데이터 볼륨이 살아있으면(같은 AZ) Snapshot 없이 terminate → 재생성 → reattach로 무손실 복구된다.

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
| `dataVolumeId` | String | persistent data EBS volume-id (ADR-032, 마운트 권위 식별자) |
| `dataVolumeAz` | String | data EBS의 AZ (재연결 launch를 이 AZ Subnet에 핀) |
| `keep_alive_until` | String (ISO) | 자동 종료 보호 만료 시간 |
| `createdAt` | String (ISO) | 최초 생성 시간 |
| `updatedAt` | String (ISO) | 마지막 업데이트 |

## Data Persistence

보존되는 것은 **data EBS(`/home/coder`)**다. root EBS(OS)는 교체 가능한 ephemeral 볼륨이다.

| 경로 | `/home/coder` 보존 | 비고 |
|------|:---:|------|
| User / Admin / Idle Stop | ✅ | 두 EBS attached 유지, 전원만 off |
| EOD Batch | ✅ | 동일 (StopInstances) |
| Instance Crash | ✅ | data EBS는 인스턴스와 독립 |
| **Terminate** | ✅ | data EBS `DeleteOnTermination=false` → `available`로 남아 다음 launch에서 reattach |
| **OS 전환 (switchOs)** | ✅ | 옛 인스턴스에서 unmount/detach → terminate → 타깃 OS AMI 새 인스턴스에 reattach |
| **EBS resize** | ✅ | data 볼륨만 ModifyVolume + resize2fs (OS root 미변경) |
| AZ 장애 (다른 AZ) | ✅ | data 볼륨 Snapshot → 타깃 AZ 복원 → reattach |
| Admin "사용자 완전 삭제" | ✗ | 의도적 `DeleteVolume` (detach → available 대기 → 선택적 final snapshot → 삭제) |

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

1. Amazon Linux 2023 ARM64 기본 AMI에서 임시 인스턴스 시작
2. SSM으로 setup-common.sh + setup-claude-code.sh + setup-kiro.sh 실행
3. CloudWatch Agent + code-server systemd 서비스 설정
4. `cc-data-migrate.service` 베이크 (ADR-032: /home/coder data EBS 마운트/마이그레이션, oneshot, Before=code-server)
5. 인스턴스 Stop → AMI 생성 → SSM Parameter Store 저장
6. 임시 인스턴스 Terminate

결과: AMI ID → `/cc-on-bedrock/devenv/ami-id` (SSM Parameter)

## Related Files

| File | 역할 |
|------|------|
| `terraform/modules/ec2-devenv/` | EC2 인프라 (Launch Template, SG, IAM, cc-user-instances DynamoDB, hibernation schedule) |
| `terraform/modules/usage-tracking/` | ec2-idle-stop Lambda + EventBridge schedule 배선 |
| `lambda/ec2-idle-stop.py` | Idle detection + StopInstances |
| `shared/nextjs-app/src/lib/ec2-clients.ts` | EC2 lifecycle (start/stop/terminate/switchOs/list) |
| `shared/nextjs-app/src/lib/data-volume.ts` (+ `data-volume-userdata.ts`, `data-volume-ssm.ts`) | ADR-032 data EBS 프로비저닝/마운트/마이그레이션 |
| `shared/nextjs-app/src/app/api/user/container/route.ts` | User Start/Stop API |
| `shared/nextjs-app/src/app/api/containers/route.ts` | Admin 관리 API |
| `shared/nextjs-app/src/app/api/admin/ebs-resize/route.ts` | EBS resize (data 볼륨 리타겟) |
| `scripts/build-ami.sh` | AMI 빌드 스크립트 |
| `docker/devenv/scripts/setup-common.sh` | AMI 설치 스크립트 (재사용) |
| `docs/decisions/ADR-032-persistent-data-ebs.md` | 2-볼륨 영속 데이터 EBS 결정 |
| `docs/decisions/ADR-033-cdk-to-terraform-migration.md` | IaC 단일화 (CDK → Terraform) |
| `docs/decisions/BASELINE.md` | 결정 단일 현행 진실 (ADR 002 = DevEnv 컴퓨트·스토리지) |
