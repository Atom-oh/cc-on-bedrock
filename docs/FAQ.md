# CC-on-Bedrock FAQ

## EBS / Storage

### Q: ECS에서 기존 EBS 볼륨을 재연결할 수 있나요?
**불가능합니다.** ECS managed EBS volume (`configuredAtLaunch: true`)은 매 `RunTask`마다 새 볼륨을 생성합니다. AWS API의 `managedEBSVolume`에 `volumeId` 파라미터가 없어 기존 볼륨을 지정할 수 없습니다. 데이터 복원은 `snapshotId`를 통해서만 가능합니다.

기존 볼륨을 재사용하려면 ECS 외부에서 Lambda로 EC2 호스트에 직접 attach한 후 host volume mount해야 합니다. → [ADR-003](decisions/ADR-003-ebs-host-attach.md)

### Q: 컨테이너 종료 시 EBS 볼륨은 어떻게 되나요?
- **Phase 1 (현재)**: `deleteOnTermination: true`로 ECS가 볼륨 자동 삭제. Lambda가 비동기로 snapshot 생성. 다음 시작 시 snapshot에서 복원.
- **Phase 2 (예정)**: ECS managed volume 제거. 볼륨은 EC2에서 detach만 되고 삭제되지 않음. 다음 시작 시 동일 볼륨을 다시 attach.

### Q: AZ 장애 시 데이터 복구는?
DynamoDB `cc-user-volumes` 테이블에 `snapshot_id`가 저장되어 있습니다. AZ 장애 시:
1. 다른 AZ의 Capacity Provider를 선택
2. Snapshot에서 새 볼륨 생성 (해당 AZ에)
3. 데이터 복원 완료

이는 Phase 1, Phase 2 모두 동일한 DR 전략입니다.

### Q: Orphan EBS 볼륨이 발생하는 이유는?
`deleteOnTermination: false` + ECS managed 볼륨 삭제 skip 조합이 원인이었습니다. ECS는 Task 종료 시 볼륨을 detach하지만 삭제하지 않고, Lambda도 ECS-managed 태그를 보고 삭제를 건너뛰었습니다. 매 stop/start 사이클마다 이전 볼륨이 orphan으로 남았습니다.

Phase 1에서 `deleteOnTermination: true`로 변경하여 해결했습니다.

### Q: Snapshot 복원이 느린데 개선 방법은?
EBS snapshot에서 볼륨을 생성하면 데이터가 lazy-load됩니다. 큰 볼륨일수록 처음 접근하는 블록이 느립니다. Phase 2의 Host Attach 방식으로 전환하면 기존 볼륨을 직접 재연결하므로 snapshot 복원이 불필요하고, 시작 시간이 수초로 단축됩니다.

---

## User 승인 / 라이프사이클

### Q: 사용자 승인 플로우는?
```
신청(pending) → 승인(approved) → 리소스 할당(assigned) → 컨테이너 사용
```
1. 사용자가 `POST /api/user/container-request`로 리소스 크기, 스토리지 타입 선택 후 신청
2. Admin이 `POST /api/admin/approval-requests` {action: "approve"}로 승인
3. Admin이 {action: "assign"}으로 subdomain 할당 → Cognito `custom:subdomain` 설정
4. 사용자가 다음 로그인/새로고침 시 컨테이너 시작 가능

### Q: subdomain은 어떻게 결정되나요?
Email 기반 자동 파생입니다. `emailToSubdomain("atom.oh@example.com")` → `"atom-oh"`. 수동 지정은 admin assign 시 `subdomain` 파라미터로 오버라이드 가능합니다.

### Q: approve와 assign이 분리된 이유는?
엔터프라이즈 환경에서 승인 권한자(부서장)와 리소스 할당자(인프라 관리자)가 다를 수 있기 때문입니다. 부서장이 승인하고, 인프라팀이 subdomain/리소스를 배정하는 워크플로우를 지원합니다.

### Q: 사용자 삭제(soft-delete)는 어떻게 작동하나요?
`resetUserEnvironment()` 함수가:
1. 실행 중인 컨테이너 중지
2. Nginx 라우팅 테이블에서 제거
3. EBS snapshot 생성 (DR 백업)
4. Cognito `custom:subdomain` 초기화

Cognito 계정은 유지됩니다. 동일 subdomain으로 재할당하면 EBS snapshot에서 데이터 복원이 가능합니다.

---

## 컨테이너 프로비저닝

### Q: 7단계 SSE 프로비저닝이란?
컨테이너 시작 시 실시간 진행상황을 Server-Sent Events로 스트리밍합니다:
1. **IAM Role**: Per-user task role 생성 (Permission Boundary 적용)
2. **EFS Access Point**: 사용자별 파일 격리
3. **Task Definition**: Per-user 볼륨 설정으로 새 revision 등록
4. **Password Store**: Secrets Manager에 code-server 비밀번호
5. **Container Start**: ECS RunTask (AZ-aware capacity provider)
6. **Route Register**: Nginx 동적 라우팅 테이블 등록
7. **Health Check**: code-server HEALTHY 상태 확인

### Q: 프로비저닝 중 취소할 수 있나요?
네. UI의 Cancel 버튼이 `AbortController`를 통해 SSE 스트림을 중단합니다. 이미 시작된 ECS Task는 별도로 Stop해야 합니다.

---

## 아키텍처

### Q: Nginx 동적 라우팅은 어떻게 작동하나요?
DynamoDB `cc-routing-table`에 `{subdomain: privateIp}` 매핑을 저장합니다. DynamoDB Streams → Lambda가 Nginx 설정을 재생성하여 S3에 업로드. Nginx Fargate Service가 주기적으로 설정을 pull합니다. → [ADR-002](decisions/ADR-002-nlb-nginx-routing.md)

### Q: Per-user IAM Role은 왜 필요한가요?
각 사용자 컨테이너에 개별 IAM Role을 부여하여:
- Bedrock 호출을 사용자별로 추적 (CloudTrail)
- S3 접근을 사용자 prefix로 제한
- 예산 초과 시 개별 사용자의 Bedrock 접근만 차단 (IAM Deny Policy)

`cc-on-bedrock-task-boundary` Permission Boundary가 최대 권한을 제한합니다.

### Q: EFS와 EBS 중 어떤 것을 선택해야 하나요?
| 항목 | EBS | EFS |
|------|-----|-----|
| 성능 | gp3 3000 IOPS (빠름) | 범용 모드 (보통) |
| 비용 | 사용자당 고정 볼륨 비용 | 사용량 비례 |
| 관리 복잡도 | 높음 (볼륨 라이프사이클) | 낮음 (자동 확장) |
| 데이터 격리 | 물리적 격리 | Access Point 논리적 격리 |
| 추천 | 고성능/대용량 작업 | 소규모/공유 환경 |

CDK config에서 `storageType: 'ebs'` 또는 `'efs'`로 선택합니다.
