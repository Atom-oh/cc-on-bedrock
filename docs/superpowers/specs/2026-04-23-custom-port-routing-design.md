# Custom Port Routing Design — User-Defined Path/Port Mappings

**Date:** 2026-04-23
**Status:** Approved (pending implementation)
**Related ADR:** [ADR-009 DevEnv Multi-Port Routing](../../decisions/ADR-009-devenv-multi-port-routing.md)

## Overview

ADR-009의 향후 확장 항목인 **사용자 커스텀 포트 라우팅**을 구현한다. 현재 nginx-config-gen Lambda는 모든 사용자에게 고정 3포트(8080 code-server / 3000 frontend / 8000 API) upstream을 생성한다. 본 설계는 사용자가 Settings UI에서 추가 path/port 매핑을 등록하면 동일 파이프라인(DDB Stream → Lambda → S3 → Nginx)을 통해 nginx conf가 동적으로 확장되도록 한다.

## Context

### 현재 동작
- `cc-routing-table` DynamoDB 테이블에 `{ subdomain, container_ip, port, status }` 저장
- 인스턴스 시작 시 `registerRoute(subdomain, privateIp)`가 PutItem
- DDB Stream → `nginx-config-gen` Lambda → 모든 active route를 스캔하여 nginx.conf 생성 → S3 업로드
- Nginx Fargate(ECS)가 S3를 5초 polling, 변경 감지 시 hot-reload

### 현재 한계
사용자가 EC2에서 5173(Vite), 3001(Grafana), 4200(Angular) 같은 포트로 서비스를 띄워도 외부에서 접근할 방법이 없다. 3000/8000을 사용하지 않는 프레임워크/도구는 모두 차단된다.

### 목표
사용자가 Settings 탭에서 `[{ path: "/preview", port: 5173, label: "Vite" }]` 형태로 path-port 매핑을 추가하면, 1분 이내에 `https://{subdomain}.dev.{domain}/preview` 로 접근 가능해야 한다.

## Decision

`cc-routing-table` 레코드에 `custom_routes` JSON 필드를 추가하고, `nginx-config-gen` Lambda가 이를 읽어 추가 upstream + location 블록을 생성한다. Settings UI에서 PUT API를 통해 해당 필드를 업데이트하면 DDB Stream이 자동으로 nginx reload 파이프라인을 트리거한다.

## Architecture

### 1. 데이터 모델

`cc-routing-table` 스키마 확장:

```json
{
  "subdomain": "alice",
  "container_ip": "10.0.1.50",
  "port": 8080,
  "status": "active",
  "registered_at": "2026-04-23T...",
  "custom_routes": [
    { "path": "/preview", "port": 5173, "label": "Vite" },
    { "path": "/grafana", "port": 3001, "label": "Grafana" }
  ]
}
```

**검증 규칙 (API 레이어에서 강제):**

| 항목 | 규칙 |
|------|------|
| `path` | `^/[a-z0-9][a-z0-9\-]*$` (소문자+숫자+하이픈), `/`로 시작, 32자 이하 |
| 예약 경로 | `/api`, `/_static`, `/healthz`, `/stable-*`, `/vscode-remote-resource`, `/out`, `/webview` 금지 |
| `port` | 1024 ≤ port ≤ 65535, 기본 3포트(8080/3000/8000) 중복 금지 |
| `label` | 1~32자, 표시 전용 |
| 중복 | 동일 path 또는 동일 port 중복 금지 |
| DLP별 최대 개수 | open=10, restricted=3, locked=0 (비활성) |

### 2. nginx-config-gen Lambda 변경

`cdk/lib/lambda/nginx-config-gen.py`에 다음을 추가:

```python
CUSTOM_UPSTREAM_TEMPLATE = """    upstream custom_{subdomain}_{port} {{
        server {container_ip}:{port} max_fails=3 fail_timeout=5s;
        keepalive 16;
    }}
"""

CUSTOM_LOCATION_TEMPLATE = """        # Custom route: {label} ({path} -> port {port})
        location {path} {{
            proxy_pass http://custom_{subdomain}_{port};
            proxy_http_version 1.1;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection $connection_upgrade;
            proxy_connect_timeout 10s;
            proxy_send_timeout 3600s;
            proxy_read_timeout 3600s;
            proxy_intercept_errors on;
            error_page 502 503 504 = @noservice_custom_{port};
        }}

        location @noservice_custom_{port} {{
            default_type application/json;
            return 502 '{{"error":"Service not running on port {port}","hint":"Start your service on port {port} inside the DevEnv"}}';
        }}
"""
```

**생성 로직 변경:**
1. `generate_nginx_config()`에서 routing table scan 시 `item.get("custom_routes", [])`도 함께 읽음
2. 사용자별 처리:
   - **upstream entries**: 기본 3개(`codeserver_*`, `frontend_*`, `userapi_*`) + 각 커스텀 라우트마다 `custom_{subdomain}_{port}` 추가
   - **server entries**: SERVER_TEMPLATE 내 `location /` **앞**에 커스텀 location 블록들 삽입
3. `custom_routes`가 없거나 빈 배열이면 기존 동작과 동일 (하위 호환)

**Lambda 책임 경계:**
- 검증은 API 레이어에서만 수행. Lambda는 routing table 값을 신뢰하고 그대로 렌더링
- DBoT(Defense-in-depth)을 위해 Lambda에서 path 정규식 한 번 더 체크 (regex unmatch 시 해당 라우트만 skip + warn log)

### 3. Settings UI + API

#### API: `/api/user/custom-routes/route.ts`

**GET** — 현재 커스텀 라우트 조회
```typescript
// Response
{
  success: true,
  data: {
    routes: [{ path: "/preview", port: 5173, label: "Vite" }],
    maxAllowed: 10,
    reservedPaths: ["/api", "/_static", ...],
    reservedPorts: [8080, 3000, 8000]
  }
}
```

**PUT** — 전체 라우트 목록 교체
```typescript
// Request
{ routes: [{ path: "/preview", port: 5173, label: "Vite" }] }

// Response
{ success: true, data: { routes: [...], updatedAt: "..." } }

// Error (DLP locked)
{ success: false, error: "Custom routes are disabled for locked security policy" } // 403

// Error (검증 실패)
{ success: false, error: "Reserved path /api is not allowed" } // 400
```

**처리 흐름:**
1. NextAuth 세션에서 `subdomain` + `securityPolicy` 추출
2. DLP 정책 검증:
   - `locked` → 403 즉시 반환
   - `restricted` → 최대 3개 제한
   - `open` → 최대 10개 제한
3. 각 라우트 검증 (path 정규식, 예약 경로, 포트 범위, 중복)
4. `UpdateItemCommand`로 `custom_routes` 필드만 갱신 (다른 필드 보존):
   ```typescript
   UpdateExpression: "SET custom_routes = :routes, custom_routes_updated_at = :ts"
   ```
5. DDB Stream이 자동으로 `nginx-config-gen` Lambda 트리거 → nginx reload

#### Settings UI (`settings-tab.tsx` 확장)

기존 비밀번호 관리 섹션 아래에 "Custom Port Routes" 카드 추가:

```
┌─ Custom Port Routes ────────────────────────────────────┐
│ Map additional paths to ports running in your DevEnv.   │
│                                                          │
│ [open] 3 of 10 routes used                              │
│                                                          │
│ ┌──────────────┬──────┬──────────┬────────┐             │
│ │ Path         │ Port │ Label    │        │             │
│ ├──────────────┼──────┼──────────┼────────┤             │
│ │ /preview     │ 5173 │ Vite     │ [Del]  │             │
│ │ /grafana     │ 3001 │ Grafana  │ [Del]  │             │
│ └──────────────┴──────┴──────────┴────────┘             │
│                                                          │
│ [ + Add Route ]   [ Save Changes ]                       │
│                                                          │
│ Reserved paths: /api, /_static, /healthz, ...           │
│ Reserved ports: 8080, 3000, 8000                        │
└──────────────────────────────────────────────────────────┘
```

**상태 관리:**
- DLP `locked` 사용자: 섹션 전체 비활성 + 안내 메시지 ("Custom routes are disabled for your security policy")
- DLP `restricted` 사용자: "3 of 3 routes used" 표시, 추가 버튼 비활성화
- DLP `open` 사용자: "X of 10 routes used"
- 저장 후 토스트 알림: "Routes saved. Changes apply within 60 seconds."

**Add Route 인라인 입력:**
- path 입력 시 자동으로 `/` prefix 추가 (사용자 편의)
- port 입력 시 1024~65535 범위 검증
- 예약 경로/포트 사용 시 빨간색 에러 메시지

#### Environment Tab 연동 (`environment-tab.tsx`)

기존 IDE/WEB/API 카드 아래에 동적 카드 추가:

```
[IDE]  https://alice.dev.atomai.click/?folder=...   (port 8080)
[WEB]  https://alice.dev.atomai.click/              (port 3000)
[API]  https://alice.dev.atomai.click/api/          (port 8000)

────── Custom Routes ──────
[Vite]    https://alice.dev.atomai.click/preview    (port 5173)
[Grafana] https://alice.dev.atomai.click/grafana    (port 3001)
```

- `container` 객체에 `customRoutes` 필드 포함시켜 전달
- `/api/user/container/route.ts`에서 routing table read 시 `custom_routes` 포함

### 4. Security Group 변경

`cdk/lib/07-ec2-devenv-stack.ts` 수정:

```typescript
// 기존
const devenvPorts = [
  { port: 8080, desc: 'code-server' },
  { port: 3000, desc: 'frontend dev server' },
  { port: 8000, desc: 'API server' },
];

// 추가: 고포트 범위 (custom routes용)
const customPortRange = { startPort: 1024, endPort: 65535, desc: 'custom route ports' };
```

**DLP별 적용:**
- **DevenvSgOpen**: 기본 3포트 + 1024-65535 범위 (VPC CIDR에서만)
- **DevenvSgRestricted**: 기본 3포트 + 1024-65535 범위 (VPC CIDR에서만)
- **DevenvSgLocked**: 기본 3포트만 (커스텀 라우트 비활성이므로 추가 불필요)

```typescript
this.sgOpen.addIngressRule(
  ec2.Peer.ipv4(config.vpcCidr),
  ec2.Port.tcpRange(customPortRange.startPort, customPortRange.endPort),
  customPortRange.desc
);
// sgRestricted 동일
// sgLocked는 추가하지 않음
```

**보안 분석:**
- 고포트 범위 1024-65535는 VPC CIDR에서만 접근 가능 (외부 노출 없음)
- 실제 외부 노출은 Nginx Fargate가 routing table의 `custom_routes`에 등록된 path만 프록시
- 사용자가 nginx에 등록하지 않은 포트에서 서비스를 띄워도 외부에서 접근 불가
- DLP `locked` 사용자는 SG 레벨에서도 추가 포트 차단

### 5. End-to-End 데이터 흐름

```
[1] User opens Settings tab in Dashboard
    → GET /api/user/custom-routes
    → Render existing routes + reserved paths/ports

[2] User adds "/preview -> 5173" and clicks Save
    → PUT /api/user/custom-routes
       body: { routes: [{ path: "/preview", port: 5173, label: "Vite" }] }

[3] API validates (DLP, paths, ports, duplicates)
    → DynamoDB UpdateItem on cc-routing-table[alice]
       SET custom_routes = [...], custom_routes_updated_at = "..."

[4] DDB Stream emits MODIFY event
    → nginx-config-gen Lambda invoked

[5] Lambda scans cc-routing-table
    → For each active route:
       - Generate base 3 upstreams (codeserver/frontend/userapi)
       - Generate N custom upstreams (custom_alice_5173, ...)
       - Generate server block with base locations + custom locations
    → PutObject to s3://userdata-bucket/nginx/nginx.conf

[6] Nginx Fargate (5s S3 polling) detects new conf
    → Hot reload (nginx -s reload)

[7] User opens https://alice.dev.atomai.click/preview
    → CloudFront -> NLB -> Nginx
    → location /preview { proxy_pass http://custom_alice_5173 }
    → EC2:5173
```

**예상 latency:** PUT API 응답(~200ms) + DDB Stream(~1s) + Lambda 실행(~2s) + S3 upload(~500ms) + Nginx polling(최대 5s) = **약 9초 이내** 반영

### 6. 에러 핸들링

| 상황 | 동작 |
|------|------|
| 커스텀 포트에 서비스 미실행 | Nginx 502 → JSON 안내 메시지 (커스텀 named location) |
| 예약 경로 입력 | API 400 + UI 인라인 에러 |
| DLP locked이 시도 | API 403 + UI 섹션 비활성 |
| restricted 4개째 추가 | API 400 "Maximum 3 custom routes for restricted policy" |
| 동일 path/port 중복 | API 400 |
| Lambda 실패 | 기존 DLQ + retry 3회 (04-ecs-devenv-stack.ts) |
| 인스턴스 Stop → Start | `registerRoute()`는 base 필드만 UpdateItem (SET 식이므로 `custom_routes` 보존) |
| Routing record 삭제 (사용자 terminate) | `custom_routes`도 자동 삭제 |

### 7. 하위 호환성

- 기존 routing record에 `custom_routes` 필드 없음 → Lambda는 `item.get("custom_routes", [])`로 빈 배열 처리
- Lambda 배포 직후: 기존 사용자의 nginx conf는 routing table 변경 시점에 재생성됨
- 강제 재생성 필요 시: 임시 record를 PutItem → DeleteItem으로 트리거

## Components Affected

| 컴포넌트 | 변경 내용 | 파일 |
|---------|----------|------|
| **Lambda** | custom_routes 처리 | `cdk/lib/lambda/nginx-config-gen.py` |
| **CDK SG** | 고포트 범위 허용 (open/restricted) | `cdk/lib/07-ec2-devenv-stack.ts` |
| **API** | GET/PUT custom-routes | `shared/nextjs-app/src/app/api/user/custom-routes/route.ts` (신규) |
| **Container API** | response에 customRoutes 포함 | `shared/nextjs-app/src/app/api/user/container/route.ts` |
| **Routing client** | `getCustomRoutes()`, `setCustomRoutes()` | `shared/nextjs-app/src/lib/ec2-clients.ts` 또는 `aws-clients.ts` |
| **Settings UI** | Custom Routes 섹션 | `shared/nextjs-app/src/components/user/settings-tab.tsx` |
| **Environment UI** | Custom Routes 카드 표시 | `shared/nextjs-app/src/components/user/environment-tab.tsx` |
| **Types** | `CustomRoute`, `ContainerInfo.customRoutes` | `shared/nextjs-app/src/lib/types.ts` |
| **Validation** | path/port 검증 유틸 | `shared/nextjs-app/src/lib/validation.ts` |

## Testing Strategy

### Unit Tests (vitest)
- `validation.ts`: path 정규식, 예약 경로 매칭, 포트 범위
- API route: DLP별 제한, 중복 체크, 검증 실패 케이스
- Lambda: `custom_routes` 빈 배열, 정상 케이스, 잘못된 path skip

### Integration Tests
- PUT API → DynamoDB UpdateItem → Lambda 호출 확인 (LocalStack 또는 dev account)
- nginx.conf 생성 결과 검증 (snapshot test)

### E2E Tests
- 새 라우트 추가 → 60초 대기 → curl `/preview` → EC2 응답 확인 (`tests/integration/test-e2e.sh` 확장)
- DLP locked 사용자 시도 → 403 확인
- 예약 경로 시도 → 400 + UI 에러 확인

## Migration

- 기존 사용자: 변경 불필요 (custom_routes 없으면 기존 동작)
- Lambda 배포 → SG 변경 → API/UI 배포 순서
- Rollback: Lambda를 이전 버전으로 되돌리면 `custom_routes` 필드가 있어도 무시됨

## Consequences

### Positive
- 개발자가 임의 포트(Vite 5173, Storybook 6006, Grafana 3001 등)로 띄운 서비스를 외부에서 즉시 접근 가능
- DLP 정책과 자연스럽게 통합 (locked는 완전 차단, restricted는 제한)
- 기존 파이프라인(DDB Stream → Lambda → S3 → Nginx) 100% 재사용 — 새 인프라 불필요
- 검증을 API 레이어에 집중하여 Lambda를 단순하게 유지

### Negative
- SG 고포트 범위 허용으로 VPC 내 공격 표면 증가 (단, VPC CIDR 한정 + Nginx 프록시 경유)
- 동일 SG를 모든 같은 DLP tier 사용자가 공유하므로 사용자별 포트 제한 불가 (Nginx 레이어에서만 통제)
- 사용자가 잘못된 path를 등록하면 본인 환경 접근이 깨질 수 있음 (path 충돌 검증으로 완화)
- 커스텀 라우트가 많을수록 nginx.conf 크기 증가 (4,000 사용자 × 10 routes = 40,000 location 블록 → 메모리/reload 시간 영향)

### Future Work
- nginx.conf 크기가 문제되면 사용자별 분리 conf + `include` 디렉티브
- WebSocket-only 라우트 옵션 (현재는 항상 Upgrade 헤더 전달)
- Admin이 부서 단위 reserved paths 추가 가능 (admin override)
- 사용자가 비공개 라우트 설정 (basic auth, IP 화이트리스트)

## References

- [ADR-009: DevEnv Multi-Port Routing](../../decisions/ADR-009-devenv-multi-port-routing.md)
- [ADR-005: Security Policy & Access Control](../../decisions/ADR-005-security-policy-access-control.md) — DLP 3-tier 통합
- `cdk/lib/lambda/nginx-config-gen.py` — 현재 nginx config generator
- `cdk/lib/04-ecs-devenv-stack.ts` — Nginx Fargate + DDB Stream → Lambda 연결
- `cdk/lib/07-ec2-devenv-stack.ts` — DevEnv Security Groups
