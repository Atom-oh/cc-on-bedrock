---
status: Accepted
date: 2026-06-23
consolidates: [ADR-017]
---

# 011: 대시보드 배포 (ECS rolling deployment + circuit breaker)

## Status

Accepted (2026-06-23)

## Context

Dashboard는 ECS Ec2Service로 단일 task(`desiredCount=1`)로 운영된다. 초기 배포 설정은 두 약점을 가졌다: (1) `minHealthyPercent=0` — 새 배포가 기존 task를 먼저 stop한 뒤 새 task를 start해 약 30-60초 동안 사용자에게 503이 직접 노출(dashboard CloudFront 캐싱 disabled), (2) circuit breaker 미사용 — 새 task가 health check를 통과하지 못하면 배포가 stalled 상태로 매달려 야간/주말 배포 시 발견·수동 rollback 지연 위험. 또한 task 사양(`4 vCPU / 15 GiB`)이 EC2 host를 거의 전부 차지해 rolling 중 두 task가 같은 host에 공존하지 못했다.

The dashboard runs as a single-task ECS Ec2Service. The initial deploy config caused ~30-60s of user-facing 503s on every deploy (stop-then-start, no CloudFront caching to absorb it) and had no automatic failure handling, so a failed deploy hung until manually rolled back. The task spec was also too large to allow two tasks to co-reside on one host during a rolling deploy.

아키텍처 상세는 `../architecture.md`(SSOT)가 소유한다 — 여기서 재유도하지 않는다.

## Decision

**무중단 rolling deployment + 자동 rollback circuit breaker로 대시보드를 배포한다. 이 배포 설정은 이제 `terraform/modules/dashboard/`에 정의된다(CDK 스택 아님 — 001/ADR-033 단일 IaC).**

**Deploy the dashboard via zero-downtime rolling deployment with an auto-rollback circuit breaker. This deploy configuration now lives in `terraform/modules/dashboard/`, not a CDK stack (Terraform is the single IaC — see 001).**

- **`minHealthyPercent=100` + `maxHealthyPercent=200`** — 새 task가 health check를 통과한 뒤에 기존 task를 stop하는 진정한 rolling deployment. 사용자 가시 다운타임 0초.
  True rolling: new task must pass health checks before the old one stops; zero user-visible downtime.
- **deployment circuit breaker (`rollback=true`)** — 연속 실패 시 자동 rollback. 사람 개입 없이 안전망 확보.
  Failed deployments auto-roll-back without operator intervention.
- **Task 사양 반감 (`4 vCPU / 15 GiB` → `2 vCPU / 7.5 GiB`)** — 같은 host에 두 task가 일시 공존할 헤드룸 확보. dashboard는 light workload(Bedrock 호출 없음, DDB 쿼리·Cognito 중심, Next.js SSR), 측정 평균 메모리 < 2 GiB로 마진 충분.
  Halved task spec gives headroom for two tasks to briefly co-reside; the dashboard is a light workload with ample margin.

| 차원 / dimension | 이전 / before | 이후 / after |
|---|---|---|
| 다운타임 / downtime | 30-60s (recreate) | 0s (rolling) |
| 실패 시 / on failure | 수동 rollback | 자동 rollback |
| host 점유 / host use | 1 task ≈ 90% | 1 task ≈ 45% (rolling 중 ~90%) |
| 비용 / cost | 동일 | 동일 (host 수 미변동) |

## Consequences

긍정 / Positive
- 무중단 배포(사용자 가시 다운타임 0), 실패 배포 자동 감지·rollback, 야간/주말 배포 안전성 확보.

부정·위험 / Negative & risk
- Task 사양 반감으로 burst 부하 마진 축소 → CW Memory > 80% 알람 권장.
- health check 실패가 코드 결함이면 rollback 후에도 동일 결과 반복 — 근본 원인 확인 필요.
- EC2 host capacity 권장 `c7g.large` 2대(또는 동등); host 1대만이면 rolling 중 두 task가 동일 host에 떠 메모리 fragmentation 가능. task 사양을 늘릴 땐 host capacity도 함께 검토.

운영 / Operational
- 배포 설정 정본은 `terraform/modules/dashboard/` (ECS service의 `deployment_minimum_healthy_percent` / `deployment_maximum_percent` + `deployment_circuit_breaker { rollback = true }`). CDK 스택은 폐기됨(001/ADR-033).

## Consolidates

- **ADR-017** (Dashboard ECS rolling deployment + circuit breaker)

레거시 ADR 본문은 트리에서 제거되었고 git tag `adr-legacy-2026-06-23` + `../history/ADR-MAPPING.md`에 보존된다. 번호 재사용 금지.
Legacy bodies live in git tag `adr-legacy-2026-06-23` and `../history/ADR-MAPPING.md`.
