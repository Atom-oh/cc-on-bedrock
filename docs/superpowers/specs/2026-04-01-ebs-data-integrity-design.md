# EBS Data Integrity & Host Attach Design

## Overview
CC-on-Bedrock의 EBS 볼륨 라이프사이클 전면 개선. 3-Phase 단계적 접근으로 데이터 무결성 확보 → 볼륨 직접 재사용 → 코드 품질 개선.

## Background

### 현재 문제점 (리뷰에서 발견)
1. **Orphan EBS 볼륨 누적**: `deleteOnTermination: false` + ECS-managed 볼륨 삭제 skip → 매 stop/start마다 볼륨 1개씩 증가
2. **EBS 조회 실패 시 데이터 손실**: snapshot_id 조회 실패 → 빈 볼륨으로 시작 (사용자 인지 불가)
3. **스냅샷 Lambda 실패 무시**: 스냅샷 없이 다음 시작 시 빈 볼륨 생성 가능
4. **DDB 스키마 불일치**: Lambda(snake_case)와 Dashboard(camelCase) 간 필드명 불일치
5. **UI 상태 누락**: admin이 "assigned" 완료해도 UI가 인식 못함
6. **시작 시간 느림**: 매번 snapshot에서 볼륨 재생성 (수분 소요)

### 핵심 제약: ECS Managed EBS Volume
- `configuredAtLaunch: true`로 선언된 ECS 관리형 볼륨은 **매 RunTask마다 새 볼륨 생성**
- AWS API에 `volumeId` 파라미터 없음 → 기존 볼륨 재연결 불가
- `snapshotId`만 지정 가능 → 스냅샷에서 복원만 지원
- Kubernetes PVC/PV와 달리 ECS에는 볼륨 재바인딩 개념 없음

## Phase 로드맵

```
Phase 1 ──→ Phase 2 ──→ Phase 3
데이터 보호    볼륨 재사용    코드 품질
(~50줄)      (새 Lambda)   (리팩터링)
```

---

## Phase 1: Snapshot 기반 데이터 무결성

### 목표
최소 변경으로 데이터 손실 위험 제거, orphan 볼륨 정리, UI 상태 수정.

### 변경 사항

#### 1. `deleteOnTermination: true` (aws-clients.ts)
```typescript
// startContainer() 및 startContainerWithProgress() 두 곳
terminationPolicy: { deleteOnTermination: true }  // was: false
```
- ECS가 Task 종료 시 볼륨 자동 삭제
- **중요**: Lambda `snapshot_and_detach`는 비동기(`InvocationType: "Event"`)로 호출됨. ECS의 볼륨 삭제와 경쟁 조건 가능. 따라서 **Stop API에서 Lambda를 동기 호출(`RequestResponse`)로 변경**하여 snapshot 완료 후 Task를 중지해야 함. 또는 Lambda에서 `InvalidVolume.NotFound` 시 DDB의 기존 snapshot_id를 유지(이전 snapshot이 여전히 유효)
- Orphan 볼륨 0개 보장

#### 2. EBS 조회 실패 시 사용자 경고 (aws-clients.ts + stream/route.ts)
```typescript
// startContainerWithProgress() 내부
let snapshotLookupFailed = false;
try {
  // DDB(cc-user-volumes) 조회...
} catch (err) {
  snapshotLookupFailed = true;
  onProgress(5, "container_start", "in_progress",
    "⚠ 이전 데이터 복원 실패 — 빈 볼륨으로 시작합니다");
}
```
- 사용자가 데이터 손실을 인지할 수 있음
- 시작은 차단하지 않음 (사용자 선택)

#### 3. Stop 시 Lambda 실패 경고 (container/route.ts)
```typescript
// EBS snapshot Lambda 호출 실패 시
} catch (err) {
  console.warn("[user/container] EBS snapshot trigger failed:", err);
  // 응답에 warning 포함
  return NextResponse.json({
    success: true,
    warning: "Container stopped but snapshot backup failed"
  });
}
```

#### 4. ebs-lifecycle.py 정리
- `deleteOnTermination: true`이므로 ECS가 볼륨 삭제
- Lambda의 볼륨 삭제 시도 시 "InvalidVolume.NotFound" → 정상 처리 (이미 삭제됨)
- ECS-managed 태그 검사 로직 단순화

```python
# snapshot_and_detach() 내 볼륨 삭제 부분
try:
    ec2.delete_volume(VolumeId=volume_id)
    logger.info(f"Deleted volume {volume_id}")
except ClientError as e:
    if e.response["Error"]["Code"] == "InvalidVolume.NotFound":
        logger.info(f"Volume {volume_id} already deleted (ECS deleteOnTermination)")
    else:
        logger.warning(f"Volume {volume_id} deletion failed: {e}")
```

#### 5. DDB 필드명 통일
- **표준**: Lambda의 snake_case (`snapshot_id`, `size_gb`)
- Dashboard 읽기 시 양쪽 호환 유지 (기존 데이터 마이그레이션 불필요):
```typescript
ebsSnapshotId = volResult.Item?.snapshot_id?.S;  // snake_case 우선
const sizeStr = volResult.Item?.size_gb?.N;       // snake_case 우선
```

#### 6. UI assigned 상태 반영 (environment-tab.tsx)
```typescript
setRequestStatus(
  data.data.status === "pending" ? "pending"
  : data.data.status === "approved" ? "approved"
  : data.data.status === "assigned" ? "approved"  // ← 추가
  : "none"
);
```

### 변경 파일 요약

| 파일 | 변경 |
|------|------|
| `shared/nextjs-app/src/lib/aws-clients.ts` | deleteOnTermination, snapshot 경고, DDB 필드명 |
| `shared/nextjs-app/src/app/api/user/container/stream/route.ts` | snapshot 실패 SSE 이벤트 |
| `shared/nextjs-app/src/app/api/user/container/route.ts` | Stop 시 warning 응답 |
| `cdk/lib/lambda/ebs-lifecycle.py` | ECS-managed 검사 제거, NotFound 정상 처리 |
| `shared/nextjs-app/src/components/user/environment-tab.tsx` | assigned 상태 매핑 |

---

## Phase 2: Host Attach 아키텍처

### 목표
ECS managed volume 제거. Lambda가 기존 EBS를 EC2 호스트에 직접 attach → host mount. 시작 시간 수분 → 수초.

### 새로운 컴포넌트

| 컴포넌트 | 유형 | 역할 |
|----------|------|------|
| `ebs-attach-lambda` | Lambda (Python) | Pre-start: 볼륨 attach + SSM mount |
| `ebs-detach-lambda` | Lambda (Python) | Post-stop: SSM unmount + detach + DR snapshot |
| EventBridge Rule | ECS Task State Change | Task STOPPED → detach Lambda 자동 트리거 |

### 전체 흐름

#### 컨테이너 시작
```
1. DDB(cc-user-volumes) 조회 → volume_id, AZ
   ├─ volume_id 있음 → 기존 볼륨 사용
   └─ volume_id 없음 (신규) → ec2:CreateVolume → DDB 저장

2. 해당 AZ의 ECS EC2 인스턴스 목록 조회
   → ecs:ListContainerInstances + DescribeContainerInstances
   → ec2InstanceId 매핑
   → attach 가능한 인스턴스 선택 (device slot 여유 + running task 수 최소 기준)

3. ec2:AttachVolume(volume_id, instance_id, /dev/xvd{f-p})
   → waiter: volume_status == "in-use"

4. SSM RunCommand → instance_id
   "mkdir -p /mnt/users/{subdomain} && mount /dev/xvd{x} /mnt/users/{subdomain}"

5. RegisterTaskDefinition (매 시작마다 새 revision)
   volumes: [{ name: "user-data", host: { sourcePath: "/mnt/users/{subdomain}" } }]
   ※ configuredAtLaunch 제거

6. RunTask
   placementConstraints: [{ type:"memberOf",
     expression:"ec2InstanceId == {instance_id}" }]
```

#### 컨테이너 종료
```
EventBridge(ECS Task State Change: STOPPED)
  → ebs-detach-lambda
    1. SSM RunCommand → "umount /mnt/users/{subdomain}"
    2. ec2:DetachVolume
    3. DDB 상태 업데이트: status = "detached"
    4. (비동기) Snapshot 생성 — DR 백업용만
```

### Device Name 관리

한 EC2에 여러 유저 볼륨이 attach 가능:

```python
DEVICE_RANGE = [f"/dev/xvd{c}" for c in "fghijklmnop"]  # 11 slots

def find_available_device(instance_id):
    attached = ec2.describe_volumes(
        Filters=[{"Name": "attachment.instance-id", "Values": [instance_id]}]
    )
    used_devices = {
        att["Device"]
        for v in attached["Volumes"]
        for att in v["Attachments"]
    }
    for dev in DEVICE_RANGE:
        if dev not in used_devices:
            return dev
    raise Exception("No available device slots")
```

DDB `cc-user-volumes`에 `device_name` 필드 추가 → detach/unmount 시 참조.

### SSE 프로비저닝 단계 변경

```
Phase 1 (7단계):
  1.IAM → 2.EFS AP → 3.TaskDef → 4.Password → 5.Container → 6.Route → 7.Health

Phase 2 (8단계):
  1.IAM → 2.Volume Attach → 3.Host Mount → 4.TaskDef → 5.Password → 6.Container → 7.Route → 8.Health
```

Step 2-3이 새로 추가, EFS AP 단계는 EBS 모드에서 Volume Attach로 대체.

### CDK 변경

| 스택 | 변경 |
|------|------|
| `04-ecs-devenv-stack.ts` | EBS task def에서 `configuredAtLaunch` 제거, EBS infrastructure role 불필요 |
| 신규 또는 `03-usage-tracking-stack.ts` | ebs-attach Lambda, ebs-detach Lambda, EventBridge Rule |
| `02-security-stack.ts` | Lambda IAM: `ec2:AttachVolume`, `ec2:DetachVolume`, `ec2:DescribeVolumes`, `ssm:SendCommand`, `ecs:DescribeContainerInstances` |

### Fallback 전략

| 실패 시나리오 | 대응 |
|--------------|------|
| 볼륨 attach 실패 | 에러 반환, 시작 중단 |
| SSM mount 실패 | detach rollback 후 에러 반환 |
| 볼륨이 다른 인스턴스에 attached | force-detach 후 재시도 (1회) |
| AZ 장애 (볼륨 접근 불가) | DDB snapshot_id로 다른 AZ에 새 볼륨 생성 → attach |
| EC2 인스턴스 부족 | ASG scale-out 대기 또는 에러 |

### DDB 스키마 확장 (cc-user-volumes)

```
기존: user_id, az, volume_id, snapshot_id, size_gb, status, s3_path, last_sync
추가: device_name, attached_instance_id, attached_at
```

---

## Phase 3: 코드 품질 (향후)

| 이슈 | 설명 |
|------|------|
| `startContainer` / `startContainerWithProgress` 통합 | `_startContainerCore()` 내부 함수 추출 |
| DDB Scan → Query | approval-requests에 email GSI, LastEvaluatedKey 페이징 |
| department 하드코딩 | `user.department`를 세션에서 읽도록 수정 |
| approval-requests assign에서 GetItem 사용 | Scan 대신 PK(`REQUEST#${requestId}`) 직접 조회 |

---

## Phase 간 의존성

- Phase 1의 DDB 필드명 통일(snake_case)이 Phase 2 Lambda에서 그대로 사용됨
- Phase 2 완료 시 Phase 1의 `deleteOnTermination: true`는 자연히 불필요 (ECS managed volume 제거)
- Phase 2 완료 시 Phase 1의 snapshot 경고 로직은 Host Attach 실패 경고로 대체
- Phase 3의 코드 통합은 Phase 2 이후 수행하는 것이 효율적 (한 곳만 수정)
