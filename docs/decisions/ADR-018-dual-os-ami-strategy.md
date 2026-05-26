# ADR-018: Dual-OS AMI Strategy (Ubuntu 24.04 + Amazon Linux 2023)

## Status
Accepted (2026-04-17, retrospective documentation 2026-05-12)

## Context
EC2 per-user DevEnv(ADR-004)는 사용자 환경을 AMI로 미리 굽고 부팅 시 빠르게 띄우는 구조다. 초기엔 **Ubuntu 24.04** 단일 AMI로 시작했으나 운영 중 두 가지 요구가 등장했다:

1. **사용자 OS 선호** — 일부 부서/개발자가 RHEL 계열을 선호. Cognito custom attribute `containerOs`가 `ubuntu|al2023`을 선택할 수 있도록 이미 디자인에 들어가 있었지만, AMI 빌드 파이프라인이 단일 OS만 지원했다.
2. **AL2023 호환성** — AWS SDK 일부 도구/AgentCore 통합이 RHEL 계열에서 더 깔끔하게 동작하는 케이스. 환경 검증을 위해 두 OS 모두 빌드 가능해야 함.

기존 `scripts/build-ami.sh`는 첫 번째 인자로 인스턴스 타입을 받고 Ubuntu 패키지 관리자(`apt`) + `snap` 기반 SSM Agent 설치를 하드코딩하고 있었다.

## Decision

`scripts/build-ami.sh`를 **OS-type 기반 분기**로 재구성한다.

```bash
# 호출 방식
bash scripts/build-ami.sh ubuntu  c7g.large    # Ubuntu 24.04 AMI 빌드
bash scripts/build-ami.sh al2023  c7g.large    # AL2023 AMI 빌드
```

- 첫 번째 인자: OS type (`ubuntu` | `al2023`)
- 두 번째 인자: 인스턴스 타입 (기존 첫 번째 인자에서 이동)
- AMI ID는 SSM Parameter Store에 OS별로 저장: `/cc-on-bedrock/devenv/ami-id/{os_type}`
- 공통 setup(CW Agent 설정, code-server, hibernate enable)은 별도 함수로 분리해 두 OS가 공유
- Ubuntu 경로 유지(snap→deb SSM, apt 패키지). AL2023은 amazon/al2023 base + dnf 패키지

### Rationale

| 차원 | Ubuntu only | Dual-OS |
|---|---|---|
| 빌드 시간 | 1회 | 2회 (병렬 가능) |
| AMI 관리 | SSM 파라미터 1개 | OS별 1개씩 (2개) |
| 사용자 선택 | 없음 | Cognito `custom:containerOs` |
| 공통 코드 | 통째로 한 스크립트 | 공통 setup 함수 + OS별 install 함수 |
| 호환성 | Ubuntu 한정 | RHEL 계열 도구 검증 가능 |

핵심 판단: AMI 빌드 비용이 2배가 되지만, 사용자 자율성과 도구 호환성 검증 이득이 크다. 빌드는 GitHub Actions로 야간 cron 1회면 충분하므로 비용 부담은 무시 가능.

### Legacy Fallback

기존 `bash scripts/build-ami.sh c7g.large` (1-인자) 호출도 한동안 호환되도록 첫 인자가 `ubuntu|al2023`이 아니면 인스턴스 타입으로 간주하고 Ubuntu 빌드로 fallback. 6개월 후 제거.

## Changes

### Scripts
- `scripts/build-ami.sh` — 162 → 276 lines. OS-type 분기 + 공통 setup 함수 추출
- SSM Parameter 신규: `/cc-on-bedrock/devenv/ami-id/ubuntu`, `/cc-on-bedrock/devenv/ami-id/al2023`

### Dashboard
- 사용자가 `containerOs`를 선택하면 dashboard ECS task가 그에 해당하는 SSM에서 AMI ID를 읽어 EC2 RunInstances 호출 (이미 `ec2-clients.ts`에 구현되어 있음)

### Docker
- `docker/devenv/` 디렉토리가 더 이상 Ubuntu 전제 가정을 하지 않도록 OS-agnostic 표현으로 README/CLAUDE.md 정리 권장 (후속)

## Consequences

### Positive
- 사용자 OS 선호 충족 (자율성)
- 공통 setup 코드가 한 곳에 모여 유지보수 단순
- 패키지 관리자/SSM 설치 차이가 OS별 함수 안에 격리됨

### Negative
- AMI가 OS별로 2배 → 빌드 시간 2배, S3 저장 비용 약간 증가 (gp3 EBS snapshot 단가)
- AL2023 베이스의 잠재 보안 패치/AMI lifecycle 갱신 주기 별도 관리 필요
- AMI 빌드 실패가 두 OS 중 하나에서만 일어날 수 있어 CI 알림에 OS별 status 분리 필요

### Out of Scope
- 사용자 데이터 마이그레이션(Ubuntu→AL2023 전환) — EBS root는 별개라 OS 변경 시 새 인스턴스로 재구축 필요. 별도 runbook 후보
- Windows / macOS DevEnv — 본 ADR 범위 밖

## References
- ADR-004: EC2 per-user DevEnv (AMI 기반 구조)
- 관련 commit: `9f5cdd2` (build-ami.sh dual-OS 지원)
- 관련 파일: `scripts/build-ami.sh`, `shared/nextjs-app/src/lib/ec2-clients.ts`
