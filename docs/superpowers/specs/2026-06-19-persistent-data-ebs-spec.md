# Spec: per-user 영속 데이터 EBS 분리 (ADR-032)

**ADR:** [ADR-032](../../decisions/ADR-032-persistent-data-ebs.md)
**Date:** 2026-06-19
**Branch base:** feat/usage-email-key

## Goal
ephemeral OS root ↔ persistent `/home/coder` 데이터 EBS 분리. 신규 = born-attached, 기존 = 자동 마이그레이션, terminate/AMI교체/OS전환 무손실, resize는 데이터 볼륨 리타겟.

## Invariants (security / portability)
- 데이터 볼륨 `Encrypted=true`, `DeleteOnTermination=false`, 태그 `cc:subdomain` / `cc:role=data` / `managed_by=cc-on-bedrock` / `cc:project=cc-on-bedrock`.
- 마운트는 device name 금지 → filesystem LABEL `CCDATA`(fstab `LABEL=CCDATA /home/coder ...`).
- IAM 추가 권한은 `cc:project=cc-on-bedrock` 태그 조건으로 제한(ADR-026 boundary 준수). 0.0.0.0/0·`Principal:"*"`·평문 시크릿 금지.
- 마이그레이션은 멱등 + fail-safe(데이터 볼륨 처리 실패 시 기존 root `/home/coder` 보존).
- stop/start 경로는 동작 변경 없음.

## Phasing
- **Phase A (코드/마운트 로직, 무배포 검증):** Task 1–5. 순수 함수·userdata 문자열·AMI 스크립트 + 단위테스트. `bash tests/run-all.sh` 그린.
- **Phase B (배포 검증, dev):** 새 AMI 빌드 → 신규 born-attached / 기존 자동 마이그레이션 / terminate→재생성 무손실 / resize 리타겟 라이브 검증. ADR `status: Accepted`.

이 spec의 consensus 게이트(P2)와 구현(P3)은 **Phase A**만 대상. Phase B는 사용자 입회 라이브 배포로 별도 수행.

---

### Task 1: 데이터 볼륨 헬퍼 (순수 로직 + 조회/생성/연결)
**Files:**
- Create: `shared/nextjs-app/src/lib/data-volume.ts` — `dataVolumeTags(subdomain, username, department)`, `dataVolumeBlockDeviceMapping()` (born-attached BDM: `/dev/sdf`, gp3, `DeleteOnTermination:false`, `Encrypted:true`, 기본 사이즈), `findDataVolume(subdomain)` (DescribeVolumes by 태그, 상태 반환), `attachDataVolume(instanceId, volumeId)`.
- Test: `shared/nextjs-app/src/lib/__tests__/data-volume.test.ts` — 태그 구성, BDM 구조(`DeleteOnTermination===false`, `Encrypted===true`, device `/dev/sdf`), `findDataVolume` 필터 셀렉터(mock DescribeVolumes)를 단위 검증.

### Task 2: 부팅 마운트 + 마이그레이션 userdata 헬퍼
**Files:**
- Create: `shared/nextjs-app/src/lib/data-volume-userdata.ts` — `dataVolumeMountUserData()` 가 멱등 마운트/마이그레이션 셸 라인 배열 반환:
  - 데이터 볼륨(LABEL CCDATA) 이미 마운트 → no-op.
  - attached 빈 볼륨 + `/home/coder`가 root 위 → `mkfs.ext4 -L CCDATA`, 임시 마운트, `rsync -aXH`, 원본 `/home/coder.old-root` 이동, `/home/coder` 마운트, fstab `LABEL=CCDATA` 등록, 마커 `/home/coder/.cc-data-volume`, `systemctl restart code-server cc-cli-update 2>/dev/null||true`.
  - LABEL 존재(재연결) → mkfs/rsync 건너뛰고 마운트만.
  - 실패 시 fail-safe(기존 `/home/coder` 보존, 비-치명 exit).
- Test: `shared/nextjs-app/src/lib/__tests__/data-volume-userdata.test.ts` — 반환 스크립트가 (a) device name이 아닌 `LABEL=CCDATA`로 fstab 등록, (b) 멱등 마커 가드 포함, (c) `mkfs` 전 LABEL 존재 검사(재연결 시 mkfs 안 함), (d) `set -e`로 부팅을 죽이지 않음(`|| true`/명시 가드)을 문자열 단위로 검증.

### Task 3: startInstance 통합 (born-attached + 재연결 + 마이그레이션 트리거)
**Files:**
- Modify: `shared/nextjs-app/src/lib/ec2-clients.ts`
  - 신규 생성 경로(RunInstances): `BlockDeviceMappings`에 `dataVolumeBlockDeviceMapping()` 추가; `volume` TagSpecification에 `cc:role=data` 분기. UserData에 `dataVolumeMountUserData()` 합성.
  - 기존(detached 데이터 볼륨 존재) 경로: root-only RunInstances 후 running 대기 → `attachDataVolume`. 이미 BDM born-attached면 스킵.
  - 레거시(데이터 볼륨 없음) start 경로: `findDataVolume`=none → 빈 데이터 볼륨 생성·attach해 다음 부팅 마이그레이션 트리거(자동 마이그레이션).
  - DynamoDB user-instances 레코드에 `dataVolumeId` 저장(resize 리타겟용).
- Test: `shared/nextjs-app/src/lib/__tests__/ec2-clients-datavol.test.ts` — RunInstances 입력에 데이터 BDM(`DeleteOnTermination:false`)이 들어가는지, 레거시 start에서 데이터 볼륨 생성이 트리거되는지(mock EC2 클라이언트로 호출 캡처) 검증.

### Task 4: lifecycle 무손실 (terminate 보존 / resize 리타겟 / switchOs)
**Files:**
- Modify: `shared/nextjs-app/src/lib/ec2-clients.ts` — `terminateInstance`: 데이터 볼륨은 `DeleteOnTermination=false`로 보존(코멘트/주석 명확화); `switchOs`: root snapshot 의존 대신 데이터 볼륨 detach→재생성→reattach 흐름으로 변경.
- Modify: `shared/nextjs-app/src/app/api/admin/ebs-resize/route.ts` — `ModifyVolume` 대상을 root `item.volumeId`가 아니라 **데이터 볼륨**(`dataVolumeId`, 없으면 `findDataVolume`로 해석)으로 변경.
- Modify: `shared/nextjs-app/src/app/api/user/ebs-resize/route.ts` — 신청/표시 사이즈가 데이터 볼륨 기준이 되도록 `volumeId` 소스를 데이터 볼륨으로.
- Test: `shared/nextjs-app/src/lib/__tests__/ebs-resize-target.test.ts` — resize가 데이터 볼륨 id로 `ModifyVolume`을 호출(순수 셀렉터/리타겟 함수 추출 후 단위 검증).

### Task 5: AMI 베이크 (마운트/마이그레이션 systemd oneshot)
**Files:**
- Modify: `scripts/build-ami.sh` — `cc-data-migrate.service`(oneshot, every-boot, before code-server) 베이크. 본문은 Task 2 헬퍼와 동일 멱등/fail-safe 로직(부팅 시 LABEL CCDATA 마운트 또는 root→데이터 마이그레이션). `growpart`/`resize2fs` 온라인 확장 훅도 데이터 볼륨 대상으로 포함.
- Test: `tests/unit/test-build-ami-datavol.sh` — `build-ami.sh`가 `LABEL=CCDATA`, 멱등 마커, fail-safe 가드, `cc-data-migrate.service` enable 라인을 포함하는지 `bash -n` + grep 단위 검증. `tests/run-all.sh`에 등록.

---

## Phase B (배포·라이브 검증, 별도)
1. `scripts/build-ami.sh ubuntu` → 새 AMI → SSM `/cc-on-bedrock/devenv/ami-id/ubuntu` 갱신(빌드 wait 10분 타임아웃 → 수동 갱신 주의).
2. dev 검증: 신규 사용자 born-attached / atomoh·psungbum 자동 마이그레이션 / terminate→재생성 무손실 / resize=데이터만 확장.
3. 통과 시 ADR-032 `status: Accepted`, 메모리 `devenv-ami-boot-ebs` 갱신.
