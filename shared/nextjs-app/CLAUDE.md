# Next.js Dashboard Module

## Role
관리자/사용자 대시보드: 사용량 분석, 운영 모니터링, EC2 DevEnv 관리, 셀프서비스 포털, Local Governance Mode 자격증명 발급. Terraform `modules/dashboard`의 EC2 ASG에서 standalone 컨테이너로 실행된다 (ADR-011).

ADR 번호는 통합 후 번호다. 코드 주석의 옛 번호(ADR-026/027/031 등)는 `docs/history/ADR-MAPPING.md`로 변환한다.

## Pages (`src/app/`)
- `/` Home (비용/토큰/인스턴스 요약) · `/login` (직접 폼, Cognito Hosted UI 리다이렉트 없음)
- `/user` 사용자 셀프서비스 포털 (환경/스토리지/설정 탭 + Local Mode 탭)
- `/dept` 부서 관리자 대시보드 (멤버, 예산, 사용량)
- `/analytics` 토큰·모델·비용 트렌드 · `/monitoring` EC2 메트릭 + DynamoDB 기반 Bedrock 사용량 · `/security` IAM/DLP/DNS Firewall 현황
- `/ai` AI Assistant (Bedrock Converse + AgentCore Memory, Tool Use)
- `/admin` 사용자 CRUD, 하위 `instances`, `budgets`, `tokens`, `approvals`, `dlp`, `mcp`, `limits`(Local Governance 토큰 한도, ADR-006/008)
- `/local` Local Governance Mode 사용자 페이지 (STS 자격증명, aws configure 스니펫, 남은 토큰 게이지; ADR-006)
- `/docs` 내장 문서 (getting-started, user-guide, admin-guide, architecture, security, faq, local-mode)

## API Routes (`src/app/api/`)

모든 route는 세션을 검증한다. Admin route는 Cognito `admin` 그룹을, user route는 본인 데이터만 허용한다.

### Admin
- `containers`, `container-metrics` - EC2 인스턴스 관리, CloudWatch 메트릭 + DynamoDB 사용량
- `users` - Cognito 사용자 관리 · `security` - 보안 현황
- `usage` - Usage Analytics. `action=user_daily_trend`(사용자별 일별 cost/token), `action=tool_summaries`(Claude Code/Codex 도구별 비용; admin은 전체, 그 외 본인). 서버측 fail-closed RBAC(admin=전체, dept-manager=자기 부서, user=본인, 스코프 속성 없으면 403), 날짜창 ≤ 92일
- `admin/ebs-resize`, `admin/budgets`, `admin/tokens`, `admin/approval-requests`, `admin/dlp/domains`
- `admin/mcp/{catalog,gateways,gateways/sync,assignments,marketplaces}` - MCP 카탈로그·게이트웨이·마켓플레이스 (MCP Gateway는 BASELINE 범위 밖 기능으로 유지만 됨)
- `admin/limits` - Local Governance normalized token 한도 CRUD. USER 키는 소문자 email (ADR-005)
- `admin/limits/reset` - 한도 강제 reset + Deny policy detach. body `{email}`로 `USER#{email}/DENY#active`를 조회하고, 행의 `subdomain`으로 Local 롤명 `local-user-{subdomain}`을 해석해 detach·삭제한다(키=email, 롤명=subdomain). 활성 deny가 없으면 404

### User self-service
- `user/container` (시작/중지), `user/container/stream` (SSE 6단계 프로비저닝 진행), `user/container-request`, `user/container-metrics`, `user/disk-usage`
- `user/ebs-resize` (신청/상태/취소), `user/keep-alive` (유휴 타임아웃 연장), `user/resource-review` (EBS 확장 전 AI 사용량 분석)
- `user/password` (Cognito + Secrets Manager), `user/usage` (일일 토큰 사용량)
- `user/custom-routes` - 포트 노출 GET/PUT: 본인 customRoutes, 최대 5개, version CAS, routing-table 미러 (ADR-003)
- `local/credentials` - STS Issuer Lambda 호출, 1h Bedrock 자격증명 반환 (role-chaining 1h 한도, CLI가 자동 갱신; ADR-006)
- `local/limits` - 본인 normalized token 한도/사용량/Deny 상태

### Common
- `ai` - Bedrock Converse (Tool Use, 최대 5 iteration) · `ai/memory`, `ai/runtime` - AgentCore Memory/Runtime
- `dept`, `dept/list`, `dept/mcp` · `health` · `auth/[...nextauth]`
- `install`, `install/cli`, `install/otel` - Local CLI installer (runs `cc-bedrock-local setup` + `login` so plain `claude` / `codex` use Bedrock; removes legacy `cc()` / `ccx()` functions)
- `slack/commands`, `slack/events`

## Components
- `src/components/user/` - `environment-tab`(프로비저닝, 상태, IDE/WEB/API URL, 메트릭), `provisioning-progress`(SSE 진행, Cancel, ARIA), `storage-tab`(디스크 게이지, EBS 확장, Keep-Alive), `settings-tab`(비밀번호, 계정, 포트 노출 CRUD, resource-specific IAM 권한 신청 폼; ADR-003/007), `local-mode-tab`, `first-launch-guide`, `welcome-onboarding`
- `src/components/charts/` - Recharts (token-usage, model-ratio, cost-trend, leaderboard, horizontal-bar, area-trend, multi-line, donut)
- `tables/`, `cards/`, `dept/`, `app-shell.tsx`, `sidebar.tsx`, `filter-bar.tsx`, `container-metrics.tsx`

## Lib (`src/lib/`)
- `auth.ts` - Cognito + NextAuth (JWT, 8h 세션, custom attributes, 쿠키 도메인은 `COOKIE_DOMAIN` env)
- `aws-clients.ts` - Cognito 사용자 관리 + DynamoDB 라우팅 테이블. `mirrorCustomRoutes()`(settings PUT의 version-guarded 미러), `deregisterContainerRoute()`(resetUserEnvironment). 인스턴스 시작 시 라우팅 등록은 `ec2-clients.ts`의 `registerRoute()`
- `ec2-clients.ts` - EC2 start/stop, RunInstances, password sync, gateway policy. UserData는 매 부팅 실행되는 systemd oneshot `cc-cli-update.service`를 만들어 Claude Code/Kiro/Codex CLI를 갱신한다(`User=coder`, `/usr/local/bin` symlink 갱신만 `ExecStartPost=+`로 root 실행; CWAgent, MCP config sync 포함). `codexUserData()`는 create/restore와 `postStartSetup`에서 `codexConfigToml()`로 `/etc/codex/config.toml`을 쓴다. 재시작 경로는 per-user role inline policy를 다시 upsert(`ensureUserInstanceProfile`)해 기존 role에도 OpenAI/project ARN을 추가한다 (ADR-014)
- `data-volume*.ts` - 2-볼륨 EBS 모델의 데이터 볼륨 식별·AZ 핀·SSM·UserData (ADR-002) · `devenv-health.ts` - EC2 lifecycle 기반 헬스 판정 (ADR-012)
- `cloudwatch-client.ts` - EC2 CPU/Memory/Network/Disk 메트릭
- `usage-client.ts` - DynamoDB 사용량 조회. `buildUserDailyTrend`(순수 pivot: user×date, Top-N+others, zero-fill) + `getUserDailyTrend`
- `iam-request-validation.ts` - IAM 권한 신청 검증의 단일 출처(클라이언트·서버 공유): `Resource:*`·쓰기/임베디드 와일드카드·위험 액션·교차계정 거부, 읽기 와일드카드(Get*/List*/Describe*/BatchGet*/Query*/Scan*) 허용, `buildIamExtensionRequest`, `DEFAULT_SERVICE_ALLOWLIST`/`WILDCARD_OK_ACTIONS` (ADR-007)
- `iam-resource-annotator.ts` - 신청 statement의 advisory LLM 위험 주석 (프롬프트 인젝션 격리) · `approval-authz.ts` - 승인 인가 (admin 또는 저장된 부서의 dept-manager)
- `codex-model.ts` (Codex 모델 ID·고정 CLI 버전 sanitizer, 기본값 `global.openai.gpt-6.1-sol`; 값이 root user-data로 들어가므로 검증 필수), `client-tool.ts` (CloudTrail userAgent/모델 vendor로 Claude Code vs Codex 귀속), `budget-periods.ts` (budget-check의 기간별 cap 해석 미러; ADR-014/008), `budget-display.ts` (cap ≤ 0 = Unlimited 표시, budget-check 의미와 일치)
- `slack-client.ts`, `validation.ts`, `utils.ts`, `i18n.tsx`(한/영), `types.ts`
- `src/middleware.ts` - 인증 + admin/dept-manager 라우트 보호

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
- `DEPLOYMENT_MODE` (runtime env from Terraform `deployment_mode`; unset or unknown = `governance`) is read by `lib/deployment-mode.ts` in the root layout and exposed to client components through `useDeploymentMode()`. In governance mode `/user` renders `components/user/local-setup.tsx` (installer + credentials/usage), the Instances menu and EC2 home cards are hidden, and DevEnv lifecycle APIs (`/api/containers`, `/api/user/container`, `/api/user/container/stream`) and DevEnv self-service requests (`/api/user/container-request`: tier, DLP, IAM extension) return 404 through `devenvDisabledResponse()`. The EC2 actions of `/api/container-metrics` (`current`, `timeseries`, `instances`) also 404 in governance; its `bedrock` / `bedrock_timeseries` actions are served in both modes. Admin/dept/monitoring/security/approvals pages hide EC2 DevEnv UI in governance (OS / tier / DLP policy / storage / ports columns and form fields, Reset Env, container status, EC2/EBS cost and instance metrics, DLP SG sections and EC2/EBS checklist rows, `tier_change` / `dlp_change` / `container_request` approvals), and `/admin/instances` redirects to `/admin`.
- 접근성: 탭(tablist/tab/tabpanel), 프로그레스바(progressbar), 폼(htmlFor/id), 알림(aria-live).
- 환경변수 목록은 `.env.example`; 배포 시 값은 Terraform `modules/dashboard`의 runtime env가 주입한다.
