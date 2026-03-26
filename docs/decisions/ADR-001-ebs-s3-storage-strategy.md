# ADR-001: EFS에서 EBS + S3 동기화 스토리지 전략으로 전환

## Status
Proposed (2026-03-26)

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
