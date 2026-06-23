# EBS Volume Lifecycle

EBS mode (`storageType: "ebs"`)에서 사용자 데이터(`/home/coder`)의 생성, 보존, 복원 흐름.

## Architecture Overview

```
┌──────────────┐    RunTask     ┌──────────────┐    StopTask      ┌──────────────┐
│  DynamoDB    │──snapshot_id──▶│  ECS Task    │────SIGTERM──────▶│  Lambda      │
│  cc-user-    │    + az        │  (running)   │    S3 backup     │ ebs-lifecycle│
│  volumes     │◀───────────────│  EBS mounted │                  │  snapshot_   │
│              │  update record │  /home/coder │                  │  and_detach  │
└──────────────┘                └──────────────┘                  └──────────────┘
     PK: user_id (subdomain)         │                                  │
     snapshot_id                     │ managedEBSVolume                 │ ec2.create_snapshot
     az                              │ snapshotId (optional)            │ ec2.delete_volume
     size_gb                         │ deleteOnTermination: false       │ DynamoDB update
     status                          │ filesystemType: ext4             │
```

## Key Constraint

> **ECS Managed EBS Volume은 기존 volume을 재연결(reattach)할 수 없다.**
> 매 `RunTask`마다 새 volume이 생성된다. 데이터 보존은 반드시 **snapshot → 새 volume 복원** 경로를 거쳐야 한다.

## Volume Lifecycle States

```
[없음] ──(첫 시작)──▶ [new_volume] ──(stop)──▶ [snapshot_stored] ──(재시작)──▶ [restored_volume]
                          │                         │                              │
                     gp3, ext4               snapshot 생성              snapshot에서 volume 복원
                     20GB default            volume 삭제                같은 AZ, 같은 size
```

DynamoDB `cc-user-volumes` 상태값:
- `available` — volume 활성, task 실행 중
- `warm_stopped` — idle timeout으로 정지됨
- `snapshot_stored` — snapshot 생성 완료, volume 삭제됨
- `resuming` — 복원 중

## Stop Flow (4가지 경로)

### 1. User Stop (사용자 직접 중지)

**경로:** `POST /api/user/container` → `action=stop`

```
1. deregisterContainerRoute(subdomain)     ← Nginx 라우팅 해제
2. stopContainer(taskArn)                  ← ECS StopTask (SIGTERM)
3. [컨테이너 내부] S3 full backup           ← SIGTERM handler (entrypoint.sh)
4. Lambda ebs-lifecycle: snapshot_and_detach ← async (InvocationType: Event)
   └─ EC2 CreateSnapshot → WaitForCompletion → DeleteVolume → DynamoDB update
```

**코드:** `shared/nextjs-app/src/app/api/user/container/route.ts` line 171-218

### 2. Admin Stop (관리자 중지)

**경로:** `DELETE /api/containers`

```
1. deregisterContainerRoute(subdomain)
2. stopContainer(taskArn)
3. Lambda ebs-lifecycle: snapshot_and_detach  ← async
```

**코드:** `shared/nextjs-app/src/app/api/containers/route.ts` line 170-198

### 3. Warm Stop (Idle Timeout Lambda)

**경로:** EventBridge (5분 주기) → `warm-stop.py` → `check_idle` → `warm_stop`

```
1. deregisterContainerRoute(subdomain)
2. ecs.stop_task(taskArn)
3. Lambda ebs-lifecycle: snapshot_and_detach  ← async
4. DynamoDB status → "warm_stopped"
5. SNS 알림 발송
```

**코드:** `cdk/lib/lambda/warm-stop.py` line 151-219

### 4. EOD Batch Shutdown (매일 18:00 KST)

**경로:** EventBridge (cron 09:00 UTC) → `warm-stop.py` → `schedule_shutdown`

모든 실행 중인 태스크를 순회하며 warm_stop 실행. 예외:
- `no_auto_stop` 태그가 있는 태스크
- `keep_alive_until`이 현재 시간 이후인 태스크
- 최근 15분 내 CPU/Network/Token 활성인 태스크
- `EOD_SHUTDOWN_ENABLED=false`이면 전체 비활성화

**코드:** `cdk/lib/lambda/warm-stop.py` line 290-365

## Start Flow

**경로:** `POST /api/user/container` → `action=start` → `startContainerWithProgress()`

```
1. DynamoDB cc-user-volumes 조회 (PK: subdomain)
   ├─ snapshot_id 있음 → snapshot에서 복원
   └─ snapshot_id 없음 → 새 빈 volume 생성

2. Capacity Provider: `cc-cp-devenv` (단일 multi-AZ, AZ 자동 배치)

3. ECS RunTask
   └─ volumeConfigurations:
        name: "user-data"
        managedEBSVolume:
          volumeType: gp3
          sizeInGiB: (DynamoDB size_gb 또는 20GB)
          snapshotId: (DynamoDB snapshot_id, 있으면)
          encrypted: true
          filesystemType: ext4
          terminationPolicy: deleteOnTermination: false

4. Volume mount: /data (task definition configuredAtLaunch: true)

5. [컨테이너 내부] entrypoint.sh EBS 초기화:
   ├─ mkdir -p /data/home /data/usr-local
   ├─ 최초 부팅: cp -a /usr/local/* → /data/usr-local/
   ├─ symlink: /usr/local → /data/usr-local (패키지 보존)
   ├─ symlink: /home/coder → /data/home (사용자 파일 보존)
   └─ s3-sync.sh restore: S3 → /home/coder (보조 복구 경로)

### EBS 보존 범위

| 경로 | EBS 위치 | 보존 대상 |
|------|----------|----------|
| `/home/coder` | `/data/home` (symlink) | 사용자 파일, 프로젝트, .bashrc, .config |
| `/usr/local` | `/data/usr-local` (symlink) | npm -g, pip, go install, 수동 바이너리 |
| `/usr/bin` 등 | Docker image | apt install (Dockerfile에 포함) |
```

**코드:** `shared/nextjs-app/src/lib/aws-clients.ts` line 900-958

## Idle Detection → Stop 판정 기준

```
EventBridge (5분 주기)
  └─ warm-stop Lambda: check_idle
       ├─ 시작 후 10분 이내 → skip (grace period)
       ├─ keep_alive_until > now → skip
       ├─ CPU > 5% → NOT idle
       ├─ Network > 1KB/s → NOT idle
       ├─ 최근 15분 Bedrock 토큰 사용 → NOT idle
       ├─ 30분 연속 idle → SNS 경고
       └─ 45분 연속 idle → warm_stop 실행
```

## EBS Lifecycle Lambda Actions

| Action | 설명 | 트리거 |
|--------|------|--------|
| `snapshot_and_detach` | volume → snapshot → volume 삭제 | 모든 stop 경로 |
| `restore_from_snapshot` | snapshot → 새 volume 생성 (지정 AZ) | warm_resume |
| `create_volume` | 새 빈 gp3 volume 생성 | 첫 사용자 |
| `modify_volume` | 기존 volume 리사이즈 | admin 승인 후 |

**코드:** `cdk/lib/lambda/ebs-lifecycle.py`

## DynamoDB Schema: `cc-user-volumes`

| Field | Type | 설명 |
|-------|------|------|
| `user_id` (PK) | String | 사용자 subdomain |
| `volume_id` | String | 현재 활성 volume ID (없으면 null) |
| `snapshot_id` | String | 마지막 snapshot ID |
| `az` | String | volume AZ (ap-northeast-2a 등) |
| `size_gb` / `currentSizeGb` | Number | volume 크기 (GB) |
| `status` | String | available / warm_stopped / snapshot_stored / resuming |
| `keep_alive_until` | String (ISO) | 자동 종료 보호 만료 시간 |
| `idle_minutes` | Number | 현재 idle 누적 분 |
| `task_id` | String | 현재 실행 중인 task ID |

## Data Persistence 보장

| 경로 | EBS Snapshot | S3 Backup | 비고 |
|------|:-----------:|:---------:|------|
| User Stop | O | O (SIGTERM) | `process.env.STORAGE_TYPE` 기반 |
| Admin Stop | O | O (SIGTERM) | |
| Warm Stop (idle) | O | O (SIGTERM) | |
| EOD Batch | O | O (SIGTERM) | |
| Task Crash | X | X | SIGTERM 미수신, 마지막 snapshot에서 복구 |

> **Fail-safe:** `deleteOnTermination: false`이므로 crash 시에도 EBS volume은 남아있음.
> 단, ECS managed volume은 재연결 불가하므로 수동으로 snapshot 생성 후 복구 필요.

## S3 Backup (보조 경로)

SIGTERM 수신 시 `entrypoint.sh`의 cleanup 함수가 실행:
```bash
aws s3 sync /home/coder s3://{S3_SYNC_BUCKET}/users/{USER_SUBDOMAIN}/home/ --delete
```

- `S3_SYNC_BUCKET` 환경변수 필요 (CDK task definition에서 설정)
- EBS snapshot이 primary, S3는 secondary backup
- 컨테이너 시작 시 `s3-sync.sh restore`로 S3에서 복구 가능

## Related Files

| File | 역할 |
|------|------|
| `cdk/lib/lambda/ebs-lifecycle.py` | EBS volume CRUD Lambda |
| `cdk/lib/lambda/warm-stop.py` | Idle detection + warm stop orchestrator |
| `cdk/lib/03-usage-tracking-stack.ts` | Lambda, EventBridge 규칙 CDK 정의 |
| `cdk/lib/04-ecs-devenv-stack.ts` | Task def EBS volume config (`configuredAtLaunch`) |
| `shared/nextjs-app/src/lib/aws-clients.ts` | `startContainerWithProgress()` EBS 복원 로직 |
| `shared/nextjs-app/src/app/api/user/container/route.ts` | User stop → snapshot 트리거 |
| `shared/nextjs-app/src/app/api/containers/route.ts` | Admin stop → snapshot 트리거 |
| `docker/devenv/scripts/entrypoint.sh` | SIGTERM → S3 backup handler |
| `docker/devenv/scripts/s3-sync.sh` | S3 sync 유틸리티 |

## Test Checklist

### 1. 파일 보존 테스트

```bash
# [1회차 시작]
# code-server 터미널에서:
echo "hello" > /home/coder/test-file.txt
ls /home/coder/test-file.txt   # 확인

# [대시보드에서 Stop]
# 확인: Lambda 로그에 "Found EBS volume vol-xxx" + "snapshot initiated"
# 확인: DynamoDB cc-user-volumes에 snapshot_id 저장됨

# [다시 Start]
cat /home/coder/test-file.txt  # "hello" 출력되면 성공
```

### 2. 패키지 보존 테스트 (/usr/local symlink)

```bash
# [1회차 시작]
# symlink 확인:
ls -la /usr/local              # → /data/usr-local 확인
ls -la /home/coder             # → /data/home 확인
cat /data/usr-local/.image-id  # 이미지 빌드 시간

# 패키지 설치:
npm install -g cowsay
cowsay "test"                  # 동작 확인
which cowsay                   # /usr/local/bin/cowsay (→ /data/usr-local/bin/cowsay)

pip install httpie             # PEP 668 해제됨 (Dockerfile에서 EXTERNALLY-MANAGED 삭제)
http --version                 # 동작 확인

# [대시보드에서 Stop → Start]
cowsay "survived"              # 동작하면 성공
http --version                 # 동작하면 성공

# 이미지 업데이트 시: /usr/local.bak에서 자동 재복사 (image-id 비교)
# 사용자 설치 패키지는 EBS에 유지, 시스템 패키지만 갱신
```

### 3. Snapshot 확인 (관리자)

```bash
# DynamoDB 확인
aws dynamodb scan --table-name cc-user-volumes \
  --query 'Items[*].{user:user_id.S,snapshot:snapshot_id.S,status:status.S}'

# EBS volume 확인 (orphan 없어야 함)
aws ec2 describe-volumes \
  --filters "Name=tag:managed_by,Values=cc-on-bedrock" \
  --query 'Volumes[*].{id:VolumeId,status:State,user:Tags[?Key==`user_id`].Value|[0]}'

# Lambda 로그 확인
aws logs filter-log-events \
  --log-group-name /aws/lambda/cc-on-bedrock-ebs-lifecycle \
  --start-time $(date -d '10 minutes ago' +%s)000 \
  --filter-pattern "snapshot"
```

### 4. Scale-in 확인

```bash
# 모든 devenv 태스크 중지 후 15분 대기
aws autoscaling describe-auto-scaling-groups \
  --query 'AutoScalingGroups[?contains(AutoScalingGroupName, `EcsAsg`)].{desired:DesiredCapacity,instances:Instances|length(@)}'
# desired가 줄어들면 성공 (dashboard 1대만 남음)
```

---

## Appendix: EFS 대안 검토 (ADR)

4000명 규모에서 EBS snapshot 복잡도를 줄이기 위해 EFS 전환을 검토했으나, 아래 이유로 EBS 유지를 결정.

### 검토한 방식

#### A. EFS 1개 + Access Point

```
EFS (fs-xxx)
  ├── AP: /users/user01   → task A의 /home/coder
  ├── AP: /users/user02   → task B의 /home/coder
  └── ...
```

- **장점:** snapshot 불필요, AZ 관리 불필요, 아키텍처 단순
- **제약:** Access Point **1,000개/EFS 한도** → 4,000명 불가

#### B. EFS 샤딩 (ASG 그룹별 EFS)

```
ASG-1 (users 1-100)   → EFS-1   → CP: cc-cp-group-1
ASG-2 (users 101-200)  → EFS-2   → CP: cc-cp-group-2
...
ASG-40                 → EFS-40  → CP: cc-cp-group-40
```

- **장점:** Access Point 한도 해결, 성능 격리
- **제약:** ECS task definition의 `fileSystemId`는 **등록 시 고정** (`RunTask` override 불가)
  → task def 6종 × 40그룹 = **240개 task definition** 필요
  → 관리 복잡도가 EBS보다 높음

#### C. Docker Bind Mount (EC2 호스트에서 EFS NFS mount)

```
EC2 Instance (UserData):
  mount -t nfs4 fs-xxx:/ /mnt/efs

Container:
  /mnt/efs/users/{subdomain} → /home/coder  (bind mount)
```

- **장점:** Access Point 불필요, EFS 1개로 4000명 가능
- **제약:** ECS `RunTask`에서 **host volume path를 동적으로 변경 불가**
  → task definition의 `host.sourcePath`는 고정
  → 우회법: entrypoint에서 `mount --bind` → **SYS_ADMIN capability 필요** (보안 문제)
  → 또는 symlink 우회 가능하나 race condition 위험

### 결정: EBS 유지

| 기준 | EBS (현재) | EFS 대안들 |
|------|:---------:|:---------:|
| 4000명 대응 | ✅ | △~❌ (한도/복잡도) |
| 성능 격리 | ✅ (유저별 독립 volume) | △ (공유 I/O) |
| 아키텍처 복잡도 | 중 (snapshot 관리) | 높 (240 task def 또는 보안 우회) |
| 데이터 안정성 | ✅ (snapshot + S3 이중) | ✅ |
| AWS 권장 패턴 | ✅ (ECS managed EBS) | △ (bind mount는 비표준) |

EBS snapshot 흐름은 복잡하지만, 이미 검증된 구현이 있고 모든 stop 경로에서 snapshot이 보장되도록 수정 완료됨.
