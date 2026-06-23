---
status: Accepted
verification_required: false
date: 2026-06-23
consolidates: [ADR-002, ADR-009, ADR-016, ADR-027, ADR-013]
---

# 003: 접근 토폴로지·라우팅 (2 CloudFront · NLB+nginx · code-server 8080 · custom 포트)

## Status / 상태
Accepted (2026-06-23). BASELINE §3 row 003. SSOT = `docs/architecture.md`.

## Context / 배경

**KR.** 플랫폼은 두 표면을 노출한다: per-user EC2 DevEnv(브라우저 IDE·앱·API)와 Dashboard.
초기 ALB Listener Rule 방식은 리스너당 100 규칙 제한으로 1000명 동시 접속을 못 받았고,
DevEnv는 단일 포트(code-server)만 노출 가능했으며, 두 표면을 단일 CloudFront로 묶자
ACM wildcard 깊이 제약과 stack 강결합이 생겼다. 라우팅·인증·포트 노출을 한 결정으로 통합한다.

**EN.** The platform exposes two surfaces — per-user EC2 DevEnv (browser IDE, app, API) and the
Dashboard. ALB listener rules capped at 100/listener (no 1000-user scale), DevEnv could expose only
one port (code-server), and a single shared CloudFront introduced ACM wildcard-depth and stack-coupling
problems. This ADR consolidates routing, edge auth, and port exposure into one decision.

## Decision / 결정

### 1. 접근 토폴로지 — 2 CloudFront (concern별 분리)

```
User Browser → CloudFront (devenv)    → NLB (TCP 80) → nginx (ECS Fargate ×2) → per-user EC2 DevEnv
User Browser → CloudFront (dashboard) → ALB → Dashboard (ECS Ec2Service)
```

- **CloudFront 2개**: `*.dev.{domain}` (DevEnv, origin=NLB) 와 `{dashboard}.{domain}` (Dashboard, origin=ALB).
  cert·캐시·WAF·배포를 도메인 단위로 격리. (016, supersedes 단일-CF 013)
- **DevEnv 경로 = NLB(TCP passthrough) + nginx(ECS Fargate)**. nginx 가 Host 헤더 기반으로
  per-user 컨테이너에 라우팅. ALB 100-rule 제한 회피, WebSocket 안정, 고정 IP(폐쇄망), 즉시 reload. (002)
- **CloudFront → 백엔드 보안**: Prefix List + `X-Custom-Secret` 헤더 (CLAUDE.md 규약).

### 2. 엣지 인증 (as-built, by surface)

- **DevEnv CF**: `viewer-request` Lambda@Edge `session-validator` 가 NextAuth JWE 쿠키를 복호화하여
  subdomain 소유권을 검증 (per-user nginx origin 에 app-layer 세션 없음).
  > 명시(004 cross-ref): 이 `session-validator`(NextAuth JWE)가 **현행 `*.dev` 엣지 인증**으로 **유지**된다.
  > ADR-004가 "Lambda@Edge 인증 람다 제거"라 한 것은 **레거시 HMAC 모델(ADR-012의 DevEnv 전용 클라이언트+HMAC 쿠키)** 한정이며, 엣지 인증 자체를 없앤 게 아니다.
- **Dashboard CF**: 엣지 함수 없음 — Dashboard 의 NextAuth 미들웨어가 매 요청 세션 집행.
- **SSO 효과는 쿠키 도메인 `.{domain}` 으로 달성** — distribution 이 둘이어도 양쪽이 같은 세션을 본다.
  이로써 013 이 노린 "단일 로그인"은 유지하되 단일-CF 의 부작용(cert 깊이·stack 결합)은 제거. (016 Addendum)

### 3. code-server `?folder=` + 멀티포트 라우팅

단일 서브도메인에서 nginx 가 path/query 로 분기:

```
{sub}.dev.{domain}/?folder=/home/coder   → 8080 (code-server IDE, RESERVED)
{sub}.dev.{domain}/api/...               → user API
{sub}.dev.{domain}/                      → user Frontend
```

- **8080 = 예약 포트(code-server)** — root path 유지(base-path 변경 시 WebSocket/asset 파손)를 위해
  `?folder=` query 로 code-server 를 식별. code-server 내부 경로(`_static`, `stable-`, webview 등)도 8080. (009)
- nginx config 는 DynamoDB Stream → `nginx-config-gen.py` → S3 → `reload.sh` (5s 폴링 hot-reload) 로 동적 생성.

### 4. 사용자 커스텀 포트 노출 (009 확장)

사용자가 `{label, path, port}` 매핑을 **최대 5개** 등록 → nginx path 라우팅. CloudFront/NLB/Lambda@Edge 변경 0. (027)

- **예약 포트 = [8080]**; 3000/8000 은 seed default(편집·삭제 가능)로 강등. **custom 포트는 8080·기타 well-known 사용 금지.**
- **path 보존(preserve)** — `proxy_pass` URI 미지정, 앱이 base-path-aware 여야 함(redirect/cookie/ws URL 한계는 spec §8.1).
- 루트 `/` 1개·multi-segment(`/api/v1`) 허용. **세그먼트 경계 매칭**(`location = /p` + `^~ /p/`)으로 `/preview`가 `/preview-evil`을 가로채지 않음.
- 저장: `cc-user-instances`(SoT, `routesVersion` 조건부쓰기) → `cc-routing-table` 미러(version guard) → Stream → config-gen → S3 → reload.
- **EC2 SG**(Stack 04 attach 경로): ingress source = NginxSg(SG chaining), port 1024-65535. NginxSg-only source 가 봉쇄선(accepted risk). config-gen 이 subdomain·container_ip 까지 보간 전 재검증, 불일치 행 skip + `routeStatus` 기록(B-H1).

## Consequences / 결과

### Positive
- 1000명+ 동시 접속(nginx config 무제한 규칙), WebSocket 안정, 고정 IP.
- DevEnv IDE·앱·API·custom 포트를 동일 도메인에서 접근 (CORS 무이슈), CF/LB 무변경 확장.
- cert·WAF·배포가 도메인 단위로 격리되고, stack 04↔05 결합 해제로 `governanceOnly` 가 실제 EC2/ECS 를 skip.
- 단일 로그인(쿠키 도메인) 유지, 엣지 함수는 DevEnv CF 에만(전파 표면 축소).

### Negative
- CloudFront distribution 2개 — 지표/대시보드 분산(빌링은 종량제라 차이 거의 0).
- code-server 내부 경로 식별이 code-server 업데이트에 취약.
- path 보존이라 앱이 base-path-aware 여야 함; 미실행 포트는 nginx 502(안내 페이지로 완화).
- nginx SPOF 회피 위해 ≥2 Task 다중화 필수.

## Consolidates / 통합 출처

이 ADR 은 아래 5개 레거시 결정을 대체한다. 본문은 트리에 없고 git tag `adr-legacy-2026-06-23` 로 보존,
매핑은 `docs/history/ADR-MAPPING.md`.

| Legacy | 주제 | 본 ADR 반영 |
|---|---|---|
| ADR-002 | NLB + nginx 동적 라우팅 (ALB 100-rule 회피) | §Decision 1 |
| ADR-009 | DevEnv 멀티포트 라우팅 (code-server 8080 `?folder=` + 3000/8000) | §Decision 3 |
| ADR-016 | concern별 2 CloudFront 분리 (+ as-built 엣지 인증) — supersedes 013 | §Decision 1·2 |
| ADR-027 | 사용자 커스텀 포트 노출 (009 확장, 최대 5개, 세그먼트 경계) | §Decision 4 |
| ~~ADR-013~~ | 단일 CloudFront + 단일 인증 (016 이 supersede) | 폐기 — SSO 효과는 쿠키 도메인으로 유지 (§Decision 2) |

## References
- SSOT: `docs/architecture.md` (§Path/port routing, 2-CloudFront topology)
- spec: `docs/superpowers/specs/2026-06-09-devenv-custom-port-exposure-design.md`
- 보안리뷰: `docs/reviews/domain-port-review-2026-06-09.md` (B-H1, B-H3)
- 구현: `terraform/modules/ecs-devenv/`, `terraform/modules/dashboard/`, `lambda/nginx-config-gen.py`, `lambda/devenv-session-validator/`, `docker/nginx/reload.sh`
