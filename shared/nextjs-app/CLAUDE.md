# Next.js Dashboard Module

## Role
관리자/사용자 대시보드: 사용량 분석, 운영 모니터링, EC2 DevEnv 관리, 셀프서비스 포털, Local Governance Mode 자격증명 발급. Terraform `modules/dashboard`의 EC2 ASG에서 standalone 컨테이너로 실행된다 (ADR-011).

ADR 번호는 통합 후 번호다. 코드 주석의 옛 번호(ADR-026/027/031 등)는 `docs/history/ADR-MAPPING.md`로 변환한다.

## Pages (`src/app/`)
- `/` Home (비용/토큰/인스턴스 요약) · `/login` (직접 폼, Cognito Hosted UI 리다이렉트 없음). Also handles first-login `NEW_PASSWORD_REQUIRED` (set-new-password form) and forgot/reset-with-code; the credentials provider throws `NEW_PASSWORD_REQUIRED` (`lib/auth-errors.ts`) so the page can switch forms; `PasswordResetRequiredException` stays a generic failure because Cognito returns it before checking the password
- `/user` 사용자 셀프서비스 포털 (환경/스토리지/설정 탭 + Local Mode 탭)
- `/dept` 부서 관리자 대시보드 (멤버, 예산, 사용량)
- `/analytics` 토큰·모델·비용 트렌드 · `/monitoring` EC2 메트릭 + DynamoDB 기반 Bedrock 사용량 · `/security` IAM/DLP/DNS Firewall 현황
- `/ai` AI Assistant (Bedrock Converse + AgentCore Memory, Tool Use)
- `/admin` 사용자 CRUD, 하위 `instances`, `budgets`, `tokens`, `approvals`, `dlp`, `mcp`, `limits`(Local Governance 토큰 한도, ADR-006/008)
- `/local` Local Governance Mode 사용자 페이지 (STS 자격증명, aws configure 스니펫, 남은 토큰 게이지; ADR-006)
- `/docs` 내장 문서 (getting-started, user-guide, admin-guide, architecture, security, faq, local-mode)

## API Routes (`src/app/api/`)

Protected routes validate the user session and their required role/scope; user
routes restrict access to the user's own data. Public installer/health and
password challenge/recovery endpoints have route-specific validation.
`local/credentials` accepts a dashboard session or the CLI public client's
verified Cognito access token. `/api/ai` requires an admin session;
`/api/ai/runtime` currently requires both the middleware's NextAuth session and
the handler's configured bearer API key; bearer-only external integrations are
blocked before the handler.

### Admin
- `containers`, `container-metrics` - EC2 인스턴스 관리, CloudWatch 메트릭 + DynamoDB 사용량
- `users` - Cognito user management (every method `requireFreshRole(["admin"])`). POST requires a role (`createUserSchema.role`, added to that group); PUT `{username, role?, department?}` calls `setUserRole` on a role change or multi-group normalization (add new group → remove the other role groups → `AdminUserGlobalSignOut`). Guards 400 `self_demotion` / `last_admin` (counts enabled admins; also applies to disable and delete) / `dept_required`; partial Cognito failure 500 `role_change_failed`. GET maps the three role groups via `ListUsersInGroup` and returns `role` and `roleNeedsCleanup` · `security` - 보안 현황
- `usage` - Usage Analytics. `action=user_daily_trend`(사용자별 일별 cost/token), `action=tool_summaries`(Claude Code/Codex 도구별 비용; admin은 전체, 그 외 본인). 서버측 fail-closed RBAC(admin=전체, dept-manager=자기 부서, user=본인, 스코프 속성 없으면 403), 날짜창 ≤ 92일
- `admin/ebs-resize`, `admin/budgets`, `admin/tokens`, `admin/approval-requests`, `admin/dlp/domains`
- `admin/budgets` - PUT runs `requireFreshRole(["admin"])`, then records the user/department row update and a `limit_change` audit in one transaction (`lib/limit-audit`); a user's monthly USD is mirrored to `LIMIT#monthly` (`lib/limit-mirror`). Department totals and `perUser*Budget` are admin-only; department rows also take a boolean `unlimitedPerUser` (DynamoDB BOOL, audited as 1/0): members without an explicit cap are uncapped, skipping the dept per-user default and the global default (`lib/budget-periods` source `dept-unlimited`, mirrors budget-check)
- `admin/approval-requests` - admin + dept-manager (middleware `APPROVER_PATHS` 예외; 라우트가 Cognito에서 현재 역할·부서를 재확인). 모든 타입에 자기 승인 금지; dept-manager는 자기 부서 `budget_increase`만 조회·결정(그 외 타입 403 `admin_only_request_type`), manager/admin 요청자의 요청은 admin만. 결정은 순수 `decideBudgetAction` 후 조건부 트랜잭션(요청 `pending`→`approved`, 잠금 삭제, 사용자 행 cascade `grant#{period}#{key}` ADD, 부서 `grant#monthly#{key}` ADD — dept-manager 승인 시 부서 grant 낙관적 조건); 만료 409 `expired`, 동시 결정 409 `already_decided`, 부서 grant 변경 409 `department_changed_retry`, 기타 취소 503 `retry`. admin 승인자는 요청자 역할 조회를 건너뛴다(삭제된 요청자도 결정 가능). 승인 커밋 후 `releaseTokenAxis`로 토큰 축도 해제(LIMIT#monthly 행이 있으면 KST 월 `grant_bucket`/`grant_normalized` = floor(금액 × `NORMALIZED_PER_USD`) 반영; 활성 `DENY#active`는 `scope=user`·`period=monthly`이고 grant가 기록됐으며 이번 달 카운터 < max+grant이며 enforcer의 모든 cap(사용자·부서 × daily/weekly/monthly, KST 버킷; 부서는 deny 행 `dept` 우선)이 미만일 때만 해제, 그 외는 유지하고 `reason` (`dept_scope`/`non_monthly`/`legacy_deny`/`no_token_limit`/`still_over_cap`/`other_cap_exceeded`/`role_unresolved`)과 경고 반환, 행 없음은 `noTokenLimit`) — 결과는 응답 `applied.tokenRelease`와 요청 레코드 `tokenRelease`(JSON); 실패해도 승인은 200 유지(`{released:false, warning}`)
- `admin/mcp/{catalog,gateways,gateways/sync,assignments,marketplaces}` - MCP 카탈로그·게이트웨이·마켓플레이스 (MCP Gateway는 BASELINE 범위 밖 기능으로 유지만 됨)
- `admin/limits` - Local Governance normalized token 한도 CRUD. USER 키는 소문자 email (ADR-005)
- `admin/limits/reset` - 한도 강제 reset + Deny policy detach. body `{email}`로 `USER#{email}/DENY#active`를 조회하고, 행의 `subdomain`으로 Local 롤명 `local-user-{subdomain}`을 해석해 detach·삭제한다(키=email, 롤명=subdomain). 로직은 `lib/token-deny.ts` `releaseTokenDeny`(증액 승인과 공유). 활성 deny가 없으면 404

### User self-service
- `user/container` (시작/중지), `user/container/stream` (SSE 6단계 프로비저닝 진행), `user/container-request`, `user/container-metrics`, `user/disk-usage`
- `user/ebs-resize` (신청/상태/취소), `user/keep-alive` (유휴 타임아웃 연장), `user/resource-review` (EBS 확장 전 AI 사용량 분석)
- `user/password` — POST `{currentPassword, newPassword}`: re-authenticates with the current password, then Cognito `ChangePassword` (no admin API); in DevEnv also syncs the code-server secret. Governance portal uses `components/user/account-password-card.tsx`. `user/usage` (일일 토큰 사용량)
- `user/custom-routes` - 포트 노출 GET/PUT: 본인 customRoutes, 최대 5개, version CAS, routing-table 미러 (ADR-003)
- `user/budget-increase` - 1회성 USD 한도 증액 요청 (두 배포 모드 공통). GET 본인 이력, POST `{period, requestedAmount, reason}` (0 < 금액 ≤ 10000, 사유 1–500자, 무제한 기간 400 `unlimited_period`, 기간 창당 pending 1건 — 잠금 `PENDING#{email}#{period}#{key}`, 중복 409 `pending_exists`). 부서·역할은 Cognito에서 읽는다
- `local/credentials` - STS Issuer Lambda 호출, 1h Bedrock 자격증명 반환 (role-chaining 1h 한도, CLI가 자동 갱신; ADR-006)
- `local/limits` - 본인 normalized token 한도/사용량/Deny 상태 + USD `usdPeriods`(기간별 spend·기본 cap·현재 창 grant·cap), `activeGrants`, `blockCause` (`lib/budget-status`)

### Common
- `ai` - Bedrock Converse (Tool Use, 최대 5 iteration) · `ai/memory`, `ai/runtime` - AgentCore Memory/Runtime
- `dept/user-budgets` - PUT `{email, dailyBudget?, weeklyBudget?, monthlyBudget?}` standing member limits (admin or dept-manager; 0–100000 per period, 0 = inherit). A dept-manager may target only plain users of the same real department (403 `self`/`other_department`/`target_is_manager`/`no_department`); with a department total > 0 the personal monthly must be ≤ the total (400 `exceeds_department_total`). The actor's and target's role and department are read fresh from Cognito; row update + `limit_change` audit in one transaction
- `dept` (단일 부서 조회 시 멤버별 `limits`·`budgetStatus`(기본+grant, 차단 원인), 예산에 `recordedSpend`·`monthGranted`, pending에 `type`/`period`/`requestedAmount`), `dept/list`, `dept/mcp` · `health` · `auth/[...nextauth]`
- `auth/password/{new,forgot,reset}` — public (middleware passes `/api/auth/*`): first-login new password (temp password authorizes), forgot (same response whether or not the account exists; a never-signed-in invitee gets the invitation re-sent via `AdminCreateUser RESEND`, at most once per 15 min per account via `UserLastModifiedDate`), reset with emailed code. Logic in `lib/cognito-password.ts`; policy in `lib/password-policy.ts` (must match the pool policy)
- `install`, `install/cli`, `install/otel` - Local CLI installer (runs `cc-bedrock-local setup` + `login` so plain `claude` / `codex` use Bedrock; removes legacy `cc()` / `ccx()` functions)
- `slack/commands`, `slack/events`

## Components
- `src/components/user/` - `environment-tab`(프로비저닝, 상태, IDE/WEB/API URL, 메트릭), `provisioning-progress`(SSE 진행, Cancel, ARIA), `storage-tab`(디스크 게이지, EBS 확장, Keep-Alive), `settings-tab`(비밀번호, 계정, 포트 노출 CRUD, resource-specific IAM 권한 신청 폼; ADR-003/007), `local-mode-tab`, `first-launch-guide`, `welcome-onboarding`
- `src/components/charts/` - Recharts (token-usage, model-ratio, cost-trend, leaderboard, horizontal-bar, area-trend, multi-line, donut)
- `src/components/budget/budget-increase-request.tsx` - 증액 요청 폼(기간·금액 1–10000·사유, UTC 기준, 무제한 기간 비활성) + 차단 원인 + 본인 이력; `/local`, `local-mode-tab`, devEnv 포털에서 사용
- `tables/`, `cards/`, `dept/`, `app-shell.tsx`, `sidebar.tsx`(승인 메뉴는 admin·dept-manager, 처리 가능한 pending 건수 배지), `filter-bar.tsx`, `container-metrics.tsx`

## Lib (`src/lib/`)
- `auth.ts` - Cognito + NextAuth (JWT, 8h 세션, custom attributes, 쿠키 도메인은 `COOKIE_DOMAIN` env)
- `aws-clients.ts` - Cognito 사용자 관리 + DynamoDB 라우팅 테이블. `mirrorCustomRoutes()`(settings PUT의 version-guarded 미러), `deregisterContainerRoute()`(resetUserEnvironment). 인스턴스 시작 시 라우팅 등록은 `ec2-clients.ts`의 `registerRoute()`
- `ec2-clients.ts` - EC2 start/stop, RunInstances, password sync, gateway policy. UserData는 매 부팅 실행되는 systemd oneshot `cc-cli-update.service`를 만들어 Claude Code/Kiro/Codex CLI를 갱신한다(`User=coder`, `/usr/local/bin` symlink 갱신만 `ExecStartPost=+`로 root 실행; CWAgent, MCP config sync 포함). `codexUserData()`는 create/restore와 `postStartSetup`에서 `codexConfigToml()`로 `/etc/codex/config.toml`을 쓴다. 재시작 경로는 per-user role inline policy를 다시 upsert(`ensureUserInstanceProfile`)해 기존 role에도 OpenAI/project ARN을 추가한다 (ADR-014)
- `data-volume*.ts` - 2-볼륨 EBS 모델의 데이터 볼륨 식별·AZ 핀·SSM·UserData (ADR-002) · `devenv-health.ts` - EC2 lifecycle 기반 헬스 판정 (ADR-012)
- `cloudwatch-client.ts` - EC2 CPU/Memory/Network/Disk 메트릭
- `usage-client.ts` - DynamoDB 사용량 조회. `buildUserDailyTrend`(순수 pivot: user×date, Top-N+others, zero-fill) + `getUserDailyTrend`
- `iam-request-validation.ts` - IAM 권한 신청 검증의 단일 출처(클라이언트·서버 공유): `Resource:*`·쓰기/임베디드 와일드카드·위험 액션·교차계정 거부, 읽기 와일드카드(Get*/List*/Describe*/BatchGet*/Query*/Scan*) 허용, `buildIamExtensionRequest`, `DEFAULT_SERVICE_ALLOWLIST`/`WILDCARD_OK_ACTIONS` (ADR-007)
- `iam-resource-annotator.ts` - 신청 statement의 advisory LLM 위험 주석 (프롬프트 인젝션 격리) · `approval-authz.ts` - 승인 인가 (admin 또는 저장된 부서의 dept-manager); no self-approval; `canApproveBudgetIncrease` order = self → invalid_amount → expired → admin → not_approver → other_department → requester_is_manager → exceeds_department
- `roles.ts` (pure: `ROLES`, `roleFromGroups` highest privilege + `needsCleanup`, `validateRoleChange`, `hasRealDepartment` — blank or `default` is no department), `role-admin.ts` (Cognito: `getRoleGroups`, `setUserRole`, `listGroupMembers`, `countAdmins` enabled admins only, `requireFreshRole` — lookup failure 503, no permission 403), `budget-grants.ts` (UTC mirror of budget-check `period_key`/`cascade_targets`/`grant_attr`/`active_grants`), `dept-limit-authz.ts` (dept-manager standing-limit rules), `limit-audit.ts` (`limit_change` audit transaction), `limit-mirror.ts` (USD monthly cap → `LIMIT#monthly` mirror), `ccdash.ts` (`ccdashLinks`: null unless https)
- `codex-model.ts` (Codex 모델 ID·고정 CLI 버전 sanitizer, 기본값 `global.openai.gpt-6.1-sol`; 값이 root user-data로 들어가므로 검증 필수), `client-tool.ts` (CloudTrail userAgent/모델 vendor로 Claude Code vs Codex 귀속), `budget-periods.ts` (budget-check의 기간별 cap 해석 미러; ADR-014/008), `budget-display.ts` (cap ≤ 0 = Unlimited 표시, budget-check 의미와 일치; `blockCause` = 부서 → 개인 일/주/월 → 토큰 순), `budget-status.ts` (서버: 기간별 기본+현재 grant, 차단 원인, 토큰 deny 사용자 스캔), `budget-ui.ts` (승인 화면·배지·폼의 순수 규칙: 만료/본인/admin 승인 필요 판정, 에러 코드 → i18n 키, 승인 후 토큰 축 경고), `budget-increase.ts` (증액 요청 생성/승인/거절/만료 트랜잭션 순수 빌더 + 실행, 토큰 축 해제 `releaseTokenAxis`), `token-deny.ts` (토큰 deny detach + `DENY#active` 삭제, 역할 미해석 시 보존), `route-access.ts` (middleware 경로 게이팅 순수 함수 `isAllowedPath`)
- `slack-client.ts`, `validation.ts`, `utils.ts`, `i18n.tsx`(한/영), `types.ts`
- `src/middleware.ts` - 인증 + admin/dept-manager 라우트 보호 (`lib/route-access.ts` `isAllowedPath`; only `APPROVER_PATHS` are opened to dept-managers)

## Roles (required constraint)
- The only source of a role is the Cognito group `admin` / `dept-manager` / `user`. Every user has **exactly one** group. Roles are not kept separately in custom attributes or DynamoDB.
- Only admins assign or change roles, on the admin users page (`/admin`), and saving writes the Cognito group immediately (`setUserRole`). `dept-manager` requires a real department. An admin cannot demote themselves, and the last enabled admin cannot be removed.
- No group = `user`; several groups = resolved to the highest privilege and flagged "needs cleanup" (normalized on save). No automatic bulk change.
- Shared user pool: `COGNITO_GROUP_PREFIX` (e.g. `cc-`) prefixes the Cognito group names (`cc-admin` / `cc-dept-manager` / `cc-user`); `lib/roles.ts` `groupName` / `rolesFromGroupNames` apply and strip it at the Cognito boundary (JWT callback, `role-admin`, user create), so app logic only sees role names and other apps' groups are ignored. With a prefix set, no cc role group = no access: sign-in is refused (generic failure), `requireFreshRole` and `/api/local/credentials` (`requireAnyRoleGroup`, fresh lookup, 503 on lookup failure) return 403, and `/api/users` GET lists such users with `role: null` ("No access") until an admin assigns a role. Empty/unset prefix = own pool, unchanged.
- Session JWT groups and department can be up to 8h stale. Privileged writes (approvals, limit changes, role changes) re-read the current group with `requireFreshRole` and the current department with `getCognitoUser`. New privileged routes follow the same pattern.
- The in-app admin guide (`app/docs/admin-guide`) states the same constraint.

## Testing
- `npx tsc --noEmit`, `npx vitest run` (테스트 위치 `src/lib/__tests__/`). `bash tests/run-all.sh`가 둘 다 실행한다.
- CI must propagate Vitest failures; do not append `|| true` to the test command.

## User portal recovery

`portal-status.ts` distinguishes unavailable status from a successful empty
environment. Preserve the last verified state, show a recovery action, and disable
start/stop while status is stale. The status API must retain `STOPPING` until EC2
confirms the final state; client timers cannot manufacture stop completion.

`provisioning-stream.ts` requires a terminal event. Interrupted streams and expired
sessions return actionable errors. React effect replay must not duplicate start
requests, and closing progress only closes tracking. Keep event names aligned with
`PROVISIONING_STEPS`, including `storage_prepare`.

Custom-route edits survive failed saves and version conflicts. Reloading server
data after a conflict requires an explicit user action; never silently discard the
draft. Disable saving until the existing settings have loaded successfully.

## Rules
- Server Components가 기본이고, 차트/인터랙티브 UI만 `'use client'`.
- Bedrock 사용량은 DynamoDB `cc-on-bedrock-usage`에서 읽는다. CloudWatch `AWS/Bedrock`은 계정 전체 수치라 사용자별 집계에 맞지 않는다.
- Local Governance UI(`/local`, `/admin/limits`) 사이드바 노출은 `NEXT_PUBLIC_LOCAL_MODE_ENABLED=true`로 제어한다.
- `DEPLOYMENT_MODE` (runtime env from Terraform `deployment_mode`; unset or unknown = `governance`) is read by `lib/deployment-mode.ts` in the root layout and exposed to client components through `useDeploymentMode()`. In governance mode `/user` renders `components/user/local-setup.tsx` (installer + credentials/usage), the Instances menu and EC2 home cards are hidden, and DevEnv lifecycle APIs (`/api/containers`, `/api/user/container`, `/api/user/container/stream`) and DevEnv self-service requests (`/api/user/container-request`: tier, DLP, IAM extension) return 404 through `devenvDisabledResponse()`. The EC2 actions of `/api/container-metrics` (`current`, `timeseries`, `instances`) also 404 in governance; its `bedrock` / `bedrock_timeseries` actions are served in both modes. Admin/dept/monitoring/security/approvals pages hide EC2 DevEnv UI in governance (OS / tier / DLP policy / storage / ports columns and form fields, Reset Env, container status, EC2/EBS cost and instance metrics, DLP SG sections and EC2/EBS checklist rows, `tier_change` / `dlp_change` / `container_request` / `iam_extension` approvals; dept dashboard shows instance-request approve/reject to admins only), and `/admin/instances` redirects to `/admin`.
- 접근성: 탭(tablist/tab/tabpanel), 프로그레스바(progressbar), 폼(htmlFor/id), 알림(aria-live).
- 환경변수 목록은 `.env.example`; 배포 시 값은 Terraform `modules/dashboard`의 runtime env가 주입한다.
- ccdash (optional): the root layout reads `CCDASH_URL` (Terraform `ccdash_url`) on the server via `ccdashLinks` and passes it down through `CcdashProvider` (not NEXT_PUBLIC). When set, the sidebar shows a `ccdash` external link and `components/user/ccdash-setup-card.tsx` (`/local`, LocalSetup: `{ccdash_url}/collector` link + the login email to use as `user.email`); when unset both are hidden. The dashboard writes no telemetry settings to user machines.
