# ADR-001: EFS에서 EBS + S3 동기화 스토리지 전략으로 전환

## Status
Superseded by [ADR-004](ADR-004-ec2-per-user-devenv.md) (2026-04-03)

## Context
CC-on-Bedrock Enterprise Edition에서 4000명 사용자(1000명 동시)를 지원해야 함.
현재 EFS Bursting 모드는:
- 10GB 저장 시 50MiB/s 기본 throughput → 1000명 동시 사용 시 극심한 I/O 병목
- Access Point 미사용으로 사용자 간 파일 접근 가능 (보안 위험)
- $0.30/GB로 80TB 저장 시 $24,000/월 비용

## Decision
사용자별 EBS gp3 볼륨 + S3 incremental 동기화 전략으로 전환.

## Rationale
| 항목 | EFS | EBS + S3 |
|------|-----|----------|
| IOPS | ~8K (공유) | 3K-16K (사용자 전용) |
| Throughput | 50MiB/s burst | 125-1000 MiB/s |
| 사용자 격리 | Access Point 필요 | 자연 격리 (별도 볼륨) |
| 비용 (80TB) | $24,000/월 | $6,440/월 (EBS+Snapshot+S3) |
| AZ 제약 | 없음 (Multi-AZ) | AZ 종속 → S3 동기화로 해결 |
| 관리 복잡도 | 낮음 | 높음 (Lambda + Step Functions) |

## Consequences
- 73% 비용 절감 ($24,000 → $6,440/월)
- EBS lifecycle 관리 복잡도 증가 (Lambda + Step Functions 필요)
- AZ 이동 시 S3 복원 필요 (2-3분 소요)
- 5분 주기 sync로 최대 5분 데이터 유실 가능

## Implementation Outcome

ADR-004 (EC2-per-user, 2026-04-03)가 더 단순한 아키텍처로 동일 목표를 달성하여 본 ADR을 대체함.

| ADR-001 목표 | 달성 여부 | ADR-004에서의 구현 |
|-------------|---------|------------------|
| Per-user EBS gp3 격리 | **달성** | EC2 인스턴스 root volume (30GB gp3, encrypted) |
| S3 incremental sync | **불필요** | EC2 Stop/Start가 EBS 상태를 자동 보존 |
| EFS 제거 | **부분** | EC2 devenv는 EFS 미사용. Stack 04에 레거시 잔존 |
| User 격리 | **달성** | EC2-per-user + per-user Security Group + IAM Profile |
| Lambda + Step Functions | **불필요** | EC2 Stop/Start로 오케스트레이션 불필요 |

### 레거시 잔존 항목
- `cdk/lib/04-ecs-devenv-stack.ts`: EFS FileSystem 생성 (ECS devenv 레거시)
- `shared/nextjs-app/src/lib/types.ts`: `storageType: "ebs" | "efs"` 타입 정의
