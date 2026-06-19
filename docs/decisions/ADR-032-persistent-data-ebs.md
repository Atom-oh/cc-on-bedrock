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

1. **식별·재연결은 subdomain 태그 기준** — Graviton/Nitro에서 EBS는 요청한 device name(`/dev/sdf`)과 무관하게 NVMe(`/dev/nvme1n1`)로 보인다. 따라서:
   - 볼륨 식별: `cc:subdomain=<sub>` + `cc:role=data` + `managed_by=cc-on-bedrock` 태그.
   - 마운트: device name이 아니라 **filesystem LABEL `CCDATA`**(또는 UUID)로 fstab에 등록. 부팅 순서·NVMe 이름 변동에 안전.
2. **신규 사용자** — RunInstances `BlockDeviceMappings`에 데이터 볼륨(`/dev/sdf`, gp3, `DeleteOnTermination=false`, encrypted, 태그)을 추가해 **born-attached** 생성. 첫 부팅 시 빈 볼륨이면 `mkfs`(LABEL=CCDATA) 후 `/home/coder`로 마운트.
3. **기존 사용자(데이터 볼륨이 detached 상태로 존재)** — terminate 후 재생성/OS전환 시: root-only로 RunInstances → running 후 기존 데이터 볼륨을 `AttachVolume`(`/dev/sdf`)로 재연결. 이미 `CCDATA` 파일시스템이 있으면 mkfs 건너뛰고 마운트만.
4. **stop/start** — 변화 없음. 데이터 볼륨은 root와 함께 attached 유지된 채 전원만 on/off. (가장 흔한 경로 → 무변경이 안전.)
5. **terminate** — `DeleteOnTermination=false`이므로 인스턴스만 사라지고 데이터 볼륨은 `available`로 남아 다음 launch에서 재연결. **admin이 명시적으로 "사용자 완전 삭제"를 호출할 때만** 데이터 볼륨까지 `DeleteVolume`(ADR-024 Cognito 삭제 정리와 일관).
6. **EBS-resize 리타겟** — 확장 신청은 **데이터 볼륨**(`cc:role=data`)을 `ModifyVolume` + 부팅/온라인 `growpart`/`resize2fs|xfs_growfs`로 키운다. OS root는 건드리지 않는다.
7. **OS 전환(`switchOs`)** — root snapshot 의존 제거. 데이터 볼륨을 detach → 옛 인스턴스 terminate → 타깃 OS AMI로 새 인스턴스 → 데이터 볼륨 reattach. 데이터 무손실·경량.

### 기존 root-only 인스턴스 자동 마이그레이션

기존 인스턴스(데이터 볼륨 없음, `/home/coder`가 root에 있음)는 **다음 start 시 자동 마이그레이션**한다(사용자 개입·데이터 손실 없음):

1. 대시보드 `startInstance`가 해당 subdomain에 data 볼륨이 없음을 감지 → 빈 데이터 볼륨 생성·attach(`/dev/sdf`, `DeleteOnTermination=false`, 태그).
2. 부팅 시 systemd oneshot `cc-data-migrate.service`(AMI에 베이크, every-boot, 멱등):
   - `/home/coder`가 아직 root 위에 있고(LABEL CCDATA 미마운트) 빈 데이터 볼륨이 attached → `mkfs.ext4 -L CCDATA`, 임시 마운트, `rsync -aXH /home/coder/ /mnt/ccdata/`, 원본을 `/home/coder.old-root`로 이동, 데이터 볼륨을 `/home/coder`로 마운트, fstab에 LABEL 등록, `code-server`/`cc-cli-update` 재기동.
   - 이미 마이그레이션됨(LABEL CCDATA가 `/home/coder`에 마운트) → no-op.
3. 마이그레이션 완료 마커(`/home/coder/.cc-data-volume`)로 멱등 보장. `.old-root`는 검증 유예기간(예: 다음 성공 부팅 1회) 후 정리.

마이그레이션은 **멱등**하고 **실패 시 fail-safe**(데이터 볼륨 마운트 실패하면 기존 root `/home/coder`를 그대로 둠 → 사용자는 최소한 옛 데이터로 접속 가능).

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

### 보안
- 데이터 볼륨 `Encrypted=true`(KMS), root와 동일 정책.
- IAM: 대시보드 EC2 역할에 `ec2:CreateVolume`/`AttachVolume`/`DetachVolume`/`ModifyVolume`/`DeleteVolume`(태그 조건 `cc:project=cc-on-bedrock`로 제한, ADR-026 boundary 준수) 필요.
- 0.0.0.0/0·`Principal:"*"`·평문 시크릿 도입 없음.

## Rollout
1. AMI에 마운트+마이그레이션 로직 베이크 → 새 AMI 빌드(`scripts/build-ami.sh`).
2. dev에서 (a) 신규 사용자 born-attached, (b) 기존 atomoh/psungbum 자동 마이그레이션, (c) terminate→재생성 무손실, (d) resize 리타겟 검증.
3. 검증 통과 후 `status: Accepted`.
