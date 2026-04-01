# ADR-003: ECS Managed EBS에서 Host Attach 방식으로 전환

## Status
Proposed (2026-04-01)

## Context
현재 ECS managed EBS volume (`configuredAtLaunch: true`)은 매 RunTask마다 새 볼륨을 생성한다.
AWS ECS API에 `volumeId` 파라미터가 없어 기존 볼륨 재연결이 불가능하다.

이로 인해:
1. 매 시작마다 snapshot에서 볼륨 복원 → 수분 소요
2. `deleteOnTermination: false`일 때 orphan 볼륨 누적
3. snapshot 조회 실패 시 빈 볼륨 생성 → 데이터 손실 위험

## Decision
Phase 1에서 snapshot 기반 데이터 무결성을 확보한 후,
Phase 2에서 Lambda가 EC2 호스트에 기존 EBS를 직접 attach → host mount하는 방식으로 전환한다.

## Rationale
| 항목 | ECS Managed (현행) | Host Attach (Phase 2) |
|------|-------------------|----------------------|
| 시작 시간 | 수분 (snapshot → 새 볼륨) | 수초 (기존 볼륨 attach) |
| 볼륨 재사용 | 불가 (매번 새 볼륨) | 가능 (동일 볼륨 재연결) |
| Orphan 위험 | 있음 | 없음 (1 user = 1 volume) |
| 구현 복잡도 | 낮음 | 높음 (Lambda + SSM + placement) |
| AZ 장애 대응 | snapshot 복원 | snapshot으로 다른 AZ에 새 볼륨 |

## Consequences
- 새로운 Lambda 2개 (ebs-attach, ebs-detach) + EventBridge Rule 추가
- CDK Task Definition에서 `configuredAtLaunch` 제거
- SSM RunCommand 의존성 추가 (EC2 인스턴스에 SSM Agent 필수)
- Device name 관리 로직 필요 (`/dev/xvd{f-p}`)
- Placement constraint로 특정 EC2 인스턴스 지정 → 스케줄링 유연성 감소

## Alternatives Considered
1. **Snapshot 기반만 유지**: orphan 정리 + 경고 추가. 간단하지만 시작 시간 개선 없음
2. **Docker Volume Plugin (rexray)**: deprecated, 유지보수 불가
3. **EFS 전환**: 공유 스토리지로 전환하면 볼륨 관리 불필요. 하지만 EBS 대비 IOPS 성능 열세
