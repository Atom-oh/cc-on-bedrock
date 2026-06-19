# Spec: per-user 영속 데이터 EBS 분리 (ADR-032)

**ADR:** [ADR-032](../../decisions/ADR-032-persistent-data-ebs.md)
**Date:** 2026-06-19 · **Branch base:** main
**Revision:** r2 — consensus 게이트 round-1(codex+agy) CRITICAL/MAJOR 반영

## Goal
ephemeral OS root ↔ persistent `/home/coder` 데이터 EBS 분리. 신규 = born-attached, 기존 = SSM 아웃오브밴드 마이그레이션, terminate/AMI교체/OS전환 무손실, resize는 데이터 볼륨 리타겟.

## Invariants (security / portability / 패널 반영)
- 데이터 볼륨 `Encrypted=true`, `DeleteOnTermination=false`, 런치 후 `CreateTags`로 `cc:subdomain`/`cc:role=data`/`managed_by=cc-on-bedrock`/`cc:project=cc-on-bedrock` 부여(RunInstances volume TagSpec은 root까지 태깅하므로 분리 불가).
- **권위 식별자 = DynamoDB `dataVolumeId`+`dataVolumeAz`**; 태그 조회는 보조이며 **다중 매칭 시 fail-closed**.
- **장치 판별 = EBS volume-id(NVMe serial)**, device name/`/dev/nvme1n1` 하드코딩 금지.
- **AZ 핀 필수** — 재연결/OS전환 launch는 `dataVolumeAz`의 SubnetId로 핀; 불일치 fail-closed.
- 마운트 fstab `LABEL=CCDATA defaults,nofail,x-systemd.device-timeout=10s 0 2` — 부팅 brick 방지.
- raw-device ext4(파티션 없음) → resize는 `resize2fs` 직접, **`growpart` 미사용**.
- 마이그레이션: 멱등 + fail-safe(임시 마운트+rsync **검증 통과 전 원본 rename 금지**); 부팅 유닛 `DefaultDependencies=no`+`Before=code-server.service`, 유닛 내 `systemctl restart` 금지.
- IAM action별 분리(`aws:RequestTag` on create, `ec2:ResourceTag`(볼륨+인스턴스) on attach/detach/modify/delete, `ec2:CreateTags` via `ec2:CreateAction`). 0.0.0.0/0·`Principal:"*"`·평문 시크릿 금지.
- stop/start 경로 동작 변경 없음. start/switchOs는 DynamoDB 조건부 전이로 직렬화.

## Phasing
- **Phase A (코드/마운트 로직, 무배포 단위검증):** Task 1–8. 순수 함수·userdata/SSM 스크립트 문자열·AMI/CDK 변경 + 단위테스트. `bash tests/run-all.sh` 그린.
- **Phase B (배포·라이브 검증, dev):** 새 AMI → 신규 born-attached / 기존(atomoh·psungbum) SSM 마이그레이션 / terminate→재생성 무손실 / resize 리타겟 / AZ-mismatch fail-closed 라이브 검증. ADR `status: Accepted`.

이 spec의 consensus 게이트(P2)와 구현(P3)은 **Phase A**만 대상. Phase B는 사용자 입회 라이브 배포.

---

### Task 1: 데이터 볼륨 헬퍼 (식별·AZ·태깅, 순수 로직)
**Files:**
- Create: `shared/nextjs-app/src/lib/data-volume.ts` —
  `dataVolumeTags(...)`; `dataVolumeBlockDeviceMapping(sizeGb)` (`/dev/sdf`, gp3, `DeleteOnTermination:false`, `Encrypted:true`);
  `findDataVolume(subdomain)` → DescribeVolumes by 태그, **2개↑면 throw(fail-closed)**, `{volumeId, az, state}` 반환;
  `resolveSubnetForAz(az)` → 해당 AZ의 SubnetId(없으면 throw);
  `tagDataVolumeAfterLaunch(volumeId, subdomain, ...)` → `CreateTags` `cc:role=data`;
  `attachDataVolume(instanceId, volumeId)`.
- Test: `shared/nextjs-app/src/lib/__tests__/data-volume.test.ts` — BDM(`DeleteOnTermination===false`,`Encrypted===true`); `findDataVolume` 다중 매칭 throw; `resolveSubnetForAz` AZ 매칭/미스 throw; 태그 구성.

### Task 2: 부팅 마운트 + 마이그레이션 스크립트 (단일 로직, 순수 문자열)
**Files:**
- Create: `shared/nextjs-app/src/lib/data-volume-userdata.ts` — `dataVolumeMigrateScript(expectedVolumeId)` 가 멱등·fail-safe 셸을 반환:
  volume-id로 NVMe 장치 해석(`/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_<vol>`); **attach 도달까지 bounded-wait**; LABEL CCDATA 존재 검사(있으면 mkfs 스킵); 빈 볼륨이면 `mkfs.ext4 -L CCDATA`(raw); **임시 마운트→`rsync -aXH`→검증→성공 시에만 `/home/coder`→`/home/coder.old-root` rename**→데이터 볼륨 `/home/coder` 마운트→fstab `LABEL=CCDATA ...nofail...`→마커 `/home/coder/.cc-data-volume`; 실패 시 원본 보존 non-fatal exit.
- Test: `shared/nextjs-app/src/lib/__tests__/data-volume-userdata.test.ts` — (a) device name 아닌 volume-id로 장치 해석, (b) fstab `nofail`+`x-systemd.device-timeout`, (c) mkfs 전 LABEL 검사, (d) 검증 전 원본 rename 없음(순서), (e) 마커 멱등 가드, (f) `systemctl restart` 부재.

### Task 3: startInstance 통합 (born-attached + AZ-핀 재연결 + 락)
**Files:**
- Modify: `shared/nextjs-app/src/lib/ec2-clients.ts` — 신규: RunInstances BDM에 데이터 볼륨 추가 → 런치 후 `tagDataVolumeAfterLaunch` + DynamoDB `dataVolumeId`/`dataVolumeAz` 기록; 재연결: `findDataVolume`→`resolveSubnetForAz`로 **AZ 핀** root-only RunInstances → `attachDataVolume`, UserData로 `expectedVolumeId` 전달; start/switch는 DynamoDB 조건부 전이(op-token)로 직렬화.
- Test: `shared/nextjs-app/src/lib/__tests__/ec2-clients-datavol.test.ts` — 신규 경로 BDM(`DeleteOnTermination:false`); 재연결이 볼륨 AZ의 SubnetId로 핀; mock EC2로 호출 캡처.

### Task 4: lifecycle 무손실 (terminate 보존 / switchOs unmount-detach / resize 리타겟)
**Files:**
- Modify: `shared/nextjs-app/src/lib/ec2-clients.ts` — `terminateInstance`: 데이터 볼륨 보존(주석 명확화); `switchOs`: code-server 정지→`sync`→unmount→detach→**볼륨 `available` 폴링 대기**→옛 인스턴스 terminate→AZ 핀 새 인스턴스→reattach.
- Modify: `shared/nextjs-app/src/app/api/admin/ebs-resize/route.ts` — `ModifyVolume` 대상을 root가 아니라 DynamoDB `dataVolumeId`(없으면 `findDataVolume`)로.
- Modify: `shared/nextjs-app/src/app/api/user/ebs-resize/route.ts` — 신청/표시 `volumeId` 소스를 데이터 볼륨으로.
- Test: `shared/nextjs-app/src/lib/__tests__/ebs-resize-target.test.ts` — resize 셀렉터가 데이터 볼륨 id로 `ModifyVolume` 호출(순수 함수 추출 후 검증).

### Task 5: AMI 베이크 (마운트/마이그레이션 systemd oneshot + resize 훅)
**Files:**
- Modify: `scripts/build-ami.sh` — `cc-data-migrate.service`(oneshot, `DefaultDependencies=no`, `Before=code-server.service`, every-boot, 멱등; 본문 = Task 2와 동일 로직, 유닛 내 `systemctl restart` 없음) + 온라인 `resize2fs`(데이터 볼륨, growpart 없음) 훅 베이크.
- Test: `tests/unit/test-build-ami-datavol.sh` — `LABEL=CCDATA`, `nofail`, 멱등 마커, fail-safe 가드, `DefaultDependencies=no`/`Before=code-server.service`, `growpart` 부재, `cc-data-migrate.service` enable을 `bash -n`+grep 검증. `tests/run-all.sh` 등록.

### Task 6: 레거시 인스턴스 SSM 아웃오브밴드 마이그레이션
**Files:**
- Create: `shared/nextjs-app/src/lib/data-volume-ssm.ts` — `migrateLegacyInstance(subdomain, instanceId)`: 인스턴스 AZ 조회→AZ 매칭 빈 볼륨 생성·태깅·attach→DynamoDB 기록→`SendCommand`(AWS-RunShellScript)로 Task 2 스크립트 실행→완료 폴링. 멱등(마커 존재 시 no-op), fail-safe.
- Test: `shared/nextjs-app/src/lib/__tests__/data-volume-ssm.test.ts` — 볼륨이 인스턴스 AZ에 생성되는지, SSM 스크립트에 expectedVolumeId가 주입되는지(mock) 검증.

### Task 7: orphan 볼륨 정리 (admin 완전 삭제, ADR-024)
**Files:**
- Modify: `shared/nextjs-app/src/lib/ec2-clients.ts` (또는 aws-clients 사용자 삭제 경로) — 완전 삭제 시 데이터 볼륨 detach→`available` 대기→(선택)최종 snapshot→`DeleteVolume`→DynamoDB `dataVolumeId` clear→감사 로그.
- Test: `shared/nextjs-app/src/lib/__tests__/data-volume-cleanup.test.ts` — detach→available→delete 순서, DynamoDB clear, available 미도달 시 delete 안 함.

### Task 8: IAM 권한 (CDK security stack, action별 분리)
**Files:**
- Modify: `cdk/lib/02-security-stack.ts` — 대시보드 EC2 역할에 `ec2:CreateVolume`(`aws:RequestTag/cc:project`), `ec2:CreateTags`(`ec2:CreateAction`∈{CreateVolume,RunInstances}), `ec2:AttachVolume`/`DetachVolume`/`ModifyVolume`/`DeleteVolume`+`ssm:SendCommand`(볼륨·인스턴스 `ec2:ResourceTag/cc:project`) 추가. ADR-026 boundary ⊇ allowlist 유지.
- Test: `cdk synth CcOnBedrock-Security` 후 `python3 scripts/check-policyset-boundary.py --template ...`(tests/run-all.sh 기존 게이트)로 boundary 불변식 검증.

---

## Phase B (배포·라이브 검증, 별도)
1. `scripts/build-ami.sh ubuntu` → 새 AMI → SSM `/cc-on-bedrock/devenv/ami-id/ubuntu` 갱신(빌드 wait 10분 타임아웃 → 수동 갱신).
2. dev 검증: 신규 born-attached / atomoh·psungbum SSM 마이그레이션 / terminate→재생성 무손실 / resize=데이터만 / AZ-mismatch fail-closed.
3. 통과 시 ADR-032 `status: Accepted`, 메모리 `devenv-ami-boot-ebs` 갱신.
