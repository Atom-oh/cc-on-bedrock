# 작업계획서: ECS 네이티브 EBS 볼륨 마운트 구현

> 작성: 2026-03-31 | 상태: 계획 중

## 배경

현재 EBS 모드가 선언만 되어있고 실제 EBS가 컨테이너에 마운트되지 않음.
AWS 공식 문서에 따르면 ECS EC2 모드에서 `configuredAtLaunch`를 통해 네이티브 EBS 볼륨 attach 가능.

## 아키텍처

```
RunTask API
  └─ volumeConfigurations: [{ managedEBSVolume: { snapshotId?, sizeInGiB, roleArn } }]
     └─ ECS가 자동으로:
        1. EBS 볼륨 생성 (또는 스냅샷에서 복원)
        2. 호스트 인스턴스에 attach
        3. 파일시스템 포맷 (ext4)
        4. 컨테이너 /home/coder 에 mount
        5. 태스크 종료 시 자동 detach + 삭제 (deleteOnTermination)
```

## 필요 조건

- [x] Nitro 인스턴스 (m7g.4xlarge — ✅ Graviton3 Nitro)
- [ ] ECS-optimized AMI `20231219` 이상
- [ ] ECS Infrastructure IAM Role (`AmazonECSInfrastructureRolePolicyForVolumes`)
- [ ] Task Definition에 `configuredAtLaunch: true` 볼륨
- [ ] RunTask 시 `volumeConfigurations` 전달

## 작업 항목

### Phase 1: CDK 인프라 (Day 1)

- [ ] **1-1. ECS Infrastructure IAM Role 생성** (`02-security-stack.ts`)
  - `AmazonECSInfrastructureRolePolicyForVolumes` managed policy 연결
  - ECS가 사용자 대신 EBS 생성/삭제/태그 수행
  - public property로 export

- [ ] **1-2. Task Definition에 EBS 볼륨 추가** (`04-ecs-devenv-stack.ts`)
  - 6개 TaskDef (ubuntu/al2023 x light/standard/power) 각각에:
    ```typescript
    volumes: [{
      name: 'user-data',
      configuredAtLaunch: true,
    }]
    ```
  - containerDefinitions에 mountPoint 추가:
    ```typescript
    mountPoints: [
      { sourceVolume: 'user-data', containerPath: '/home/coder', readOnly: false },
      // 기존 EFS mount는 /efs 로 변경 (공유 도구/설정용)
    ]
    ```

- [ ] **1-3. CDK deploy + 검증**
  - `cdk synth` → Task Definition에 `configuredAtLaunch` 확인
  - `cdk deploy CcOnBedrock-Security CcOnBedrock-EcsDevenv`

### Phase 2: Dashboard 코드 (Day 1-2)

- [ ] **2-1. `startContainer()` 수정** (`aws-clients.ts`)
  - EBS 모드일 때 `volumeConfigurations` 추가:
    ```typescript
    volumeConfigurations: storageType === 'ebs' ? [{
      name: 'user-data',
      managedEBSVolume: {
        roleArn: ecsInfrastructureRoleArn,
        volumeType: 'gp3',
        sizeInGiB: userEbsSizeGb, // DynamoDB에서 조회
        encrypted: true,
        kmsKeyId: kmsKeyArn,
        filesystemType: 'ext4',
        // 스냅샷이 있으면 복원
        ...(snapshotId ? { snapshotId } : {}),
        tagSpecifications: [{
          resourceType: 'volume',
          tags: [
            { key: 'user_id', value: subdomain },
            { key: 'managed_by', value: 'cc-on-bedrock' },
          ],
          propagateTags: 'NONE',
        }],
        terminationPolicy: {
          deleteOnTermination: false, // warm-stop을 위해 유지
        },
      },
    }] : undefined,
    ```

- [ ] **2-2. EBS 스냅샷 복원 로직**
  - DynamoDB `cc-user-volumes`에서 마지막 `snapshotId` 조회
  - 있으면 `volumeConfigurations.snapshotId`에 전달
  - 없으면 새 빈 볼륨 생성

- [ ] **2-3. warm-stop 시 스냅샷 생성**
  - 태스크 종료 전 EBS 볼륨의 스냅샷 생성
  - `ebs-lifecycle.py` 수정: `terminationPolicy.deleteOnTermination: false`이므로 볼륨 유지
  - 스냅샷 생성 후 볼륨 삭제 (비용 절감)

- [ ] **2-4. `startContainerWithProgress()` 수정**
  - Step 2 "Preparing storage"에서 EBS 볼륨 설정 정보 표시
  - 스냅샷 복원 여부 표시

### Phase 3: entrypoint.sh 수정 (Day 2)

- [ ] **3-1. EBS/EFS 분기 처리**
  - EBS 모드: `/home/coder`가 이미 EBS에 마운트됨 → EFS 마운트 건너뛰기
  - EFS 모드: 기존대로 EFS Access Point 사용
  - `STORAGE_TYPE` 환경변수로 분기

- [ ] **3-2. S3 sync 조정**
  - EBS 모드: S3 sync는 백업용만 (EBS가 주 스토리지)
  - EFS 모드: 기존대로 S3 sync가 주 백업

### Phase 4: ebs-lifecycle.py 리팩토링 (Day 2-3)

- [ ] **4-1. `create_and_attach` → `create_snapshot` 중심으로 변경**
  - ECS가 볼륨 생성/attach/detach를 관리하므로 Lambda는 스냅샷만 담당
  - `warm_stop`: 볼륨 ID 조회 → 스냅샷 생성 → DynamoDB 기록
  - `warm_resume`: 스냅샷 ID를 반환 (RunTask에서 사용)

- [ ] **4-2. warm-stop CloudWatch 차원 수정**
  - `ServiceName` → `TaskDefinitionFamily` 기반
  - idle 감지 정상화

### Phase 5: 검증 (Day 3)

- [ ] **5-1. EBS 모드 컨테이너 시작**
  - 새 사용자 → EBS 볼륨 자동 생성 + 마운트 확인
  - 컨테이너 내부 `df -h /home/coder` → EBS 표시

- [ ] **5-2. 데이터 영속성**
  - 파일 생성 → 컨테이너 중지 → 재시작 → 파일 존재 확인

- [ ] **5-3. EFS 모드 비영향 확인**
  - EFS 사용자 → 기존대로 동작 확인

- [ ] **5-4. 리사이즈**
  - 스냅샷 → 더 큰 볼륨으로 복원 확인

## 참고 문서

- [ECS EBS volumes](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/ebs-volumes.html)
- [configuredAtLaunch](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/specify-ebs-config.html)
- [RunTask volumeConfigurations](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/configure-ebs-volume.html)
- [Infrastructure IAM Role](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/infrastructure_IAM_role.html)

## 리스크

| 리스크 | 대응 |
|--------|------|
| AMI 버전 미달 | `aws ssm get-parameters-by-path` 로 현재 AMI 확인 |
| deleteOnTermination=false 시 볼륨 누적 비용 | warm-stop에서 스냅샷 후 삭제 |
| 태스크당 EBS 1개 제한 | EFS는 별도 마운트 (/efs)로 유지 |
| AZ 불일치 | ECS placement가 볼륨과 같은 AZ에 배치 (ECS 자동 처리) |
