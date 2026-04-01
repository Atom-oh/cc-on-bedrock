# EBS/S3 라이프사이클 리뷰 (2026-03-31, 정정판)

> Scope: ebs-lifecycle.py, warm-stop.py, entrypoint.sh, s3-sync.sh, aws-clients.ts (startContainer)

---

## 배경: ECS EBS 네이티브 지원

[AWS 공식 문서](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/ebs-volumes.html)에 따르면:

- **ECS가 EBS를 태스크에 자동 attach/detach** — `RunTask`의 `volumeConfigurations` 파라미터 사용
- Task Definition에서 `configuredAtLaunch: true`로 선언 → 런타임에 볼륨 설정
- **스냅샷에서 복원 가능** — `snapshotId` 지정하면 기존 데이터로 볼륨 생성
- **Infrastructure IAM Role** 필요 (`AmazonECSInfrastructureRolePolicyForVolumes`)
- 태스크당 EBS 1개 제한, 기존 볼륨 직접 attach 불가 (새 볼륨 또는 스냅샷만)
- EC2 모드: Nitro 인스턴스 + ECS-optimized AMI 20231219+ 필요

---

## 요약

| 항목 | 상태 |
|------|------|
| EBS 볼륨 생성 + 태그 | ✅ 정상 (ebs-lifecycle.py) |
| EBS 스냅샷/복원 (AZ 이동) | ✅ 로직 정상 (ebs-lifecycle.py) |
| DynamoDB 메타데이터 관리 | ✅ 정상 |
| **RunTask에 volumeConfigurations 미사용** | ❌ **미구현** |
| **ECS Infrastructure IAM Role 미생성** | ❌ **미구현** |
| **startContainer에서 EBS 스냅샷 복원 미연동** | ❌ **미구현** |
| S3 backup (stop 시 SIGTERM) | ✅ 정상 |
| S3 restore (start 시) | ✅ 정상 |
| S3 증분 sync (5분 cron) | ✅ 정상 |
| 숨김파일 포함 여부 | ✅ aws s3 sync 기본 포함 |
| workspace 외 설정파일 백업 | ⚠️ 미포함 |

---

## CRITICAL (2건)

### 1. RunTask에 EBS volumeConfigurations 미사용

- **파일:** `shared/nextjs-app/src/lib/aws-clients.ts:startContainer` (RunTaskCommand)
- **이슈:** 현재 `RunTaskCommand`에 `volumeConfigurations` 파라미터가 없음. ECS 네이티브 EBS 지원을 사용하려면 RunTask 시 다음이 필요:

```typescript
volumeConfigurations: [{
  name: "user-workspace",
  managedEBSVolume: {
    roleArn: infrastructureRoleArn,  // ECS Infrastructure IAM Role
    volumeType: "gp3",
    sizeInGiB: 20,
    snapshotId: userSnapshotId,      // 이전 스냅샷에서 복원
    tagSpecifications: [{
      resourceType: "volume",
      tags: [
        { key: "user_id", value: input.subdomain },
        { key: "managed_by", value: "cc-on-bedrock" },
      ],
    }],
  },
}]
```

- **영향:** EBS 모드 선택해도 ECS가 EBS를 태스크에 attach하지 않음. EFS만 실제 동작
- **수정:** `startContainer`에서 storageType이 "ebs"일 때 `volumeConfigurations` 추가

### 2. ECS Infrastructure IAM Role 미생성

- **파일:** CDK 전체 (04-ecs-devenv-stack.ts)
- **이슈:** ECS EBS 볼륨 관리에 필요한 Infrastructure IAM Role이 CDK에서 생성되지 않음. AWS 관리형 정책 `AmazonECSInfrastructureRolePolicyForVolumes`를 attach한 역할 필요
- **영향:** `volumeConfigurations` 추가해도 IAM 권한 없어서 실패
- **수정:** CDK에서 Infrastructure Role 생성 + RunTask에 `roleArn` 전달

---

## HIGH (2건)

### 3. startContainer에서 EBS 스냅샷 복원 미연동

- **파일:** `shared/nextjs-app/src/lib/aws-clients.ts:startContainer`
- **이슈:** EBS 모드 사용자 재시작 시 이전 스냅샷에서 복원하는 흐름이 없음. 필요한 흐름:

```
1. DynamoDB에서 사용자 스냅샷 ID 조회 (cc-user-volumes 테이블)
2. RunTask volumeConfigurations에 snapshotId 전달
3. ECS가 스냅샷에서 새 볼륨 생성 → 태스크에 attach
4. 태스크 종료 시 → warm-stop Lambda가 스냅샷 생성 → 볼륨 삭제
```

- **영향:** EBS 모드 사용자가 재시작하면 빈 볼륨 (이전 데이터 없음)

### 4. ebs-lifecycle.py의 create_and_attach가 ECS 네이티브 방식과 중복

- **파일:** `cdk/lib/lambda/ebs-lifecycle.py`
- **이슈:** 이 Lambda는 직접 `ec2.create_volume()` + DynamoDB 기록을 하지만, ECS 네이티브 EBS 지원을 사용하면 ECS가 볼륨 생성/삭제를 자동 관리함. 이 Lambda의 역할은:
  - ✅ 스냅샷 생성/관리 (warm-stop 시) — 여전히 필요
  - ✅ DynamoDB 메타데이터 관리 — 여전히 필요
  - ❌ 볼륨 생성/삭제 — ECS가 대신 처리
- **수정:** `create_and_attach` → 스냅샷 ID 조회 + 메타데이터 관리 역할로 리팩토링. 볼륨 생성은 ECS `volumeConfigurations`에 위임

---

## MEDIUM (2건)

### 5. S3 sync 범위 — workspace만 대상

- **파일:** `docker/devenv/scripts/s3-sync.sh`
- **이슈:** `WORKSPACE="/home/coder/workspace"` 만 sync. 홈 디렉토리 설정파일 미포함:
  - `/home/coder/.bashrc`, `.claude/`, `.kiro/`, `.config/code-server/`
- **영향:** EFS 모드에서는 EFS에 영속되므로 문제 없음. EBS 모드에서 스냅샷이 EBS 전체를 포함하므로 설정파일도 보존됨. S3 sync는 추가 안전망 역할
- **수정:** (선택) sync 대상에 `$HOME/.bashrc $HOME/.claude $HOME/.kiro` 추가

### 6. warm-stop CloudWatch 차원 오류

- **파일:** `cdk/lib/lambda/warm-stop.py:280`
- **이슈:** `ServiceName: cc-user-{user_id}` 차원 사용. ECS 독립 태스크는 Service가 아니므로 Container Insights에서 `ServiceName` 메트릭 미생성 → 항상 빈 데이터 → fail-safe "idle 아님" → warm-stop 미트리거
- **영향:** idle 감지 실질적 미동작. schedule_shutdown(18:00)만 동작
- **수정:** `TaskDefinitionFamily` 차원 또는 태스크 ID 기반 메트릭 조회

---

## 사용자 격리 분석

### user01이 user02 EBS를 마운트할 수 있는가?

**ECS 네이티브 EBS 사용 시 (구현 필요):**
- ECS가 태스크별로 새 볼륨 생성 → 다른 사용자 볼륨 접근 불가 ✅
- 스냅샷 ID는 DynamoDB에서 `user_id`로 조회 → 자기 스냅샷만 사용 ✅
- Infrastructure Role이 볼륨 관리 → 태스크 역할로는 볼륨 조작 불가 ✅

**현재 구현 (EFS 모드):**
- EFS Access Point로 사용자별 격리 ✅
- Access Point 없으면 `rootDirectory: /users/{subdomain}` fallback ⚠️ (EFS 레벨 강제 아님)

### AZ 이동 (a→c) 시 새 EBS

**ECS 네이티브 EBS:**
- ECS가 태스크 배치된 AZ에 자동으로 볼륨 생성 ✅
- 스냅샷 지정하면 다른 AZ에서도 복원 가능 ✅
- 별도 AZ 관리 로직 불필요 — ECS가 처리

**현재 ebs-lifecycle.py:**
- `restore_from_snapshot(az=새AZ)` 로직 있음 ✅
- 하지만 ECS 네이티브 방식 사용 시 이 로직은 불필요

### EBS 태그에 user 정보

**현재 ebs-lifecycle.py:** ✅
```python
Tags=[
    {"Key": "Name", "Value": f"cc-user-{user_id}"},
    {"Key": "user_id", "Value": user_id},
    {"Key": "managed_by", "Value": "cc-on-bedrock"},
]
```

**ECS 네이티브 EBS:** `tagSpecifications`로 동일하게 태그 가능 ✅

---

## 잘 구현된 부분 ✅

| 항목 | 설명 |
|------|------|
| S3 3단계 sync | restore → sync(5분) → full-backup(stop) |
| SIGTERM graceful shutdown | `trap cleanup SIGTERM` → S3 full-backup |
| DynamoDB 메타데이터 | user_id별 volume_id, snapshot_id, az, status 관리 |
| EBS 태그 | user_id, managed_by, created_at 포함 |
| 스냅샷 태그 | user_id, source_volume, managed_by 포함 |
| EFS Access Point 격리 | startContainer에서 사용자별 AP 생성 |
| 중복 컨테이너 방지 | startContainer에서 기존 RUNNING/PENDING 체크 |

---

## 권장 구현 로드맵

### Phase 1: ECS 네이티브 EBS 연동
1. CDK에 ECS Infrastructure IAM Role 생성 (`AmazonECSInfrastructureRolePolicyForVolumes`)
2. Task Definition에 `configuredAtLaunch: true` 볼륨 추가
3. `startContainer`에서 storageType="ebs" 시 `volumeConfigurations` + `snapshotId` 전달
4. warm-stop에서 태스크 종료 후 ECS 관리 볼륨의 스냅샷 생성

### Phase 2: 기존 Lambda 리팩토링
5. `ebs-lifecycle.py` — 볼륨 생성/삭제 제거, 스냅샷 관리 + 메타데이터 전용으로
6. warm-stop CloudWatch 차원 수정 (`TaskDefinitionFamily`)
7. S3 sync에 홈 디렉토리 설정파일 포함 (선택)
