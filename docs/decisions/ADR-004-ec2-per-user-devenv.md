# ADR-004: DevEnv 아키텍처 전환 — ECS Task → EC2-per-user

## Status: Accepted

## Date: 2026-04-03

## Supersedes
- [ADR-001: EBS + S3 Storage Strategy](ADR-001-ebs-s3-storage-strategy.md) — EC2 root volume이 EBS 격리 + S3 sync를 대체
- [ADR-003: EBS Host Attach](ADR-003-ebs-host-attach.md) — EC2-per-user로 ECS host attach 문제 자체 제거

## Context

CC-on-Bedrock의 개발환경(code-server)이 ECS Task로 실행되고 있으나, code-server는 본질적으로 stateful 워크로드(파일, 패키지, 시스템 설정 보존 필요)이다. ECS는 stateless 워크로드에 최적화되어 있어 다음 11개 문제가 발생:

1. ECS managed EBS가 기존 volume 재연결 불가 — 매번 snapshot/restore
2. Snapshot Lambda가 volume_id를 못 찾음 — ECS task attachment에서 추출 필요
3. DynamoDB user_id 불일치 (email vs subdomain) — orphan 레코드
4. Docker 이미지 캐싱 — ECS_IMAGE_PULL_BEHAVIOR=always 필요
5. /usr/local 보존 — symlink + /usr/local.bak + image-id 버전 관리 hack
6. /home/coder 소유권 — EBS 복원 시 root:unknown GID, 매 시작 chown -R
7. 구 snapshot 데이터 마이그레이션 — /data 루트 vs /data/home
8. PEP 668 pip 제한 — Dockerfile에서 EXTERNALLY-MANAGED 삭제
9. apt install 패키지 보존 불가 — /usr/bin, /usr/lib은 Docker layer
10. Scale-in 지연 — orphan 인스턴스, capacity provider 충돌
11. CDK CFN state 불일치 — 서비스 수동 삭제 후 CREATE/UPDATE 충돌

## Decision

DevEnv을 **EC2-per-user** 아키텍처로 전환한다.

- 각 사용자에게 독립 EC2 인스턴스 (ARM64, t4g.medium~large)
- AMI에 code-server + Claude Code + Kiro + 기본 도구 사전 설치
- Stop/Start로 모든 상태 보존 (EBS root volume 유지, snapshot 불필요)
- SSH 비활성, SSM Session Manager만 허용
- ECS 클러스터 유지: Dashboard + Nginx 서비스 (EC2 모드)
- Nginx routing: `cc-routing-table` DynamoDB에 instance private IP 등록 (기존 패턴 재사용)

## Consequences

### 제거되는 것
- `cdk/lib/lambda/ebs-lifecycle.py` (486줄) — snapshot/restore 전체
- `cdk/lib/lambda/warm-stop.py`의 snapshot 관련 로직 (~400줄)
- `docker/devenv/scripts/entrypoint.sh`의 EBS symlink 로직 (~50줄)
- `/usr/local.bak`, `.image-id` 버전 관리
- DynamoDB `cc-user-volumes` 테이블
- ECS devenv task definitions (6개)
- ECS managed EBS volume 관련 코드 (aws-clients.ts ~200줄)

### 유지되는 것
- ECS 클러스터 (Dashboard + Nginx)
- Nginx + NLB + CloudFront 라우팅 레이어
- DynamoDB `cc-routing-table` (IP 소스만 ECS task → EC2 instance)
- Cognito 인증 + NextAuth
- Bedrock 직접 접근 (Task Role → Instance Profile)
- DLP 보안 정책 (Security Group per user)

### 새로 필요한 것
- AMI 빌드 파이프라인 (EC2 Image Builder 또는 Packer)
- DynamoDB `cc-user-instances` (PK: subdomain → instance_id, status)
- EC2 Start/Stop Lambda (warm-stop 대체, ~200줄)
- CloudWatch Agent 기반 idle detection
- per-user IAM Instance Profile 관리

### 비교

| 항목 | ECS (현재) | EC2-per-user |
|------|-----------|-------------|
| 시작 시간 | 1.5-7분 | 30-75초 |
| 패키지 보존 | /usr/local만 (hack) | apt 포함 전부 |
| 코드 복잡도 | ~2,200줄 | ~900줄 (55% 감소) |
| 비용 (100명) | ~$7,200/월 | ~$6,200/월 |
| EBS 관리 | snapshot/restore 매번 | Stop/Start → 자동 보존 |

## Implementation Status

전 항목 구현 완료 (2026-04-16 기준).

| 구성요소 | 구현 위치 |
|---------|---------|
| EC2 인스턴스 관리 (start/stop/terminate) | `shared/nextjs-app/src/lib/ec2-clients.ts` |
| AMI 빌드 파이프라인 | `scripts/build-ami.sh` (SSM 기반, Ubuntu 24.04 ARM64) |
| Launch Template (gp3 30GB, encrypted, hibernation) | `cdk/lib/07-ec2-devenv-stack.ts` |
| DynamoDB `cc-user-instances` | 동일 파일 — PK: subdomain → instanceId, status, tier |
| Idle detection + auto-stop | `cdk/lib/lambda/ec2-idle-stop.py` + EventBridge 15분 주기 |
| Nginx routing 연동 | `cc-routing-table` DynamoDB에 instance private IP 등록 |
| EC2 Hibernation (ADR-010) | Feature flag `HIBERNATE_ENABLED`, ~5초 resume |
| Per-user IAM Instance Profile | `ec2-clients.ts` — Bedrock 접근 + DLP 정책 |
| Per-user Security Group | `ec2-clients.ts` — open/restricted/locked 정책별 규칙 |

### 제거된 ECS devenv 코드
- `cdk/lib/lambda/ebs-lifecycle.py` — dead code (CDK 미참조)
- `cdk/lib/lambda/warm-stop.py` — dead code (CDK 미참조)
- ECS devenv task definition — Stack 04에서 Nginx/Dashboard만 잔존
