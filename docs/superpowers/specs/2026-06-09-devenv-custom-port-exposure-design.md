# DevEnv 사용자 커스텀 포트 노출 — 설계 (Spec)

- **작성일**: 2026-06-09
- **상태**: Approved (brainstorming) → writing-plans 대기
- **확장 대상**: ADR-009 (DevEnv Multi-Port Routing) "향후 확장 — 사용자 커스텀 포트"
- **신규 ADR**: ADR-025 (작성 예정)
- **관련 보안 리뷰**: `docs/reviews/domain-port-review-2026-06-09.md` — B-H1(nginx 입력 injection), B-H3(SG ingress = NginxSg)

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
| D3 | **path 보존(preserve)** 방식 | `proxy_pass`에 URI 미지정 → `/preview/assets/...` 가 같은 prefix로 돌아와 SPA 에셋 안 깨짐. 앱이 해당 path 밑에서 서빙되어야 함(base-path-aware) |
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
- **동기화 규칙**:
  - 설정 PUT → 항상 `cc-user-instances` 갱신. 인스턴스 active면 `cc-routing-table` 행도 patch → DynamoDB Stream → `nginx-config-gen.py` 재생성 → S3 업로드 → `reload.sh` 폴링(~5s) hot-reload.
  - `registerContainerRoute(subdomain, privateIp)`(부팅 시) → `cc-user-instances`의 customRoutes를 routing-table 행에 복사.

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

// path: "/" (루트) 또는 단일 세그먼트
const ROOT_PATH = "/";
const SUBPATH_REGEX = /^\/[a-z0-9][a-z0-9-]*$/;
```

규칙:
- `path === "/"` 허용(루트), 그 외 `SUBPATH_REGEX` 매칭. traversal/대문자/예약 prefix 거부 (기존 테스트 유지).
- `port`: int 1024-65535, `8080` 제외. 8080 입력 시 메시지 **"8080은 code-server가 사용 중인 포트입니다 (노출 불가)"**.
- payload refine: 중복 path 거부, 중복 port 거부, **`path === "/"` 최대 1개**, 길이 ≤ 5.
- **예약 포트/경로는 조용히 skip하지 않고 명시적 400 에러** + 인라인 UI 에러로 사용자에게 표시.

---

## 5. nginx-config-gen.py (`cdk/lib/lambda/nginx-config-gen.py`) — 보안 핵심

1. routing-table 항목에서 `customRoutes` (DynamoDB List) 읽기.
2. **Python에서 TS와 동일 정규식으로 재검증** (B-H1 defense-in-depth): path(`/` 또는 `^/[a-z0-9][a-z0-9-]*$`), port(1024-65535, ≠8080), 예약 prefix 제외. **불일치 행은 skip + `logger.warning`** (전체 config는 계속 생성, silent 아님).
3. 유효 route별 생성:
   - upstream `custom_{subdomain}_{port}` → `{container_ip}:{port}` (`max_fails`/`keepalive`).
   - **루트 route** (`path == "/"`) → `location / { if ($arg_folder) { error_page 418 = @codeserver; return 418; } proxy_pass http://custom_{subdomain}_{port}; ... 502 안내 }`.
   - **subpath route** → `location ^~ {path} { proxy_pass http://custom_{subdomain}_{port}; ... WebSocket 헤더, 502 안내 }` (path 보존: proxy_pass에 URI 미지정).
4. code-server는 항상 built-in: upstream `codeserver_{subdomain}`(8080) + `?folder=` + 내부경로 location 생성.
5. 루트 route 없을 때: `location / { if ($arg_folder) → @codeserver; default → "프론트엔드 없음" 안내 페이지 }`.

`^~` (non-regex prefix, 우선) 사용으로 code-server 정규식 location이 custom subpath를 가로채지 않도록 한다. 예약 경로가 code-server 내부경로와 겹치지 않게 검증에서 차단되어 충돌 없음.

---

## 6. EC2 보안그룹 (`cdk/lib/07-ec2-devenv-stack.ts`)

```ts
// B-H3 수정(ingress source = NginxSg, VPC CIDR 아님) 위에 얹음
sg.addIngressRule(nginxSg, ec2.Port.tcpRange(1024, 65535), 'Nginx → user custom ports');
```
- 설정 변경마다 SG 재배포 불필요 — CDK가 정적 관리.
- ingress가 Nginx SG로만 제한되고 Nginx는 검증된 route만 프록시하므로 범위 개방이 안전.
- **전제**: 보안리뷰 B-H3 수정(8080/3000/8000 ingress source를 VPC CIDR → NginxSg로 변경)이 선행/동반되어야 함.

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

### 사용자 — `components/user/settings-tab.tsx`
- "포트 노출 / Exposed Ports" 섹션: route 목록(label·path·port), 추가/삭제(최대 5), **루트 지정 토글**(`path="/"`, 1개 제한), 스키마 미러 인라인 검증.
- 각 route 결과 URL 미리보기: `https://{subdomain}.dev.{domain}{path}`.
- base-path 힌트: "앱이 `{path}` 밑에서 서빙되도록 설정 필요 (Vite `base`, Next `basePath`, Streamlit `--server.baseUrlPath` 등)".

### 관리자 — `components/tables/users-table.tsx`
- "노출 포트" 컬럼: 사용자별 chip 목록 (`Frontend / :3000`, `API /api:8000`, `Vite /preview:5173`). 다수일 때 count 배지 + 확장.

---

## 9. 변경 파일 요약

| 파일 | 변경 |
|---|---|
| `shared/nextjs-app/src/lib/validation.ts` | reserved=[8080], 루트 path 허용, refine, 포트별 메시지, MAX=5 |
| `shared/nextjs-app/src/lib/types.ts` | `CustomRoute` 유지 (변경 없음) |
| `cdk/lib/lambda/nginx-config-gen.py` | customRoutes 읽기·재검증·루트/subpath location 생성 |
| `cdk/lib/07-ec2-devenv-stack.ts` | NginxSg → 1024-65535 ingress (B-H3 위) |
| `shared/nextjs-app/src/app/api/user/custom-routes/route.ts` | **신규** GET/PUT |
| `shared/nextjs-app/src/app/api/users/route.ts` | customRoutes 포함 |
| `shared/nextjs-app/src/lib/aws-clients.ts` | 미러·user-instances 헬퍼 |
| `shared/nextjs-app/src/components/user/settings-tab.tsx` | UI 섹션 |
| `shared/nextjs-app/src/components/tables/users-table.tsx` | 노출 포트 컬럼 |
| `docs/decisions/ADR-025-devenv-custom-port-exposure.md` | ADR-009 확장 신규 ADR |
| `shared/nextjs-app/src/lib/__tests__/custom-routes-validation.test.ts` | reserved=[8080]·루트·max5 반영 갱신 |
| nginx-config-gen 테스트 | custom route 생성 + 불일치 skip (Python) |

---

## 10. 테스트 전략

- **validation** (vitest): reserved=[8080] only, 루트 path 허용/1개 제한, max 5, 포트별 에러 메시지, 중복 거부, traversal 거부 (기존 테스트 갱신).
- **nginx-config-gen** (Python `if __name__` 하니스 확장 또는 pytest): 루트 route → `location /`, subpath → `location ^~`, 예약/불일치 행 skip + 경고 로그, code-server location 항상 생성.
- **API**: PUT 검증·소유권·max5, GET 본인만.
- **수동/E2E**: 설정 등록 → ~5s 후 nginx 반영 확인, base-path 설정한 앱 에셋 로딩 확인.

---

## 11. 마이그레이션 / 호환성

- 기존 사용자: 첫 PUT 또는 부팅 시 customRoutes 미설정이면 seed `[{"/", 3000, "Frontend"}, {"/api", 8000, "API"}]` 적용 → 현재 동작 그대로 유지.
- nginx-config-gen: customRoutes 속성 없는 routing-table 행도 안전하게 처리(seed 적용 전이면 기존 하드코딩 fallback 또는 seed 주입). **구현 계획에서 fallback 경로 명시 필요**.

---

## 12. 보안 고려 (보안 리뷰 연계)

- **B-H1 (nginx injection)**: write-path(API 검증) + config-gen(Python 재검증) 2중 차단. path/port가 nginx 지시문에 보간되기 전 양쪽에서 엄격 정규식 검증.
- **B-H3 (SG ingress)**: 본 설계는 NginxSg-제한 ingress를 전제. 1024-65535 범위 개방은 NginxSg 소스에 한해서만 허용되므로 테넌트 격리 유지.
- code-server 포트(8080)는 등록 불가 — 사용자가 IDE 게이트를 자기 앱으로 덮어쓰는 것 방지.
