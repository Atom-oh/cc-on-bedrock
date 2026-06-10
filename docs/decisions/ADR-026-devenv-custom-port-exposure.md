---
status: Accepted
verification_required: false
---

# ADR-026: DevEnv 사용자 커스텀 포트 노출 (ADR-009 확장)

## Status
Accepted

## Context
ADR-009 는 단일 서브도메인에서 code-server(8080)·frontend(3000)·API(8000) **고정 3포트**를 path 라우팅했다. 사용자가 다른 포트(Vite 5173, Grafana 등)를 노출하려면 규약 변경이 필요했다. ADR-009 "향후 확장 — 사용자 커스텀 포트"로 예고됨.

## Decision
사용자가 `{label, path, port}` 매핑을 **최대 5개** 등록 → nginx path 라우팅으로 노출. CloudFront/NLB/Lambda@Edge 변경 0.

- **예약 포트 = [8080]**(code-server). 3000/8000 은 seed default(편집·삭제 가능)로 강등.
- **path 보존(preserve)** 방식 — `proxy_pass`에 URI 미지정. 앱이 해당 path 밑에서 서빙되어야 함(base-path-aware). 한계(redirect/cookie 등)는 spec §8.1.
- **루트 `/`** 1개 지정 가능, **multi-segment** 허용(`/api/v1`).
- **세그먼트 경계 매칭**: `location = /p` + `location ^~ /p/` — `/preview`가 `/preview-evil` 을 가로채지 않음.
- 저장: `cc-user-instances`(source of truth, `routesVersion` 조건부쓰기) → `cc-routing-table` 미러(version guard, boot register가 hot-update 비덮어쓰기) → Stream → `nginx-config-gen.py` → S3 → reload.sh.
- **EC2 SG**(Stack 04, 실제 attach 경로): ingress source = NginxSg(SG chaining, B-H3), port **1024-65535**. host iptables 불채택(accepted risk — NginxSg-only source 가 봉쇄선). Stack 07 의 vpcCidr SG 는 런타임 미사용 dead code.
- **B-H1 차단**: config-gen 이 path/port + **subdomain·container_ip** 까지 보간 전 재검증, 불일치 행 skip + `routeStatus` 기록(UI 노출).

## Consequences
### Positive
- 사용자가 임의 포트를 동일 도메인에서 노출, CF/LB 무변경.
- code-server 게이트(8080) 보호 — 등록 시 명시적 에러.
- 설정 변경마다 SG 재배포 불필요(범위 개방).

### Negative
- path 보존이라 앱이 base-path-aware 여야 함(절대 redirect/cookie Path=//websocket URL 은 spec §8.1 한계).
- SG 범위개방 blast-radius 는 NginxSg-only source 로 봉쇄(accepted risk).
- 검증된 route 만 nginx 가 프록시 — network 격리는 SG, 경로 통제는 app-layer.

## References
- [ADR-009](ADR-009-devenv-multi-port-routing.md) (Multi-Port Routing), [ADR-002](ADR-002-nlb-nginx-routing.md) (NLB+Nginx)
- spec: `docs/superpowers/specs/2026-06-09-devenv-custom-port-exposure-design.md`
- 보안리뷰: `docs/reviews/domain-port-review-2026-06-09.md` (B-H1, B-H3)
- consensus: co-agent codex+gemini 2회차
