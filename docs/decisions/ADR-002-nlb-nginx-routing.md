# ADR-002: ALB에서 NLB + Nginx 동적 라우팅으로 전환

## Status
Accepted (2026-04-01)

## Context
현재 ALB Listener Rule 방식은 사용자별 1개 규칙 필요.
AWS ALB는 리스너당 최대 100개 규칙 제한 → 100명 이상 동시 접속 불가.
Enterprise에서 1000명 동시 접속 지원 필요.

## Decision
NLB (TCP passthrough) + Nginx (ECS Service)로 전환.
Nginx가 Host 헤더 기반으로 사용자 컨테이너에 라우팅.

## Rationale
| 항목 | ALB | NLB + Nginx |
|------|-----|-------------|
| 규칙 수 제한 | 100/리스너 | 무제한 (Nginx config) |
| WebSocket | 지원 (타임아웃 이슈) | TCP passthrough로 안정적 |
| 고정 IP | 불가 | 가능 (폐쇄망 방화벽에 유리) |
| TLS 종료 | ALB | Nginx (ACM 인증서) |
| 비용 | LCU 과금 | NLB 저렴 + Nginx ECS 비용 |
| Config 변경 | API 호출 (느림) | nginx -s reload (즉시) |

## Consequences
- 1000명+ 동시 접속 가능
- Nginx ECS Service 관리 오버헤드 추가
- DynamoDB Stream + Lambda로 config 동적 생성 필요
- Nginx 장애 시 전체 라우팅 중단 → 2-3 Task 다중화 필수

## Implementation

전 구성요소 구현 완료.

| 구성요소 | 구현 위치 |
|---------|---------|
| NLB (TCP passthrough) | `cdk/lib/04-ecs-devenv-stack.ts` — internet-facing, CloudFront prefix list 제한 |
| Nginx ECS Fargate Service | 동일 파일 — 2 replicas, ARM64, Host 헤더 기반 라우팅 |
| DynamoDB `cc-routing-table` | 동일 파일 — DynamoDB Streams (NEW_AND_OLD_IMAGES) |
| Lambda `nginx-config-gen` | `cdk/lib/lambda/nginx-config-gen.py` — Stream 트리거, S3에 nginx.conf 업로드 |
| Per-user 3-port routing | Nginx upstream: code-server(8080), frontend(3000), API(8000) |

### 라우팅 경로
```
Browser → CloudFront (*.dev.domain) → Lambda@Edge (Cognito auth) → NLB (TCP 80) → Nginx (Fargate ×2) → EC2 user instance
```

Dashboard ALB는 별도 서비스로 `05-dashboard-stack.ts`에서 관리 (본 ADR scope 외).
