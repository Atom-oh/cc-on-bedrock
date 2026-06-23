# CC-on-Bedrock FAQ

## EBS / Storage

> DevEnv은 per-user EC2이며(ADR-004), 스토리지는 **2-볼륨 EBS 모델**입니다(ADR-032). ECS Task·EFS·snapshot/restore 방식은 더 이상 사용하지 않습니다.

### Q: per-user EC2의 스토리지 구조는 어떻게 되나요?
인스턴스당 **EBS 볼륨 2개**로 분리됩니다(ADR-032):
- **Root EBS (ephemeral OS)** — AMI에서 옴(OS·시스템 패키지·code-server 바이너리). `DeleteOnTermination=true`. 언제든 새 AMI로 교체·재생성 가능하며 사용자 데이터를 담지 않습니다.
- **Data EBS (persistent)** — `/home/coder` 전체(workspace + `.claude` + `.config` + dotfiles 등). `DeleteOnTermination=false`. **subdomain 태그로 식별**되어 재생성·AMI 교체·OS 전환을 가로질러 재연결됩니다.

### Q: 인스턴스를 terminate하면 사용자 데이터는 어떻게 되나요?
데이터 EBS는 `DeleteOnTermination=false`이므로 **인스턴스만 사라지고 데이터 볼륨은 `available`로 남아** 다음 launch에서 재연결됩니다. 즉 terminate가 사용자 데이터를 파괴하지 않습니다(BASELINE §1 불변식). 볼륨 실제 삭제는 admin "사용자 완전 삭제" 경로에서만 일어납니다. Root EBS는 ephemeral이므로 terminate 시 함께 삭제됩니다.

### Q: 기존 EBS 볼륨을 재연결할 수 있나요?
**가능하며, 그것이 기본 동작입니다.** 권위 식별자는 DynamoDB `cc-user-instances`의 `dataVolumeId` + `dataVolumeAz`이고, 재생성/OS 전환 시 그 AZ에 핀해 새 인스턴스를 띄운 뒤 데이터 볼륨을 `AttachVolume`으로 다시 붙입니다. subdomain 태그 조회는 보조/복구용이며, 태그가 2개 이상 매칭되면 fail-closed로 잘못된 데이터 노출을 막습니다.

### Q: AZ 장애·AZ 핀은 어떻게 처리되나요?
EBS 볼륨은 AZ 종속이므로, `dataVolumeAz`를 영속화하고 **재연결 launch를 그 AZ의 SubnetId로 핀**합니다. AZ 불일치(`InvalidVolume.ZoneMismatch`)는 fail-closed로 처리하며 임의로 새 볼륨을 만들지 않습니다. 신규 볼륨은 인스턴스가 뜬 AZ에 생성합니다. (snapshot/restore 기반 DR은 더 이상 사용하지 않습니다.)

### Q: EBS 용량을 늘리면 어떻게 되나요?
확장 신청은 **데이터 볼륨**(`dataVolumeId`)만 `ModifyVolume` + 온라인 `resize2fs`로 키웁니다. OS root는 건드리지 않습니다(ADR-032 rule 7).

### Q: OS를 전환(`switchOs`)하면 데이터가 보존되나요?
네. 옛 인스턴스에서 code-server 정지 → `/home/coder` unmount → 데이터 볼륨 detach → 옛 인스턴스 terminate → 데이터 볼륨 AZ에 핀해 타깃 OS AMI로 새 인스턴스 → reattach 순서로 진행하므로 데이터 무손실입니다. (옛 root-snapshot 의존 제거.)

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
1. 실행 중인 EC2 인스턴스 중지/terminate
2. Nginx 라우팅 테이블에서 제거
3. Cognito `custom:subdomain` 초기화

Cognito 계정은 유지됩니다. 데이터 EBS는 `DeleteOnTermination=false`이므로 인스턴스가 사라져도 `available`로 남고, 동일 subdomain으로 재할당하면 동일 데이터 볼륨이 그대로 재연결됩니다. 볼륨의 실제 삭제(`DeleteVolume`)는 admin "사용자 완전 삭제" 경로에서만 일어납니다(ADR-032 rule 9).

---

## 컨테이너 프로비저닝

### Q: DevEnv 프로비저닝은 어떻게 진행되나요?
DevEnv은 per-user EC2 인스턴스로 프로비저닝됩니다(ADR-004). 진행상황은 Server-Sent Events로 실시간 스트리밍되며, 백엔드는 ECS RunTask가 아니라 EC2 `RunInstances` + 데이터 EBS 연결 기반입니다. 대략적인 흐름:
1. **IAM Instance Profile**: Per-user role 부여 (Permission Boundary 적용 — ADR-007)
2. **Data EBS**: 신규 사용자는 born-attached(`RunInstances BlockDeviceMappings`에 데이터 볼륨 포함), 기존 사용자는 `dataVolumeId`/`dataVolumeAz` AZ에 핀해 `AttachVolume`으로 재연결 (ADR-032)
3. **Instance Launch**: `RunInstances` (데이터 볼륨 AZ에 핀, hibernation 지원 — ADR-010)
4. **Password Store**: Secrets Manager에 code-server 비밀번호
5. **Route Register**: 인스턴스 private IP를 `cc-routing-table`에 등록(Nginx 동적 라우팅)
6. **Health Check**: code-server HEALTHY 상태 확인

> 가장 흔한 경로인 stop/start는 별도 프로비저닝 없이 동일 인스턴스·동일 데이터 볼륨의 전원만 on/off 합니다.

### Q: 프로비저닝 중 취소할 수 있나요?
네. UI의 Cancel 버튼이 `AbortController`를 통해 SSE 스트림을 중단합니다. 이미 시작된 EC2 인스턴스는 별도로 Stop/Terminate해야 합니다.

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

### Q: 스토리지로 EFS를 선택할 수 있나요?
아니요. 스토리지는 per-user gp3 **EBS 2-볼륨 모델**로 고정입니다(ADR-032). EFS·`storageType` 선택 옵션은 더 이상 존재하지 않습니다. IaC는 **Terraform 단일 정본**이며(ADR-001, CDK·CloudFormation 폐기), 별도의 `storageType` config는 없습니다. 데이터 격리는 사용자별 물리적 데이터 볼륨(subdomain 태그·AZ 핀, fail-closed 식별)으로 보장됩니다.
