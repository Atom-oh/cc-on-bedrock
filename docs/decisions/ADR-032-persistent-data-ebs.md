---
status: Proposed
date: 2026-06-19
verification_required: true
---

# ADR-032: per-user 영속 데이터 EBS 분리 (ephemeral OS root ↔ persistent /home/coder)

## Status: Proposed

## Date: 2026-06-19

## Extends
- [ADR-004: EC2-per-user DevEnv](ADR-004-ec2-per-user-devenv.md) — root EBS = 영속 저장소 모델을 보완(데이터만 별도 볼륨으로 분리). ADR-004는 유효.
- [ADR-018: Dual-OS AMI Strategy](ADR-018-dual-os-ami-strategy.md) — OS 전환(`switchOs`)이 데이터 무손실이 되도록 영향.
- [ADR-027: DevEnv Custom Port Exposure] — 무관(데이터 경로 변경 없음).

## Context

ADR-004는 per-user EC2의 **root EBS가 곧 영속 저장소**라고 정의했다. stop/start는 root를 보존하므로 일상 사용에는 문제가 없으나, root에 **OS(AMI에서 옴) + 사용자 데이터(`/home/coder`)가 한 볼륨에 섞여 있다**는 구조적 결함이 있다:

1. **AMI 교체 불가** — initrdless GRUB 부팅 버그(2026-06-16, `devenv-ami-boot-ebs`)를 새 AMI로 고쳤지만, **기존 인스턴스는 stop/start 시 옛 root를 그대로 재사용**해 새 AMI를 못 받는다. in-place SSM GRUB 픽스로 우회했으나(atomoh/psungbum), 근본적으로 "AMI를 갈면 데이터가 날아가는" 구조다.
2. **terminate = 데이터 영구 소실** — `terminateInstance`가 root를 지운다. 응급 시 terminate+재생성이 불가능(데이터 손실). dev에서 부팅 실패 인스턴스를 못 버리고 in-place 복구에 매달린 직접 원인.
3. **`switchOs`의 취약함** — OS 전환이 root snapshot→복원에 의존. snapshot이 OS+데이터를 함께 떠서 무겁고, 복원 실패 시 데이터 위험.
4. **EBS-resize가 OS까지 키움** — 사용자가 데이터 공간이 필요해 신청한 확장이 OS 파티션을 포함한 root 전체를 키운다(`ADR` 없는 기존 동작, `admin/ebs-resize` → `ModifyVolume(item.volumeId=root)`).

근본 원인은 **"교체 가능한 OS"와 "교체 불가능한 사용자 데이터"가 한 볼륨에 묶여 lifecycle이 결합된 것**이다.

## Decision

per-user EC2를 **2-볼륨 모델**로 전환한다:

- **Root EBS (ephemeral OS)** — AMI에서 옴. OS·시스템 패키지·code-server 바이너리. `DeleteOnTermination=true`. 언제든 새 AMI로 교체·재생성 가능. 사용자 데이터를 담지 않는다.
- **Data EBS (persistent)** — **`/home/coder` 전체**(workspace + `.claude` + `.config` + `.local` + dotfiles + apt-installed user state under home). `DeleteOnTermination=false`. **subdomain 태그로 식별**되어 재생성/AMI교체/OS전환을 가로질러 재연결된다.

### 핵심 규칙

1. **식별의 권위는 DynamoDB, 마운트는 volume-id 기준** — Graviton/Nitro에서 EBS는 요청한 device name(`/dev/sdf`)과 무관하게 NVMe(`/dev/nvme1n1`)로 보이고, NVMe 이름은 attach 순서에 따라 바뀐다. 따라서:
   - **권위 식별자 = DynamoDB `cc-user-instances`의 `dataVolumeId` + `dataVolumeAz`** (subdomain 태그 조회는 보조/복구용; 태그 매칭이 2개 이상이면 **fail-closed**, 잘못된 사용자 데이터 노출 방지).
   - **장치 판별 = EBS volume-id** (NVMe serial `vol...`; `/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_vol<id>` 또는 `ebsnvme-id`로 해석). **device name(`/dev/sdf`)·`/dev/nvme1n1` 하드코딩 금지** — 엉뚱한 디스크 `mkfs` 위험.
   - 마운트는 fstab `LABEL=CCDATA` + **`nofail,x-systemd.device-timeout=10s`** (볼륨 지연/실패가 부팅을 emergency mode로 brick하지 않게). 실제 마운트·마이그레이션은 fstab 하드 의존이 아니라 아래 systemd 유닛이 수행.
   - **데이터 볼륨 태깅은 launch 후 `CreateTags`로** — RunInstances의 volume `TagSpecification`은 **모든** 생성 볼륨(= root 포함)에 적용되므로 root/data를 구분 못 한다. launch 후 데이터 볼륨 id를 해석해 `cc:role=data`를, root에는 `cc:role=root`를 부여.
2. **AZ 핀 (필수)** — EBS 볼륨은 AZ 종속. 재연결·OS전환 시 인스턴스가 다른 AZ에 뜨면 `InvalidVolume.ZoneMismatch`로 환경이 brick된다. 규칙: `dataVolumeAz`를 영속화하고, **재연결 launch는 그 AZ의 SubnetId로 핀**한다. 신규 볼륨은 인스턴스가 뜬 AZ에 생성한다. AZ 불일치는 **fail-closed**(임의로 새 볼륨 만들지 않음).
3. **신규 사용자 (born-attached)** — RunInstances `BlockDeviceMappings`에 데이터 볼륨(`/dev/sdf`, gp3, `DeleteOnTermination=false`, encrypted)을 추가해 함께 생성. launch 후 데이터 볼륨 id 해석 → `CreateTags`(rule 1) → DynamoDB `dataVolumeId`/`dataVolumeAz` 기록. 첫 부팅 시 빈 볼륨이면 `mkfs`(LABEL=CCDATA, **raw-device, 파티션 없음**) 후 `/home/coder`로 마운트.
4. **기존 사용자 재연결 (attach race 방지)** — terminate 후 재생성/OS전환 시: 데이터 볼륨 AZ에 핀해 root-only RunInstances → **부팅 마이그레이션 유닛이 예상 `dataVolumeId`(UserData로 전달)가 attach되어 NVMe에 나타날 때까지 bounded-wait** 후 마운트. 대시보드는 `AttachVolume`을 호출하고, 유닛은 폴링으로 attach 완료를 기다리므로 "부팅이 attach보다 빠른" 레이스가 닫힌다. 이미 `CCDATA` FS가 있으면 mkfs 건너뛰고 마운트만.
5. **stop/start** — 변화 없음. 데이터 볼륨은 root와 함께 attached 유지된 채 전원만 on/off. (가장 흔한 경로 → 무변경.)
6. **terminate** — `DeleteOnTermination=false`이므로 인스턴스만 사라지고 데이터 볼륨은 `available`로 남아 다음 launch에서 재연결. **admin "사용자 완전 삭제"에서만** `DeleteVolume`(rule 9).
7. **EBS-resize 리타겟** — 확장 신청은 **데이터 볼륨**(DynamoDB `dataVolumeId`)을 `ModifyVolume` + 온라인 `resize2fs`(raw-device ext4)로 키운다. **`growpart` 미사용**(파티션이 없으므로 실패). OS root는 건드리지 않는다.
8. **OS 전환(`switchOs`)** — root snapshot 의존 제거. **옛 인스턴스에서 `code-server` 정지 → `sync` → `/home/coder` unmount → 데이터 볼륨 detach → 볼륨이 `available`이 될 때까지 대기 → 옛 인스턴스 terminate → 데이터 볼륨 AZ에 핀해 타깃 OS AMI로 새 인스턴스 → reattach**. 마운트된 FS를 detach해 손상시키지 않는다.
9. **동시성 락 + orphan 정리** — start/switchOs는 subdomain별 DynamoDB **조건부 상태 전이**(op-token)로 직렬화해 중복 볼륨 생성·split-brain을 막는다. admin 완전 삭제(ADR-024)는: detach → `available` 대기 → (선택)최종 snapshot → `DeleteVolume` → DynamoDB `dataVolumeId` clear → 감사 로그.

### 기존 root-only 인스턴스 마이그레이션 (out-of-band SSM)

기존 인스턴스는 **옛 root AMI로 부팅**하므로 베이크된 마이그레이션 유닛이 없고, UserData는 첫 부팅에만 실행되어 `startInstance`로는 트리거되지 않는다. 따라서 **실행 중인 기존 인스턴스에 SSM RunCommand로 아웃오브밴드 마이그레이션**한다(GRUB in-place 픽스와 동일한 검증된 패턴, 데이터 무손실):

1. 대시보드가 해당 subdomain에 데이터 볼륨 없음을 감지 → 인스턴스 **AZ에 맞춰** 빈 데이터 볼륨 생성·attach(`DeleteOnTermination=false`) → DynamoDB 기록.
2. SSM RunCommand로 마이그레이션 스크립트 실행(부팅 유닛과 **동일한 단일 로직**):
   - volume-id로 NVMe 장치 해석(rule 1) → `mkfs.ext4 -L CCDATA`(raw) → **임시 경로 마운트 후 `rsync -aXH` + 검증** → 검증 성공 시에만 원본을 `/home/coder.old-root`로 rename → 데이터 볼륨을 `/home/coder`로 마운트 → fstab `LABEL=CCDATA,nofail` 등록 → 완료 마커 `/home/coder/.cc-data-volume`.
   - 임시 마운트·rsync·검증이 실패하면 **원본을 건드리지 않고 fail-safe 종료**(사용자는 옛 `/home/coder`로 계속 접속).
3. 부팅 유닛 `cc-data-migrate.service`(새 AMI에 베이크, oneshot, `DefaultDependencies=no`, **`Before=code-server.service`** → rsync 중 사용자 프로세스가 `/home/coder`를 변경하지 못함, 유닛 내 `systemctl restart` **금지**(부팅 의존 사이클 방지))는 **신규/재생성 인스턴스의 첫 부팅 또는 재연결**에서 동일 로직을 멱등 수행. 마커 존재 시 no-op.

마이그레이션은 **멱등**하고 **fail-safe**(검증 통과 전에는 원본 `/home/coder`를 절대 옮기지 않음).

## Consequences

### 긍정
- AMI 교체·terminate·OS전환이 **데이터 무손실**. initrdless류 부팅 버그를 "terminate+재생성"으로 깔끔히 복구 가능(응급복구가 in-place SSM 곡예에서 표준 절차로).
- EBS-resize가 의미대로 동작(데이터만 확장, OS 안 건드림).
- snapshot 의존 `switchOs` 경량화.
- ADR-004 모델과 공존 — stop/start 경로 무변경, 점진 적용.

### 부정 / 비용
- 인스턴스당 EBS 볼륨 2개 → 관리 대상·태깅·정리(ADR-024) 복잡도 증가. **orphan 데이터 볼륨**(사용자 삭제 후 미정리) 회수 절차 필요.
- 마운트가 device name이 아닌 LABEL 의존 → AMI/userdata에 견고한 마운트 로직 필요(검증 필수, `verification_required:true`).
- 마이그레이션은 일회성 위험 구간(rsync 중 부팅 지연·실패 가능) → 멱등+fail-safe로 방어하되 dev에서 충분히 검증 후 prod.
- 비용: 데이터 볼륨이 terminate 후에도 남음(available gp3 과금) → 미사용 회수 정책 필요.

### 보안 (IAM least-privilege, 패널 반영)
- 데이터 볼륨 `Encrypted=true`(KMS), root와 동일 정책.
- IAM은 **action별로 분리**해 vague 단일 태그 조건을 피한다(ADR-026 boundary 준수):
  - `ec2:CreateVolume` — `aws:RequestTag/cc:project=cc-on-bedrock` 조건(생성 시 태그 강제).
  - `ec2:CreateTags` — `ec2:CreateAction` in (`CreateVolume`,`RunInstances`)로 제한(임의 리태깅 방지).
  - `ec2:AttachVolume`/`DetachVolume`/`ModifyVolume`/`DeleteVolume` — **볼륨과 인스턴스 양쪽** 리소스에 `ec2:ResourceTag/cc:project=cc-on-bedrock` 조건.
- 앱 레이어에서 subdomain/owner 태그 일치를 추가 검증(태그 조회 fail-closed, rule 1).
- 0.0.0.0/0·`Principal:"*"`·평문 시크릿 도입 없음.

## Rollout
1. AMI에 마운트+마이그레이션 로직 베이크 → 새 AMI 빌드(`scripts/build-ami.sh`).
2. dev에서 (a) 신규 사용자 born-attached, (b) 기존 atomoh/psungbum 자동 마이그레이션, (c) terminate→재생성 무손실, (d) resize 리타겟 검증.
3. 검증 통과 후 `status: Accepted`.
