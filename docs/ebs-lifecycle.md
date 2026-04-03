# EBS Volume Lifecycle

EBS mode (`storageType: "ebs"`)에서 사용자 데이터(`/home/coder`)의 생성, 보존, 복원 흐름.

## Architecture Overview

```
┌──────────────┐    RunTask     ┌──────────────┐    StopTask     ┌──────────────┐
│  DynamoDB    │───snapshot_id──▶│  ECS Task    │────SIGTERM──────▶│  Lambda      │
│  cc-user-    │    + az        │  (running)   │    S3 backup     │  ebs-lifecycle│
│  volumes     │◀───────────────│  EBS mounted │                  │  snapshot_   │
│              │  update record │  /home/coder │                  │  and_detach  │
└──────────────┘                └──────────────┘                  └──────────────┘
     PK: user_id (subdomain)         │                                  │
     snapshot_id                      │ managedEBSVolume                │ ec2.create_snapshot
     az                               │ snapshotId (optional)           │ ec2.delete_volume
     size_gb                          │ deleteOnTermination: false       │ DynamoDB update
     status                           │ filesystemType: ext4             │
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

2. AZ 결정
   ├─ DynamoDB에 az 있음 → 같은 AZ의 capacity provider 선택 (cc-cp-a / cc-cp-b)
   └─ az 없음 → 기본 capacity provider

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

4. Volume mount: /home/coder (task definition configuredAtLaunch: true)

5. [컨테이너 내부] S3 restore (entrypoint.sh)
   └─ s3-sync.sh restore: S3 → /home/coder (보조 복구 경로)
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
