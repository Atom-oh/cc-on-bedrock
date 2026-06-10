# DevEnv 사용자 커스텀 포트 노출 — 설계 (Spec)

- **작성일**: 2026-06-09
- **상태**: Approved (brainstorming) → writing-plans 대기
- **확장 대상**: ADR-009 (DevEnv Multi-Port Routing) "향후 확장 — 사용자 커스텀 포트"
- **신규 ADR**: ADR-027 (작성 예정)
- **관련 보안 리뷰**: `docs/reviews/domain-port-review-2026-06-09.md` — B-H1(nginx 입력 injection), B-H3(SG ingress = NginxSg)
- **consensus 리뷰 반영**: co-agent 패널(codex+gemini) 2회차. 반영된 항목 — SG chaining/range(§6, accepted-risk), B-H1 subdomain/container_ip 검증(§5.2/§12), prefix 세그먼트 경계(§5), 동기화 version/조건부쓰기(§3), multi-segment path(§4 D9), route 상태 노출(§8.2), path-preserve 한계 명시(§8.1), legacy vpcCidr 제거+test(§6), seed 모순 해소(§11)

---

## 1. 목적 / 문제

현재 DevEnv 라우팅은 단일 서브도메인(`{subdomain}.dev.<domain>`) 안에서 **하드코딩된 3포트 규약**으로 동작한다 (ADR-009):

- `?folder=` + code-server 내부경로 → `:8080` code-server
- `/api/` → `:8000` API
- `/` (그 외) → `:3000` frontend

포트가 코드에 고정(`nginx-config-gen.py`의 `UPSTREAM_TEMPLATE`/`SERVER_TEMPLATE`)되어 있어, 사용자가 다른 포트(예: Vite `5173`, Grafana `3001`, 추가 백엔드)를 외부에서 보려면 규약 자체를 바꿔야 한다.

**목표**: 사용자가 대시보드 설정에서 `{ label, path, port }` 매핑을 직접 등록하면, 동일 서브도메인 안에서 path로 추가 포트가 노출되도록 한다.

**제약 (사용자 요구)**:
- 단일 도메인 기준 — path로만 분기. **CloudFront / NLB / Lambda@Edge 변경 0**.
- nginx 레이어 + EC2 보안그룹만 변경.
- route 최대 **5개**.

---

## 2. 핵심 결정 사항

| # | 결정 | 비고 |
|---|------|------|
| D1 | **예약 포트 = `[8080]`** (code-server만 잠금) | 3000/8000은 예약 해제 → 일반 custom port로 강등. 8080 등록 시도 → 명시적 에러 |
| D2 | route 최대 **5개 고정** (정책 무관) | API에서 강제. validation schema의 hard upper bound는 유지 |
| D3 | **path 보존(preserve)** 방식 | `proxy_pass`에 URI 미지정 → `/preview/assets/...` 가 같은 prefix로 돌아와 SPA 에셋 안 깨짐. 앱이 해당 path 밑에서 서빙되어야 함(base-path-aware). **한계는 §8.1 참조** |
| D9 | **multi-segment path 허용** | `/api/v1`, `/docs/static` 등 다단계 path 가능. regex 확장 + `..` traversal 차단 유지 |
| D4 | **루트 `/` = custom route 하나를 '루트'로 지정** | 최대 1개 route가 `path: "/"`. 그 포트가 루트 소유 |
| D5 | **SG = NginxSg → `1024-65535` 범위 개방** | 설정 변경 시 SG 재배포 불필요. B-H3 수정(ingress source = NginxSg) 선행 전제 |
| D6 | **저장**: `cc-user-instances`(영속 source of truth) → `cc-routing-table` 미러 → Stream이 nginx 재생성 자동 트리거 | nginx-config-gen은 기존처럼 routing-table 1개만 scan |
| D7 | **기본 seed**: `[{"/", 3000, "Frontend"}, {"/api", 8000, "API"}]` | 현재 UX 보존 + 기존 사용자 마이그레이션. 편집·삭제 가능. 5개 중 2개 사용 |
| D8 | **admin users 화면에 노출 포트 목록 표시** | 사용자 추가 요구 |

### 비범위 (YAGNI)
- ❌ 포트 자동감지 (LISTEN 스캐닝) — 수동 등록만
- ❌ prefix strip 모드 / nginx `sub_filter` 응답 재작성 — 보존 방식만
- ❌ 포트별 서브도메인 — 단일 도메인 제약 위반

---

## 3. 데이터 모델

### CustomRoute (`shared/nextjs-app/src/lib/types.ts` — 기존 유지)
```ts
export interface CustomRoute {
  path: string;   // "/" (루트) 또는 "/preview"
  port: number;   // 1024-65535, 8080 제외
  label: string;  // 표시명, 1-32자
}
// ContainerInfo.customRoutes?: CustomRoute[]
```

### 저장 위치
- **Source of truth**: `cc-user-instances` 테이블에 `customRoutes` (List<Map{path,port,label}>) 속성 추가. stop/start 생존.
- **미러**: `cc-routing-table` 행(키: subdomain)에 `customRoutes` 속성 추가. nginx-config-gen이 읽는 곳.
- **동기화 규칙 (race 방지 — consensus #5)**:
  - **`cc-user-instances` 가 단일 source of truth**. `customRoutes` 와 함께 `routesVersion`(증가 정수) 또는 `routesUpdatedAt` 보관.
  - 설정 PUT → 먼저 `cc-user-instances` 를 **조건부 쓰기**(`routesVersion` CAS)로 갱신(동시 PUT lost-update 방지). 성공 시 인스턴스 active면 `cc-routing-table` 행을 patch(같은 version 기록) → DynamoDB Stream → `nginx-config-gen.py` 재생성 → S3 → `reload.sh` 폴링(~5s) hot-reload.
  - **`registerContainerRoute`(부팅 시)는 routing-table을 무조건 덮지 않음**: `cc-user-instances` 의 customRoutes를 읽어 mirror 하되, routing-table 행의 version이 더 최신이면(부팅 중 사용자가 PUT) 덮어쓰지 않음(조건부 PutItem). hot-update 유실 방지.
  - patch 실패 시 사용자에게 에러 노출(silent 아님). user-instances↔routing-table 불일치는 다음 PUT/부팅에서 version으로 수렴.

---

## 4. 검증 (`shared/nextjs-app/src/lib/validation.ts`)

> 기존 스캐폴딩은 구 3-reserved 모델(`RESERVED_PORTS = [8080,3000,8000]`)로 작성되어 있어 **갱신 필요**.

```ts
export const RESERVED_PORTS = [8080] as const;          // code-server만

// code-server 내부경로 + nginx 인프라 경로 (등록 불가). /api 는 제거(seedable).
export const RESERVED_PATHS = [
  "/_static", "/healthz", "/stable-", "/vscode-remote-resource",
  "/out", "/webview", "/manifest.json", "/health", "/nginx-status",
] as const;

export const MAX_CUSTOM_ROUTES = 5;                     // API 강제값

// path: "/" (루트) 또는 multi-segment (D9). 각 세그먼트는 [a-z0-9][a-z0-9-]*,
// 끝 슬래시 없음, 연속 슬래시·`..` traversal 차단.
const ROOT_PATH = "/";
const SUBPATH_REGEX = /^\/[a-z0-9][a-z0-9-]*(\/[a-z0-9][a-z0-9-]*)*$/;
```

규칙:
- `path === "/"` 허용(루트), 그 외 `SUBPATH_REGEX` 매칭(multi-segment 허용, D9). 대문자·끝 슬래시·연속 슬래시(`//`)·`..` traversal·예약 prefix 거부.
- **예약 prefix 판정은 세그먼트 경계 기준**: `path === reserved` 또는 `path.startsWith(reserved + "/")` (예: `/api`는 seedable이라 비예약이지만, `/_static`·`/stable-` 등은 `/_static/x` 도 거부). `/apiary` 가 `/api` 로 오판되지 않게 단순 `startsWith` 금지.
- `port`: int 1024-65535, `8080` 제외. 8080 입력 시 메시지 **"8080은 code-server가 사용 중인 포트입니다 (노출 불가)"**.
- payload refine: 중복 path 거부, 중복 port 거부, **`path === "/"` 최대 1개**, 길이 ≤ 5. 한 path가 다른 path의 prefix이면(`/api`, `/api/v1`) 경고하되 nginx 최장일치로 동작(허용).
- **예약 포트/경로는 조용히 skip하지 않고 명시적 400 에러** + 인라인 UI 에러로 사용자에게 표시.

---

## 5. nginx-config-gen.py (`cdk/lib/lambda/nginx-config-gen.py`) — 보안 핵심

1. routing-table 항목에서 `customRoutes` (DynamoDB List) 읽기.
2. **Python에서 모든 보간 값 재검증** (B-H1 defense-in-depth — consensus #1, 가장 중요):
   - `path`: `/` 또는 §4의 multi-segment regex, 예약 prefix(세그먼트 경계) 제외.
   - `port`: int 1024-65535, ≠8080.
   - **`subdomain`: `^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`** (Cognito `custom:subdomain` 출처 — B-H1 핵심 주입 경로).
   - **`container_ip`: RFC1918 + VPC CIDR 범위 검증** (B-M3) — `ipaddress` 모듈로 파싱, 범위 밖이면 거부.
   - **불일치 행은 skip + `logger.warning` + CloudWatch 메트릭 emit**(silent 아님, §8.2 상태 노출과 연계). 전체 config는 계속 생성.
3. 유효 route별 생성:
   - upstream `custom_{subdomain}_{port}` → `{container_ip}:{port}` (`max_fails`/`keepalive`).
   - **루트 route** (`path == "/"`) → `location / { if ($arg_folder) { error_page 418 = @codeserver; return 418; } proxy_pass http://custom_{subdomain}_{port}; ... }` (기존 production 패턴 재사용, `nginx-config-gen.py:231-240`).
   - **subpath route** — 세그먼트 경계 매칭 (consensus #3, `/preview`가 `/preview-evil` 매칭 방지):
     ```nginx
     location = {path}   { proxy_pass http://custom_{subdomain}_{port}; ...공통 }   # 정확 매칭
     location ^~ {path}/ { proxy_pass http://custom_{subdomain}_{port}; ...공통 }   # 하위 경로
     ```
     공통 블록: WebSocket 헤더(`Upgrade`/`Connection`) + **`proxy_read_timeout`/`proxy_send_timeout` 명시**(consensus gemini — WS 조기종료 방지), path 보존(proxy_pass에 URI 미지정), 502 안내.
4. code-server는 항상 built-in: upstream `codeserver_{subdomain}`(8080) + `?folder=` + 내부경로 location 생성.
5. 루트 route 없을 때: `location / { if ($arg_folder) → @codeserver; default → "프론트엔드 없음" 안내 페이지 }`.

`^~` (non-regex prefix, 우선) 사용으로 code-server 정규식 location이 custom subpath를 가로채지 않도록 한다. 예약 경로가 code-server 내부경로와 겹치지 않게 검증에서 차단되어 충돌 없음. **예약 path 목록은 §4 `RESERVED_PATHS` 단일 출처를 config-gen이 공유**(코드 생성 location과 denylist의 drift 방지 — consensus).

---

## 6. EC2 보안그룹 (`cdk/lib/07-ec2-devenv-stack.ts`)

### 네트워크 홉 구분 (중요)
```
Browser → CloudFront → NLB(TG) ─홉1→ Nginx(Fargate) ─홉2→ EC2(per-user)
                                :80            upstream :8080/3000/8000/커스텀
```
- **홉1 (NLB TG → Nginx)**: Nginx Fargate SG는 `:80`만 수신. 커스텀 포트와 무관 — 변경 없음.
- **홉2 (Nginx → EC2)**: 커스텀 앱은 **사용자 EC2에서 실행**되고 Nginx는 별도 호스트(Fargate)이므로, `nginx → EC2:<port>` 가 **EC2 SG를 통과**해야 함. EC2 SG에 포트가 없으면 SG에서 connection refused → 커스텀 포트 미동작. **따라서 EC2 SG 룰은 기계적으로 필수**.

### EC2 SG ingress
```ts
// 기존 8080/3000/8000 ingress의 source를 vpcCidr → nginxSg 로 교체(B-H3) 후, 범위 추가
sg.addIngressRule(nginxSg, ec2.Port.tcpRange(1024, 65535), 'Nginx → user custom ports');
```
- **source = NginxSg 전용** (B-H3 수정). 설정 변경마다 SG 재배포 불필요 — CDK 정적 관리.
- **범위 개방의 blast-radius 봉쇄선 = NginxSg-only source**: 이 고포트에 도달 가능한 것은 오직 Nginx이고, Nginx는 검증된 route만 프록시. "compromised nginx" 는 멀티테넌트 프록시 전체가 뚫리는 별개 시나리오이므로 본 기능의 추가 위험이 아님.
- **결정**: EC2 host-level iptables(등록 포트만 허용)는 **불채택** — NginxSg-only source가 이미 봉쇄선이라 과도. (consensus #2 → accepted risk / LOW 강등)
- **전제 (필수, consensus 2회차 LOW)**: 기존 `8080/3000/8000`의 `vpcCidr` ingress 룰(`07-ec2-devenv-stack.ts:57-58,67,80`)을 **실제로 NginxSg source로 교체/제거**해야 SG 조정이 유효. 잔존 시 테넌트 격리 갭 지속.
  → **CDK 테스트 assertion**: sgOpen/sgRestricted/sgLocked에 `Peer.ipv4(vpcCidr)` ingress가 **없음** + NginxSg source ingress가 존재함을 `Template.hasResourceProperties`로 검증.

---

## 7. API

### `shared/nextjs-app/src/app/api/user/custom-routes/route.ts` (신규)
- `GET` — 본인 customRoutes 조회 (세션 기반).
- `PUT` — `customRoutesPayloadSchema` 검증 + API max 5 강제 + 소유권 검증 → `cc-user-instances` 저장 → active면 `cc-routing-table` patch.
- 세션 검증 필수, 본인 subdomain만 접근 (CLAUDE.md 규칙).

### `shared/nextjs-app/src/app/api/users/route.ts` (수정)
- admin 사용자 목록 응답에 각 사용자 `customRoutes` 포함 (`cc-user-instances`에서 read).

### `shared/nextjs-app/src/lib/aws-clients.ts` (수정)
- `registerContainerRoute`가 user-instances의 customRoutes를 routing-table 행에 미러.
- user-instances customRoutes read/write 헬퍼 추가.

---

## 8. UI

### 8.1 path-preserve 한계 (명시 — consensus, 오버셀 금지)
보존 방식은 **에셋 상대경로**는 해결하지만 다음은 앱 설정 없이는 prefix를 탈출한다. UI 힌트와 문서에 명시한다:
- **절대 redirect**: 앱이 `Location: /login` 반환 시 루트로 튐 → 앱의 base/redirect 설정 필요.
- **`Set-Cookie Path=/`**: 동일 서브도메인 공유라 route 간 쿠키 충돌 → 필요 시 `proxy_cookie_path {path}/ /` 고려(앱별).
- **절대 에셋 URL / websocket URL / OAuth 콜백**: base-path-aware 설정(Vite `base`, Next `basePath`, Streamlit `--server.baseUrlPath`, Gradio `root_path`) 시 정상.
- 즉 **"base-path-aware 앱 또는 API용"** 포지셔닝. 무설정 임의 앱 보장 아님.

### 8.2 route 상태 노출 (consensus #6 — silent skip 방지)
config-gen이 skip한 route는 UI가 "성공"으로 오인하면 안 된다.
- config-gen 검증 결과를 routing-table 행에 `routeStatus`(route별 `ok`/`rejected`+사유)로 기록, GET API가 반환.
- settings-tab은 route별 상태 뱃지(✅ 적용 / ⚠️ 거부+사유) 표기. 저장 즉시 "성공"이 아니라 **반영 확인까지 pending** 표시.

### 8.3 사용자 — `components/user/settings-tab.tsx`
- "포트 노출 / Exposed Ports" 섹션: route 목록(label·path·port), 추가/삭제(최대 5), **루트 지정 토글**(`path="/"`, 1개 제한), 스키마 미러 인라인 검증, **route별 반영 상태(§8.2)**.
- 각 route 결과 URL 미리보기: `https://{subdomain}.dev.{domain}{path}`.
- base-path 힌트(§8.1).

### 8.4 관리자 — `components/tables/users-table.tsx`
- "노출 포트" 컬럼: 사용자별 chip 목록 (`Frontend / :3000`, `API /api:8000`, `Vite /preview:5173`). 다수일 때 count 배지 + 확장.
- **`label`·`path` 렌더 시 escape**(consensus LOW — stored XSS 방지). React 기본 escape 의존 + `dangerouslySetInnerHTML` 미사용 확인.

---

## 9. 변경 파일 요약

| 파일 | 변경 |
|---|---|
| `shared/nextjs-app/src/lib/validation.ts` | reserved=[8080], 루트+multi-segment path, 세그먼트경계 예약판정, refine, 포트별 메시지, MAX=5 |
| `shared/nextjs-app/src/lib/types.ts` | `CustomRoute` 유지 + `routeStatus`/`routesVersion` 타입 |
| `cdk/lib/lambda/nginx-config-gen.py` | customRoutes 읽기·**subdomain/container_ip 포함 재검증**·루트/subpath(경계) location, `routeStatus` 기록 |
| `cdk/lib/07-ec2-devenv-stack.ts` | **vpcCidr→NginxSg source 교체** + 1024-65535 range (B-H3) |
| `shared/nextjs-app/src/app/api/user/custom-routes/route.ts` | **신규** GET(+routeStatus)/PUT(조건부쓰기) |
| `shared/nextjs-app/src/app/api/users/route.ts` | customRoutes 포함 |
| `shared/nextjs-app/src/lib/aws-clients.ts` | 미러(version 조건부)·seed·user-instances 헬퍼 |
| `shared/nextjs-app/src/components/user/settings-tab.tsx` | UI 섹션 |
| `shared/nextjs-app/src/components/tables/users-table.tsx` | 노출 포트 컬럼 |
| `docs/decisions/ADR-027-devenv-custom-port-exposure.md` | ADR-009 확장 신규 ADR |
| `shared/nextjs-app/src/lib/__tests__/custom-routes-validation.test.ts` | reserved=[8080]·루트·max5 반영 갱신 |
| nginx-config-gen 테스트 | custom route 생성 + 불일치 skip (Python) |

---

## 10. 테스트 전략

- **validation** (vitest): reserved=[8080] only, 루트 path 허용/1개 제한, **multi-segment 허용(`/api/v1`)·연속슬래시·끝슬래시·traversal 거부**, 세그먼트 경계 예약판정(`/apiary`≠`/api`), max 5, 포트별 에러 메시지, 중복 거부.
- **nginx-config-gen** (Python 하니스 확장/pytest): 루트→`location /`, subpath→`location = {p}` + `^~ {p}/`(경계), **subdomain·container_ip 불일치 행 skip + 경고**, code-server location 항상 생성, `proxy_read_timeout` 포함.
- **CDK** (`07-ec2-devenv-stack`): vpcCidr ingress 부재 + NginxSg source ingress 존재 assertion (§6).
- **API**: PUT 검증·소유권·max5·조건부쓰기(version), GET 본인만 + `routeStatus` 반환.
- **수동/E2E**: 설정 등록 → ~5s 후 nginx 반영 확인, base-path 설정한 앱 에셋 로딩, 거부 route의 UI 상태(§8.2) 표시 확인.

---

## 11. 마이그레이션 / 호환성 (모순 해소 — consensus)

seed 메커니즘을 **단일 경로로 확정**한다 (D7 ↔ 기존 §11 모순 제거):
- **seed 시점 = `registerContainerRoute`(부팅/시작) 단일 지점.** 해당 인스턴스의 `cc-user-instances.customRoutes` 가 **미설정(속성 없음)일 때만** seed `[{"/", 3000, "Frontend"}, {"/api", 8000, "API"}]` 를 1회 주입하고 그 값으로 routing-table mirror. 빈 배열(`[]`)은 "사용자가 전부 삭제"로 간주 → seed 재주입 안 함.
- nginx-config-gen은 **항상 routing-table 행의 `customRoutes` 만 신뢰**. 속성이 없거나 빈 배열이면 커스텀 upstream/location 0개(code-server built-in만 생성). **하드코딩 3-port fallback 없음** — 규약을 customRoutes로 일원화.
- 기존 운영 중 인스턴스: 다음 start/부팅 시 seed 주입으로 현재 동작(루트→3000, /api→8000) 복원.

---

## 12. 보안 고려 (보안 리뷰 연계)

- **B-H1 (nginx injection)**: write-path(API 검증) + config-gen(Python 재검증) 2중 차단. **path/port뿐 아니라 `subdomain`·`container_ip` 도** nginx 보간 전 검증(§5.2) — 보간되는 모든 사용자/시스템 유래 값이 대상.
- **B-H3 (SG ingress)**: 본 설계는 NginxSg-제한 ingress를 전제. 1024-65535 범위 개방은 NginxSg 소스에 한해서만 허용되므로 테넌트 격리 유지. 범위 개방의 blast-radius는 §6 참조 — NginxSg-only source가 봉쇄선, host 방화벽 불채택(accepted risk).
- code-server 포트(8080)는 등록 불가 — 사용자가 IDE 게이트를 자기 앱으로 덮어쓰는 것 방지.
