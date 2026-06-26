---
status: Accepted
verification_required: false
date: 2026-06-26
consolidates: []
---

# 012: DevEnv 헬스 판정 (직접 probe 제거 → EC2 lifecycle 파생)

## Status

Accepted (2026-06-26)

## Context

사용자 포털(`/user` 환경 탭)은 DevEnv의 code-server(포트 8080) 도달 여부를
대시보드에서 직접 TCP probe 하여 `healthStatus`를 판정했다. 그러나 DevEnv 보안
그룹은 8080 ingress 를 **공유 nginx 리버스 프록시 SG 로만** 제한한다(네트워크
격리, `terraform/modules/ec2-devenv`). 대시보드는 그 SG에 속하지 않으므로
대시보드→devenv:8080 직접 probe 는 항상 SG에서 drop 되어 timeout 된다.

결과적으로 code-server 가 정상 부팅되어 nginx 를 통해 사용자에게 서비스되고
있어도 포털은 "code-server is starting up..." 에 **영구히 고착**(permanent
false-negative)되었고, IDE/WEB/API URL 카드가 절대 노출되지 않았다.

## Decision

대시보드에서의 직접 probe 를 제거하고, `healthStatus` 를 EC2 lifecycle 상태에서
파생한다. 판정 로직은 순수 함수 `deriveDevenvHealth(status, privateIp)`
(`shared/nextjs-app/src/lib/devenv-health.ts`)로 추출하고 vitest 로 단위
테스트한다.

- `status` 가 `running`(대소문자 무시) 이고 `privateIp` 가 비어있지 않으면
  `HEALTHY`, 그 외에는 `UNKNOWN`.
- 이는 admin `/api/containers`(running ⇒ HEALTHY)와 동일한 판정 기준이다.
- `ContainerInfo.healthStatus` 타입을 `"HEALTHY" | "UNKNOWN"` union 으로 좁혀
  소비자 분기를 타입 수준에서 검증 가능하게 한다.

## Trade-off (명시적 수용)

`healthStatus` 의미가 **"code-server/proxy 도달 가능"** 에서 **"인스턴스 running
+ private IP 보유"** 로 바뀐다. cold start 직후 인스턴스는 code-server 부팅
완료(~30–60초) 전에 수십 초간 `running` 으로 보고될 수 있어, 그 구간에는
낙관적으로 `HEALTHY` 로 표시된다. SSE 프로비저닝 flow 밖(페이지 새로고침,
stopped 인스턴스의 warm restart)에서는 짧은 시간 동안 사용자가 일시적으로 502
가능한 IDE 링크를 볼 수 있다.

이 trade-off 를 **수용**한다. 근거:
1. 기존 동작은 *영구적* false-negative(포털이 절대 사용 불가)로 엄격히 더 나쁘다.
2. fresh-create 경로의 readiness 는 SSE 프로비저닝 flow 가 이미 커버한다.
3. code-server 부팅은 짧고(~30–60초) 자가 수렴하며, 새로고침으로 회복된다.
4. SG 격리로 신뢰할 수 없게 된 직접 probe 를 다시 들이지 않는다.

## Alternatives considered

- **nginx 경유 간접 health check** — nginx 는 도달 가능하므로 readiness 를 간접
  확인할 수 있으나, 이 변경이 제거한 probe 의 지연·결합을 poll 마다 다시
  도입한다. 기각.
- **별도 상태(`INSTANCE_RUNNING` / `STARTING`) 분리** — false-positive 윈도우를
  줄일 수 있으나 `environment-tab` / `containers-table` / `user-portal` 소비자
  변경이 필요하다. 현재 낙관적 매핑이 admin route 와 일관되고 방어 가능하므로
  **follow-up 으로 보류**.

## Follow-up

- `containers-table.tsx` 의 `Starting...` 분기는 admin route 가 `STARTING` 을
  emit 하지 않아 repo 전역 dead value 다. 별도 정리 PR 에서 제거.
- false-positive 윈도우를 줄이는 readiness 신호(예: nginx 헬스 엔드포인트, 또는
  별도 상태)를 후속 검토.

## Consequences

- 포털이 더 이상 영구 false-negative 에 고착되지 않는다.
- `healthStatus` 는 lifecycle 파생 값이며 code-server 애플리케이션 readiness 의
  보증이 아니다(위 trade-off).
