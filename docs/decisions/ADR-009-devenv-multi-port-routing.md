# ADR-009: DevEnv Multi-Port Routing (code-server + Frontend + API)

## Status
Accepted

## Context

현재 DevEnv 라우팅은 **단일 포트(8080 → code-server)** 만 지원한다:

```
CloudFront (*.dev.atomai.click)
  → Lambda@Edge (Cognito auth, X-Auth-User 주입)
    → NLB (TCP 80)
      → Nginx Fargate (Host-based 라우팅)
        → EC2 Instance port 8080 (code-server)
```

개발자가 EC2 DevEnv에서 프론트엔드 웹앱이나 API 서버를 실행하면, **외부에서 접근할 방법이 없다**:

- `localhost:3000` (Next.js/React dev server) → 브라우저에서 접근 불가
- `localhost:8000` (FastAPI/Express API server) → 프론트엔드에서 호출 불가
- code-server의 포트 포워딩 기능이 있지만, CloudFront → NLB → Nginx 경로에서 해당 포트로 라우팅되지 않음

개발자는 code-server에서 코드를 작성하면서 동시에 자신이 만든 웹앱을 브라우저에서 확인하고, API를 테스트할 수 있어야 한다.

### 현재 아키텍처 파일

| 파일 | 역할 |
|------|------|
| `cdk/lib/04-ecs-devenv-stack.ts` | CloudFront, NLB, Nginx ECS, DynamoDB routing, Lambda@Edge |
| `cdk/lib/lambda/nginx-config-gen.py` | DynamoDB Stream → nginx.conf 생성 → S3 업로드 |
| `cdk/lib/lambda/devenv-auth-edge/index.js` | Cognito OAuth + HMAC cookie + subdomain 검증 |
| `shared/nextjs-app/src/lib/ec2-clients.ts` | EC2 UserData, `registerRoute(subdomain, privateIp)` |
| `docker/nginx/reload.sh` | S3 nginx.conf 폴링 (5초) + hot-reload |

## Options Considered

### Option 1: Query Parameter 기반 라우팅 (Nginx `$arg_` 분기)

URL에 query parameter로 서비스를 구분한다:

```
admin.dev.atomai.click/?folder=/home/coder     → port 8080 (code-server)
admin.dev.atomai.click/?app=frontend            → port 3000 (Next.js dev)
admin.dev.atomai.click/api/...                  → port 8000 (API server)
admin.dev.atomai.click/                         → port 3000 (default: frontend)
```

code-server는 `?folder=` query parameter를 인식하여 특정 폴더를 열어준다. 이 패턴을 활용하면 `?folder=`가 있으면 code-server, 없으면 프론트엔드로 라우팅할 수 있다.

**Nginx location 우선순위:**
```nginx
# 1순위: ?folder= 포함 → code-server (8080)
# 2순위: /api/ 경로 → API server (8000)
# 3순위: 나머지 → Frontend (3000)
```

- **Pros**:
  - 단일 도메인으로 모든 서비스 접근 가능
  - CloudFront/NLB 변경 불필요 (Nginx 분기만 추가)
  - code-server의 기존 `?folder=` 규약과 자연스럽게 호환
  - Dashboard에서 `admin.dev.atomai.click/?folder=/home/coder` 형태로 URL 전달 가능
  - Lambda@Edge 변경 불필요 (인증은 subdomain 단위)
- **Cons**:
  - code-server 내부 요청에도 `?folder=`가 없으면 잘못 라우팅될 수 있음
  - code-server의 WebSocket/asset 요청 식별이 필요
  - 포트 번호가 3000/8000으로 고정 (사용자 커스터마이징 제한)

### Option 2: Path Prefix 기반 라우팅

```
admin.dev.atomai.click/code/...     → port 8080 (code-server, strip /code)
admin.dev.atomai.click/api/...      → port 8000 (API server)
admin.dev.atomai.click/...          → port 3000 (Frontend)
```

- **Pros**:
  - 명확한 URL 구조
  - Nginx location 블록으로 깔끔하게 구현
- **Cons**:
  - code-server는 root path(`/`)에서 실행되어야 정상 동작 — `/code` prefix를 붙이면 WebSocket, asset 경로가 깨짐
  - code-server `--base-path` 옵션이 있지만 불안정하고 플러그인 호환성 이슈
  - 기존 `?folder=` URL 패턴과 호환 불가

### Option 3: 서브도메인 분기 (code.admin.dev, app.admin.dev)

```
admin.dev.atomai.click             → port 8080 (code-server)
app-admin.dev.atomai.click         → port 3000 (Frontend)
api-admin.dev.atomai.click         → port 8000 (API)
```

- **Pros**:
  - 완전히 분리된 네임스페이스
  - 각 서비스 독립적으로 동작
- **Cons**:
  - DNS 와일드카드 레벨 제한 (`*.dev.atomai.click`는 1단계만 커버, `code.admin.dev.atomai.click` 불가)
  - `app-admin` 형태는 Nginx server_name 패턴이 복잡해짐
  - CloudFront ACM 인증서 재발급 필요
  - Lambda@Edge 인증 로직 대폭 변경

### Option 4: Hybrid — code-server 특화 라우팅 + Path 분기

code-server 요청을 정확히 식별하고, 나머지를 path로 분기:

```
admin.dev.atomai.click/?folder=...                → port 8080 (code-server)
admin.dev.atomai.click/ (code-server assets)      → port 8080 (code-server 내부 요청)
admin.dev.atomai.click/api/...                     → port 8000 (API server)
admin.dev.atomai.click/app/...                     → port 3000 (Frontend, strip /app)
```

- **Pros**:
  - code-server는 root path 유지 (호환성 최대)
  - API와 Frontend 명확 분리
- **Cons**:
  - code-server asset과 프론트엔드 asset 충돌 가능
  - `/app` prefix가 프론트엔드 프레임워크 설정에 영향 (basePath)
  - 복잡도 높음

## Decision

**Option 1: Query Parameter + Path 혼합 라우팅** 채택 (Option 1 기반, 개선)

### 라우팅 규칙

```
admin.dev.atomai.click/?folder=/home/coder     → port 8080 (code-server IDE)
admin.dev.atomai.click/api/...                  → port 8000 (사용자 API 서버)
admin.dev.atomai.click/                         → port 3000 (사용자 Frontend)
```

### 상세 라우팅 로직

code-server 내부 요청(WebSocket, asset, extensions)을 정확히 식별하기 위해 **code-server 전용 경로 패턴**을 사용한다:

```nginx
server {
    listen 80;
    server_name {subdomain}.{domain};

    # ... auth/proxy headers (기존 동일) ...

    # ─── code-server 라우팅 ───
    # code-server IDE: ?folder= query parameter
    location @codeserver {
        proxy_pass http://codeserver_{subdomain};
    }

    # code-server 전용 경로 (WebSocket, assets, extensions, API)
    location ~ ^/(_static|stable-|vscode-remote-resource|out/|webview/) {
        proxy_pass http://codeserver_{subdomain};
    }
    location /healthz {
        proxy_pass http://codeserver_{subdomain};
    }

    # code-server WebSocket 연결
    location ~ ^/stable-[a-f0-9]+/.*$ {
        proxy_pass http://codeserver_{subdomain};
    }

    # ─── 사용자 API 서버 라우팅 ───
    location /api/ {
        proxy_pass http://userapi_{subdomain};
        # API는 WebSocket 불필요할 수 있으므로 타임아웃 축소
        proxy_connect_timeout 10s;
        proxy_send_timeout 300s;
        proxy_read_timeout 300s;
    }

    # ─── 기본 라우팅: ?folder= → code-server, 나머지 → Frontend ───
    location / {
        # ?folder= parameter가 있으면 code-server로
        if ($arg_folder) {
            error_page 418 = @codeserver;
            return 418;
        }
        # 그 외 → Frontend dev server (3000)
        proxy_pass http://userfrontend_{subdomain};
    }
}
```

### Upstream 구성

```nginx
# code-server (기존)
upstream codeserver_{subdomain} {
    server {container_ip}:8080;
    keepalive 32;
}

# 사용자 Frontend dev server
upstream userfrontend_{subdomain} {
    server {container_ip}:3000;
    keepalive 16;
}

# 사용자 API server
upstream userapi_{subdomain} {
    server {container_ip}:8000;
    keepalive 16;
}
```

### Dashboard에서의 URL 전달

```
code-server IDE:  https://admin.dev.atomai.click/?folder=/home/coder
Frontend 미리보기: https://admin.dev.atomai.click/
API 테스트:       https://admin.dev.atomai.click/api/
```

Dashboard의 `environment-tab.tsx`에서:
- **code-server URL**: `https://{subdomain}.dev.atomai.click/?folder=/home/coder`
- **Preview URL**: `https://{subdomain}.dev.atomai.click/` (Frontend)
- **API URL**: `https://{subdomain}.dev.atomai.click/api/` (API)

### EC2 보안 그룹 변경

현재 security group은 Nginx → EC2 port **8080**만 허용. 추가 필요:

```
NginxSg → EC2 port 3000 (Frontend)
NginxSg → EC2 port 8000 (API)
```

## Architecture

### 라우팅 플로우

```
Browser
  │
  ├── admin.dev.atomai.click/?folder=/home/coder
  │     → CloudFront → Lambda@Edge (auth)
  │       → NLB → Nginx
  │         → location / { if ($arg_folder) → @codeserver }
  │           → upstream codeserver_admin → EC2:8080 (code-server)
  │
  ├── admin.dev.atomai.click/
  │     → CloudFront → Lambda@Edge (auth)
  │       → NLB → Nginx
  │         → location / { proxy_pass userfrontend }
  │           → upstream userfrontend_admin → EC2:3000 (Next.js dev)
  │
  └── admin.dev.atomai.click/api/health
        → CloudFront → Lambda@Edge (auth)
          → NLB → Nginx
            → location /api/ { proxy_pass userapi }
              → upstream userapi_admin → EC2:8000 (FastAPI/Express)
```

### 변경 없는 레이어

| 레이어 | 이유 |
|--------|------|
| **CloudFront** | Origin은 NLB 고정, cache disabled, 모든 요청 통과 |
| **Lambda@Edge** | subdomain 단위 인증, 경로/포트 무관 |
| **NLB** | TCP 80 → Nginx, 변경 없음 |
| **DynamoDB routing table** | `{subdomain, container_ip, port, status}` — port 필드를 배열 또는 멀티 레코드로 확장 가능하나 불필요 (Nginx가 3개 upstream 생성) |

### 변경 필요 레이어

| 레이어 | 변경 내용 |
|--------|-----------|
| **Nginx config gen Lambda** (`nginx-config-gen.py`) | upstream 3개 생성 (8080, 3000, 8000), location 분기 추가 |
| **EC2 보안 그룹** (`07-ec2-devenv-stack.ts`) | port 3000, 8000 inbound 추가 (NginxSg → EC2) |
| **Dashboard UI** (`environment-tab.tsx`) | code-server URL에 `?folder=/home/coder` 포함, Preview/API URL 추가 |

## Port 규약

| Port | 서비스 | 설명 |
|------|--------|------|
| **8080** | code-server | IDE (기존, 변경 없음) |
| **3000** | Frontend dev server | Next.js, React, Vue 등 `npm run dev` |
| **8000** | API server | FastAPI, Express, Django 등 백엔드 |

이 포트 규약은 **convention-over-configuration** — 사용자가 해당 포트에 서비스를 실행하면 자동으로 외부 접근 가능. 서비스를 실행하지 않으면 Nginx가 502를 반환하되, code-server는 항상 가용하므로 `?folder=` URL은 항상 동작.

### Fallback 동작

| 상황 | 동작 |
|------|------|
| port 3000에 서비스 없음 | `/` 접근 시 Nginx 502 → 커스텀 안내 페이지 ("Frontend 서비스를 실행하세요") |
| port 8000에 서비스 없음 | `/api/` 접근 시 Nginx 502 → 커스텀 안내 페이지 ("API 서비스를 실행하세요") |
| port 8080에 서비스 없음 | `?folder=` 접근 시 기존 loading 페이지 (code-server booting) |
| 모든 포트 사용 중 | 모든 경로 정상 라우팅 |

## Consequences

### Positive
- 개발자가 DevEnv에서 만든 웹앱/API를 **외부 브라우저에서 즉시 확인** 가능
- code-server IDE와 앱 미리보기를 **동일 도메인** 에서 접근 (CORS 이슈 없음)
- CloudFront, Lambda@Edge, NLB 변경 없이 **Nginx 레이어만 수정**
- Dashboard에서 `?folder=/home/coder` URL 직접 제공으로 사용자 경험 개선
- 인증/인가는 기존 4-layer defense-in-depth 그대로 적용

### Negative
- **code-server 내부 경로 식별 복잡도** — code-server가 업데이트되면 내부 경로 패턴이 변경될 수 있음
- **포트 번호 고정 (3000, 8000)** — 사용자가 다른 포트를 사용하려면 규약 변경 필요
- **EC2 보안 그룹 확장** — 기존 port 8080만 열려있던 것에서 3000, 8000 추가 (공격 표면 증가, 단 VPC 내부만)
- **Frontend/API가 없을 때 502** — 사용자 혼란 가능 (커스텀 안내 페이지로 완화)
- code-server와 Frontend가 동일 도메인/경로를 공유하므로 **cookie 충돌 가능** (code-server의 인증 cookie vs 사용자 앱 cookie)

## 구현 가이드

### 1. nginx-config-gen.py 변경

`SERVER_TEMPLATE` + `UPSTREAM_TEMPLATE` 수정:

```python
# 3개 upstream per user
UPSTREAM_TEMPLATE = """
    upstream codeserver_{subdomain} {{
        server {container_ip}:8080 max_fails=3 fail_timeout=5s;
        keepalive 32;
    }}
    upstream userfrontend_{subdomain} {{
        server {container_ip}:3000 max_fails=3 fail_timeout=5s;
        keepalive 16;
    }}
    upstream userapi_{subdomain} {{
        server {container_ip}:8000 max_fails=3 fail_timeout=5s;
        keepalive 16;
    }}
"""
```

`SERVER_TEMPLATE` 내 location 블록을 위 Decision 섹션의 라우팅 로직으로 교체.

### 2. EC2 보안 그룹 (`07-ec2-devenv-stack.ts`)

```typescript
// 기존: NginxSg → EC2 port 8080
// 추가:
securityGroup.addIngressRule(nginxSg, ec2.Port.tcp(3000), 'Nginx → Frontend dev server');
securityGroup.addIngressRule(nginxSg, ec2.Port.tcp(8000), 'Nginx → API server');
```

### 3. Dashboard UI (`environment-tab.tsx`)

code-server URL 변경:
```
Before: https://admin.dev.atomai.click/
After:  https://admin.dev.atomai.click/?folder=/home/coder
```

Preview URL 추가:
```
Frontend: https://admin.dev.atomai.click/
API:      https://admin.dev.atomai.click/api/
```

## 향후 확장 가능성

- **사용자 커스텀 포트**: DynamoDB routing table에 `ports` 필드 추가하여 사용자별 포트 매핑 지원
- **포트 자동 감지**: EC2 에이전트가 LISTEN 포트를 감지하여 DynamoDB에 등록, Nginx 자동 설정
- **HMR WebSocket**: Frontend dev server의 Hot Module Replacement WebSocket 지원 (이미 `Upgrade` 헤더 전달로 동작 예상)

## References
- [ADR-002: NLB+Nginx Routing](ADR-002-nlb-nginx-routing.md) — ALB 100 rule 제한 → NLB+Nginx 결정
- [ADR-012: DevEnv Cognito Auth](ADR-012-devenv-cognito-auth.md) — Lambda@Edge + Nginx defense-in-depth
- `cdk/lib/lambda/nginx-config-gen.py` — 현재 Nginx config 생성 로직
- `cdk/lib/04-ecs-devenv-stack.ts` — CloudFront + NLB + Nginx ECS 정의
- code-server docs: `--base-path` 옵션 제한사항
