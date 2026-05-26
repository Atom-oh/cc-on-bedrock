# ADR-017: Dashboard ECS Rolling Deployment + Circuit Breaker

## Status
Accepted (2026-04-17, retrospective documentation 2026-05-12)

## Context
Dashboard는 `CcOnBedrock-Dashboard` 스택의 ECS Ec2Service로 운영된다. EC2 launch type에 `desiredCount=1`로 단일 task가 떠 있는 구조였고, 초기 deploy 설정은 다음 두 약점을 가졌다:

1. **`minHealthyPercent: 0`** — 새 deployment 시 기존 task를 먼저 stop한 뒤 새 task를 start. 이 사이 약 30-60초 동안 dashboard 접속이 503 (CloudFront 캐싱 disabled로 사용자에게 직접 노출).
2. **CircuitBreaker 미사용** — 새 task가 health check를 통과하지 못해도 deployment가 stalled 상태로 매달려 있어, 운영자가 수동으로 rollback해야 했다. 야간/주말 배포 시 발견 지연 위험.

게다가 dashboard task 사양이 `4 vCPU / 15 GiB`로 EC2 host(`c7g.large` 1 vCPU 사양에서 host 추가/큰 사양으로 운영) 거의 전부를 차지해, rolling deployment가 가능하더라도 새 task가 같은 host에 공존하지 못하는 문제도 함께 있었다.

## Decision

세 항목을 한 묶음으로 변경한다.

1. **`minHealthyPercent: 100`** + **`maxHealthyPercent: 200`** — 새 task가 health check를 통과한 뒤에 기존 task를 stop하는 진정한 rolling deployment. 다운타임 0초.
2. **`circuitBreaker: { enable: true, rollback: true }`** — deployment가 3회 연속 실패 시 자동 rollback. 사람 개입 없이 안전망 확보.
3. **Task 사양 반감 (`4 vCPU / 15 GiB` → `2 vCPU / 7.5 GiB`)** — 같은 EC2 host에 두 task가 일시적으로 공존할 헤드룸 확보. 평소엔 절반 사양이지만 dashboard 부하가 light(Next.js + DDB 쿼리)라 충분.

### Rationale

| 차원 | 이전 | 이후 |
|---|---|---|
| 다운타임 | 30-60초 (recreate) | 0초 (rolling) |
| 실패 시 동작 | 수동 rollback 필요 | 자동 rollback (3회 fail 후) |
| 리소스 사용 | 1 task = host 90% | 1 task = host 45% (rolling 중 일시 90%) |
| 비용 | 동일 | 동일 (host 수 미변동) |

핵심 트레이드오프: task 사양을 줄이면 burst 부하에 약해질 수 있다. 그러나 dashboard는 (a) Bedrock 호출이 없고(=AI 처리는 별도 라우트), (b) DDB 쿼리/Cognito 호출 중심의 light workload, (c) Next.js streaming SSR이 메모리를 크게 잡지 않는다. 측정값 기준 평균 메모리 < 2 GiB로 마진 충분.

## Changes

- `cdk/lib/05-dashboard-stack.ts`
  - ECS Ec2Service 정의에 `minHealthyPercent: 100`, `maxHealthyPercent: 200` 추가
  - `circuitBreaker: { rollback: true }` 추가
  - Task definition CPU `4096 → 2048`, memory `15360 → 7680`

## Consequences

### Positive
- Dashboard 무중단 배포 (사용자 가시 다운타임 0)
- 실패 deployment 자동 감지 및 rollback (운영 부담 감소)
- 야간/주말 배포의 안전성 확보

### Negative
- Task 사양 반감으로 burst 부하 마진 축소. 모니터링 필요(CW Memory > 80% 알람 권장)
- circuitBreaker가 rollback 후에도 health check 실패가 코드 문제이면 같은 결과 반복. 근본 원인을 봐야 함

### Operational Notes
- EC2 host capacity는 `c7g.large` 2대(또는 동등) 권장. host 1대만 있으면 rolling 중 task 2개가 동일 host에 떠야 하므로 메모리 fragmentation 가능
- Dashboard ECS task definition을 늘리려면 host capacity도 함께 검토

## References
- ADR-013: Unified CloudFront (시기적 동일 배포 사이클)
- AWS docs: ECS deployment circuit breaker
- 관련 commit: `3feb85d` (circuit breaker), `f2808a6` (task size halving)
