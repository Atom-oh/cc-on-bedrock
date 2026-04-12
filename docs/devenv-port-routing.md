# DevEnv Port Routing Guide

CC-on-Bedrock 개발 환경에서 code-server IDE, Frontend 웹앱, API 서버를 외부에서 접근하는 방법.

## Port Convention

| Port | Service | URL Pattern | Description |
|------|---------|-------------|-------------|
| **8080** | code-server | `https://{subdomain}.dev.atomai.click/?folder=/home/coder` | IDE (VS Code in browser) |
| **3000** | Frontend | `https://{subdomain}.dev.atomai.click/` | Next.js, React, Vue 등 dev server |
| **8000** | API | `https://{subdomain}.dev.atomai.click/api/...` | FastAPI, Express, Django 등 |

이 3개 포트만 외부에서 접근 가능합니다. 다른 포트는 보안 그룹에 의해 차단됩니다.

## Routing Rules

```
Browser Request
  │
  ├── ?folder=... 있음  ──────────→  port 8080 (code-server IDE)
  │
  ├── /api/...          ──────────→  port 8000 (API server)
  │
  ├── /_static/...      ──────────→  port 8080 (code-server internal)
  │   /stable-*/...
  │   /vscode-remote-resource/...
  │   /out/...
  │   /webview/...
  │   /healthz
  │
  └── / (나머지 전부)   ──────────→  port 3000 (Frontend dev server)
```

### Priority (우선순위)

1. code-server 내부 경로 (`/_static/`, `/stable-*/`, `/vscode-remote-resource/`, `/out/`, `/webview/`, `/healthz`) → port 8080
2. `?folder=` query parameter → port 8080 (code-server IDE)
3. `/api/` prefix → port 8000 (API server)
4. 기타 모든 요청 → port 3000 (Frontend)

## Quick Start

### 1. code-server IDE 접속

Dashboard에서 "Open IDE" 버튼을 클릭하거나 직접 접속:

```
https://admin.dev.atomai.click/?folder=/home/coder
```

특정 프로젝트 폴더를 열려면:

```
https://admin.dev.atomai.click/?folder=/home/coder/my-project
```

### 2. Frontend Dev Server 실행

code-server 터미널에서:

```bash
# Next.js
cd ~/my-nextjs-app
npm run dev -- --port 3000

# React (CRA)
PORT=3000 npm start

# Vue
npm run dev -- --port 3000

# Vite
npx vite --port 3000 --host 0.0.0.0
```

브라우저에서 확인:

```
https://admin.dev.atomai.click/
```

**중요:** `--host 0.0.0.0` 또는 `--host` 옵션을 추가해야 외부에서 접근 가능합니다. localhost(127.0.0.1)에만 바인딩하면 Nginx에서 연결할 수 없습니다.

### 3. API Server 실행

```bash
# FastAPI
cd ~/my-api
uvicorn main:app --host 0.0.0.0 --port 8000

# Express.js
PORT=8000 node server.js

# Django
python manage.py runserver 0.0.0.0:8000

# Flask
flask run --host 0.0.0.0 --port 8000
```

브라우저/curl에서 확인:

```bash
curl https://admin.dev.atomai.click/api/health
```

### 4. Frontend + API 동시 사용

Frontend에서 API를 호출할 때 동일 도메인이므로 CORS 설정이 불필요합니다:

```javascript
// Frontend code (React/Next.js)
const res = await fetch('/api/users');
const data = await res.json();
```

## Architecture

```
Browser
  │
  │ HTTPS (TLS terminated at CloudFront)
  ▼
CloudFront (*.dev.atomai.click)
  │
  │ Lambda@Edge: Cognito OAuth 인증
  │              X-Auth-User: {subdomain} 주입
  ▼
NLB (TCP 80, CloudFront prefix list only)
  │
  ▼
Nginx (ECS Fargate, 2 replicas)
  │
  │ Host-based routing: {subdomain}.dev.atomai.click
  │ Security: X-Custom-Secret + X-Auth-User 검증
  │
  ├── ?folder= or code-server paths → upstream codeserver_{subdomain} → EC2:8080
  ├── /api/                         → upstream userapi_{subdomain}    → EC2:8000
  └── / (default)                   → upstream frontend_{subdomain}   → EC2:3000
```

## Fallback Behavior

| Situation | Response |
|-----------|----------|
| port 3000에 서비스 없음 | 안내 페이지: "Frontend server is not running. Start on port 3000." + code-server IDE 링크 |
| port 8000에 서비스 없음 | JSON: `{"error": "API server is not running on port 8000"}` |
| port 8080에 서비스 없음 | Loading 페이지: "code-server is starting" (5초 자동 새로고침) |

서비스를 시작하지 않아도 다른 서비스에 영향을 주지 않습니다. 예를 들어 API 서버 없이 code-server + Frontend만 사용 가능합니다.

## Security

- 모든 요청은 **Cognito OAuth 인증** 필수 (Lambda@Edge)
- 인증된 사용자만 **자신의 subdomain**에 접근 가능 (HMAC cookie + Nginx X-Auth-User 검증)
- 보안 그룹: port 8080, 3000, 8000만 VPC 내부에서 허용 (인터넷 직접 접근 불가)
- DLP 정책(open/restricted/locked)은 **outbound** 규칙에만 영향, inbound 포트는 동일

## Limitations

- **3개 포트만 허용**: 8080(IDE), 3000(Frontend), 8000(API). 다른 포트는 불가
- **`0.0.0.0` 바인딩 필수**: `localhost` 또는 `127.0.0.1` 바인딩은 외부 접근 불가
- **code-server 내부 경로 충돌**: `/_static/`, `/stable-*/` 등은 code-server로 라우팅되므로, Frontend에서 이 경로를 사용하면 안됨
- **`/api/` prefix 고정**: API 서버의 모든 엔드포인트는 `/api/` 아래여야 함. `/api/` 없이 루트에 API를 만들면 Frontend로 라우팅됨
- **HMR WebSocket**: Frontend dev server의 Hot Module Replacement는 WebSocket을 통해 동작. Nginx가 `Upgrade` 헤더를 전달하므로 대부분 정상 동작하지만, Vite의 기본 HMR 포트(24678)는 지원되지 않으므로 `--host 0.0.0.0` 사용 시 같은 포트로 연결되도록 설정 필요
