---
status: Accepted
date: 2026-06-23
consolidates: [ADR-004, ADR-010, ADR-018, ADR-032, ADR-001, ADR-003]
---

# 002: DevEnv 컴퓨트·스토리지 (per-user EC2 · dual-OS · 2-volume EBS · hibernation)

> 통합 ADR. 상세·현행 진실은 `../architecture.md`(SSOT)와 `BASELINE.md` §3 row 002. 본 문서는 결정 근거(why)를 보존한다.
> Consolidated ADR. Current-state truth lives in `../architecture.md` (SSOT) and `BASELINE.md` §3 row 002; this records the *why*.

## Status
Accepted (2026-06-23)

## Context

CC-on-Bedrock의 개발환경(code-server + Claude Code + Kiro)은 본질적으로 **stateful** 워크로드다 — 파일, apt/dnf 패키지, 시스템 설정, 열린 세션이 보존되어야 한다. 이 토픽은 4년에 걸쳐 진화했고 6개 레거시 결정으로 흩어져 있었다.

The DevEnv (code-server + Claude Code + Kiro) is an inherently **stateful** workload — files, apt/dnf packages, system config, and live sessions must survive. This topic evolved across six legacy decisions:

- **스토리지 1세대 (~~001·003~~, archived):** EFS → per-user EBS GP3 + S3 sync, 그리고 ECS managed EBS host-attach. 둘 다 ECS Task 모델의 산물 — snapshot/restore 사이클, orphan 볼륨, volume 재연결 불가 등 11개 문제.
- **컴퓨트 전환 (004):** DevEnv을 **EC2-per-user**로 전환하며 위 ECS 스토리지 문제 자체를 제거. EBS root volume이 인스턴스에 영구 귀속되어 Stop/Start로 상태 자동 보존.
- **dual-OS (018):** 사용자 OS 선호(Ubuntu vs RHEL 계열)와 도구 호환성 검증을 위해 AMI를 **Ubuntu 24.04 + Amazon Linux 2023** 2종으로 빌드.
- **hibernation (010):** Stop/Start 30–60초 + 메모리 상태 손실 → **Hibernate/Resume ~5초 + 완전 복원**.
- **스토리지 2세대 (032):** root volume 단일 영속 모델의 약점(rebuild/AMI-swap/OS-switch 시 데이터 위험, Terminate 시 백업 부재) 해결 — **OS root와 사용자 데이터를 별도 볼륨으로 분리**.

레거시 단일 root-volume 영속 모델의 결정적 약점은 2026-06-19 사고로 드러났다: 프로비저너 `RunInstances`가 `BlockDeviceMappings`를 생략해 AMI 기본값 `DeleteOnTermination=true`가 적용되었고, Terminate 시 5개 인스턴스의 root EBS가 백업 없이 삭제되어 사용자 데이터가 유실됐다. OS 상태와 사용자 데이터를 하나의 볼륨에 묶으면 OS 교체·재빌드가 항상 데이터를 위험에 노출한다.

## Decision

**per-user EC2 · dual-OS AMI · 2-volume EBS · hibernation** 으로 통합한다.

### 1. Per-user EC2 (← 004)
- 사용자당 독립 EC2 인스턴스 (Graviton ARM64, t4g.medium~m7g.xlarge tier).
- AMI에 code-server + Claude Code + Kiro + 기본 도구 사전 설치. 부팅 30–75초.
- SSH 비활성, **SSM Session Manager만** 허용. per-user Security Group(open/restricted/locked) + IAM Instance Profile.
- 라우팅: instance private IP를 `cc-routing-table` DynamoDB에 등록(nginx 연동). 인스턴스 인덱스: `cc-user-instances`(PK: subdomain → instanceId).

### 2. Dual-OS AMI (← 018)
- AMI 2종: **Ubuntu 24.04** / **Amazon Linux 2023** (둘 다 ARM64).
- 사용자 선택: Cognito custom attribute `custom:containerOs` (`ubuntu|al2023`).
- AMI ID는 OS별 SSM Parameter: `/cc-on-bedrock/devenv/ami-id/{os_type}`.
- 빌드: `scripts/build-ami.sh {ubuntu|al2023} {instance-type}` — 공통 setup 함수 + OS별 install 함수. fallback 경로 없음(첫 인자 비매칭 시 `exit 1`).

### 3. 2-volume EBS — 핵심 변경 (← 032, supersedes ~~001·003~~)
인스턴스는 **두 개의 EBS 볼륨**으로 부팅한다:

| 볼륨 | 마운트 | DeleteOnTermination | 수명 | 역할 |
|---|---|---|---|---|
| **OS root** | `/` | **`true`** (ephemeral) | 인스턴스/AMI에 종속 | OS·패키지·AMI 콘텐츠. rebuild/AMI-swap/OS-switch 시 폐기·재생성 |
| **persistent data** | `/home/coder` | **`false`** | 사용자에 종속 | 사용자 코드·설정·상태. subdomain 태그로 식별, rebuild·AMI-swap·OS-switch 전반에 걸쳐 **detach→reattach** |

- 데이터 볼륨은 GP3, encrypted, **subdomain-tagged** 로 사용자에 1:1 귀속.
- OS 교체(Ubuntu↔AL2023), AMI 갱신, 인스턴스 재빌드는 root만 교체하고 데이터 볼륨을 **재연결**한다 — 사용자 데이터가 OS 라이프사이클과 분리됨.
- 프로비저너 `RunInstances`는 **반드시 `BlockDeviceMappings`를 명시**하여 데이터 볼륨에 `DeleteOnTermination=false`를 강제한다(2026-06-19 사고 회귀 방지, fix `f751b60`).

### 4. Hibernation (← 010)
- 유휴/명시적 Stop은 가능하면 **Hibernate**(`HIBERNATE_ENABLED=true`, LIVE flag): RAM을 암호화 EBS에 저장 → Resume 시 code-server 세션·터미널·프로세스 완전 복원(~5초). 비용은 일반 Stop과 동일(컴퓨팅 과금 없음).
- per-instance capability check + 실패 시 일반 Stop **graceful fallback**. Launch 시점에만 설정 가능(기존 인스턴스는 일반 Stop).
- 제약: Hibernate 상태에서 인스턴스 타입 변경 불가 → `changeTier()`/`switchOs()`는 `Hibernate=false`. 최대 60일 제한 → 55일 도달 시 자동 Start→Re-Hibernate rotation.
- 사전 충족: 암호화 GP3 root + Graviton 타입. AMI에 `ec2-hibinit-agent` 설치 + KASLR 비활성화.

> Stop/Hibernate가 보존하는 것은 root(OS·RAM)와 데이터 볼륨 모두. **Terminate**가 발생해도 데이터 볼륨은 `DeleteOnTermination=false`로 살아남아 다음 인스턴스에 reattach된다.

## Consequences

- **Positive:**
  - 사용자 데이터가 OS·AMI·인스턴스 라이프사이클과 완전 분리 — OS 전환·재빌드·AMI 갱신이 데이터를 위험에 노출하지 않음.
  - Terminate 사고에도 데이터 볼륨 생존 (2026-06-19 회귀 방지).
  - ECS 스토리지 복잡도(snapshot/restore, orphan, host-attach Lambda) 전면 제거 (~2,200→~900줄, 55%↓).
  - Hibernate로 Stop/Resume UX ~5초, 비용 증가 없음.
  - dual-OS로 사용자 자율성 + RHEL 계열 도구 호환성 검증.
- **Negative:**
  - 볼륨 2개 관리(태깅·attach/detach 로직) + 프로비저너가 BlockDeviceMappings를 항상 명시해야 함.
  - AMI가 OS별 2배 → 빌드 시간·snapshot 저장 비용 증가(야간 cron 1회로 흡수).
  - Hibernate: AMI agent 필요, Launch 시점 한정, 60일 rotation, SSM 재연결 hook 필요.
- **Mitigations:**
  - `RunInstances` BlockDeviceMappings 명시를 정적 검증(아래)으로 회귀 차단.
  - Hibernate 실패 → 일반 Stop fallback. OS 전환/리사이즈는 자동으로 `Hibernate=false`.
  - 데이터 볼륨 subdomain 태그로 1 user = 1 volume 보장 → orphan 방지.

## Verification

```yaml
files:
  - path: docs/architecture.md
    must_contain:
      - "/Per-user EC2/"
      - "/Ubuntu|Amazon Linux 2023/"
      - "/DeleteOnTermination=false/"
      - "/Hibernat/"
semantic:
  - claim: "DevEnv instances boot with two EBS volumes — an ephemeral OS root (DeleteOnTermination=true) and a persistent subdomain-tagged /home/coder data volume (DeleteOnTermination=false) that is reattached across rebuild, AMI-swap, and OS-switch."
    context_files:
      - docs/decisions/002-devenv-compute-storage.md
      - docs/architecture.md
  - claim: "Idle/explicit Stop prefers EC2 Hibernation (HIBERNATE_ENABLED flag) with graceful fallback to plain Stop; changeTier/switchOs force Hibernate=false."
    context_files:
      - docs/decisions/002-devenv-compute-storage.md
```

## Consolidates

본 ADR이 흡수·대체하는 6개 레거시 결정:

| Legacy | 토픽 | 흡수된 결정 |
|---|---|---|
| **ADR-004** | EC2-per-user DevEnv | per-user EC2 컴퓨트 모델, AMI 사전 설치, SSM-only, 라우팅 |
| **ADR-010** | EC2 Hibernation | Hibernate/Resume + fallback + 60일 rotation |
| **ADR-018** | Dual-OS AMI Strategy | Ubuntu 24.04 / AL2023 2종 AMI + `containerOs` 선택 |
| **ADR-032** | Persistent Data EBS | OS root와 사용자 데이터 볼륨 분리 (2-volume) |
| ~~**ADR-001**~~ | EBS+S3 Storage (archived) | per-user EBS 격리 — root/data 영속 EBS로 대체, S3 sync 폐기 |
| ~~**ADR-003**~~ | EBS Host Attach (archived) | volume 재연결 — EC2 native attach/reattach로 대체 |

- 옛 본문은 트리에서 제거되었고 git tag **`adr-legacy-2026-06-23`** 로 보존된다.
- 번호 매핑: `../history/ADR-MAPPING.md`.
