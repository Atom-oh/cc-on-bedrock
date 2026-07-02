"use client";

import { useI18n } from "@/lib/i18n";
import {
  Terminal,
  KeyRound,
  Gauge,
  ShieldCheck,
  AlertTriangle,
  HardDrive,
  Cpu,
  ArrowRight,
} from "lucide-react";

function SectionTitle({ children, id }: { children: React.ReactNode; id?: string }) {
  return (
    <h2 id={id} className="text-xl font-bold text-white mt-10 mb-4 flex items-center gap-2 scroll-mt-8">
      <span className="w-1 h-6 bg-cyan-500 rounded-full" />
      {children}
    </h2>
  );
}

function SubTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="text-base font-bold text-white mt-6 mb-3">{children}</h3>;
}

function P({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-gray-400 leading-relaxed mb-3">{children}</p>;
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    <code className="px-1.5 py-0.5 rounded bg-[#161b22] border border-white/5 text-cyan-300 text-[12px] font-mono">
      {children}
    </code>
  );
}

function CodeBlock({ children, title }: { children: string; title?: string }) {
  return (
    <div className="rounded-lg overflow-hidden border border-white/5 mb-4">
      {title && (
        <div className="px-4 py-2 bg-[#161b22] text-[10px] font-bold text-gray-500 uppercase tracking-wider border-b border-white/5">
          {title}
        </div>
      )}
      <pre className="p-4 bg-[#0d1117] text-xs text-gray-300 overflow-x-auto leading-relaxed">
        <code>{children}</code>
      </pre>
    </div>
  );
}

function Tag({ children, color = "cyan" }: { children: React.ReactNode; color?: "cyan" | "amber" | "emerald" | "rose" }) {
  const cls = {
    cyan: "bg-cyan-500/10 text-cyan-300 border-cyan-500/30",
    amber: "bg-amber-500/10 text-amber-300 border-amber-500/30",
    emerald: "bg-emerald-500/10 text-emerald-300 border-emerald-500/30",
    rose: "bg-rose-500/10 text-rose-300 border-rose-500/30",
  }[color];
  return (
    <span className={`inline-block px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide border ${cls}`}>
      {children}
    </span>
  );
}

function CompareTable({ rows }: { rows: { item: string; ec2: string; local: string }[] }) {
  return (
    <div className="rounded-lg overflow-hidden border border-white/5 mb-6">
      <table className="w-full text-sm">
        <thead className="bg-[#161b22] text-[10px] font-bold uppercase tracking-wider text-gray-500">
          <tr>
            <th className="text-left px-4 py-2.5">항목 · Item</th>
            <th className="text-left px-4 py-2.5">EC2 DevEnv</th>
            <th className="text-left px-4 py-2.5">Local Governance</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-white/5">
          {rows.map((r, i) => (
            <tr key={i} className="hover:bg-white/[0.02] transition-colors">
              <td className="px-4 py-3 font-medium text-white">{r.item}</td>
              <td className="px-4 py-3 text-gray-400">{r.ec2}</td>
              <td className="px-4 py-3 text-gray-400">{r.local}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function LocalModePage() {
  const { locale } = useI18n();
  const ko = locale === "ko";

  return (
    <div className="max-w-4xl">
      {/* Header */}
      <div className="mb-8 pb-6 border-b border-white/5">
        <div className="flex items-center gap-2 mb-2">
          <Tag color="cyan">ADR-014</Tag>
          <Tag color="emerald">{ko ? "추천" : "Recommended"}</Tag>
          <Tag color="amber">{ko ? "비용 0" : "Zero infra"}</Tag>
        </div>
        <h1 className="text-3xl font-black tracking-tight text-white mb-2 flex items-center gap-3">
          <Terminal className="w-7 h-7 text-cyan-400" />
          {ko ? "Local Governance Mode" : "Local Governance Mode"}
        </h1>
        <p className="text-sm text-gray-400 leading-relaxed">
          {ko
            ? "본인 노트북/워크스테이션에서 직접 Claude Code를 실행하면서도, 회사의 거버넌스(예산 한도, IAM 권한 경계, 사용량 추적)는 그대로 적용받는 모드입니다. EC2-per-user DevEnv 인스턴스를 띄우지 않고 Bedrock만 호출하므로 인프라 비용이 들지 않습니다."
            : "Run Claude Code directly on your laptop while still enforcing company governance (budget limits, IAM permission boundary, usage tracking). No EC2 DevEnv instance is provisioned — only Bedrock invocations are billed."}
        </p>
      </div>

      {/* 1. Flow */}
      <SectionTitle id="flow">
        {ko ? "1. 전체 흐름" : "1. End-to-end flow"}
      </SectionTitle>
      <P>
        {ko
          ? "Dashboard 로그인 직후, 사용자는 두 가지 방법으로 1h STS 자격증명을 받을 수 있습니다 — 브라우저(/local 페이지) 또는 CLI(cc-bedrock-local). 발급된 자격증명으로 본인 PC에서 claude를 직접 실행하면, Bedrock invocation logging이 사용량을 추적하고 한도를 자동 집행합니다. (CLI는 만료 10분 전 자동 갱신)"
          : "After Dashboard sign-in you can issue 1h STS credentials either via the /local page or the cc-bedrock-local CLI (auto-refreshed ~10min before expiry). Bedrock invocation logging tracks usage and the token-limit-enforcer Lambda automatically applies IAM Deny when the limit is exceeded."}
      </P>
      <CodeBlock title={ko ? "거래 흐름" : "Transaction flow"}>
{`User PC (cc-bedrock-local or /local page)
   ↓ 1. Cognito USER_PASSWORD_AUTH → JWT
   ↓ 2. POST /api/local/credentials (Bearer)
Dashboard (Next.js)
   ↓ 3. invoke STS Issuer Lambda (IAM auth)
STS Issuer Lambda
   ↓ 4. ensure_role + AssumeRole 1h
per-user IAM role (cc-on-bedrock-local-user-*)
   ↓ 5. read DENY#active
cc-on-bedrock-limits DynamoDB
   ↑ 6. STS credentials + limit_status
Dashboard → User PC

User PC: claude (CLAUDE_CODE_USE_BEDROCK=1)
   ↓ 7. InvokeModel / Converse
Bedrock Runtime (inference profile)
   ↓ 8. invocation logging
CloudWatch Logs
   ↓ 9. subscription filter (cc-on-bedrock-* prefix)
bedrock-usage-tracker Lambda
   ↓ 10. write usage + stream
cc-on-bedrock-usage DynamoDB (Streams)
   ↓ 11. stream consumer
token-limit-enforcer Lambda
   ↓ 12. limit exceeded? → DENY#active + IAM Deny attach
cc-on-bedrock-limits DynamoDB`}
      </CodeBlock>

      {/* 2. CLI */}
      <SectionTitle id="cli">
        <Terminal className="w-5 h-5 inline mr-2 text-cyan-400" />
        {ko ? "2. CLI 사용법 — cc-bedrock-local" : "2. CLI usage — cc-bedrock-local"}
      </SectionTitle>

      <SubTitle>{ko ? "2.1 설치" : "2.1 Install"}</SubTitle>
      <CodeBlock title={ko ? "원라인 설치" : "One-line install"}>
{`curl -fsSL https://cconbedrock-dashboard.<your-domain>/tools/cc-bedrock-local.sh \\
  -o ~/.local/bin/cc-bedrock-local
chmod +x ~/.local/bin/cc-bedrock-local

# PATH에 ~/.local/bin 추가 (이미 있으면 생략)
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc`}
      </CodeBlock>

      <SubTitle>{ko ? "2.2 설정 파일" : "2.2 Config file"}</SubTitle>
      <P>
        {ko ? (
          <>
            <Code>~/.config/cc-bedrock/config</Code> (mode 600 권장):
          </>
        ) : (
          <>
            <Code>~/.config/cc-bedrock/config</Code> (mode 600 recommended):
          </>
        )}
      </P>
      <CodeBlock title="~/.config/cc-bedrock/config">
{`# 필수
DASHBOARD_URL=https://cconbedrock-dashboard.<your-domain>
COGNITO_REGION=ap-northeast-2
COGNITO_USER_POOL_ID=ap-northeast-2_xxxxxxxxx
COGNITO_CLIENT_ID=xxxxxxxxxxxxxxxxxxxxxxxxxx
EMAIL=you@company.com

# 선택 (기본값 그대로 두면 됨)
AWS_PROFILE_NAME=cc-bedrock
AWS_REGION=ap-northeast-2

# 모델 매핑 (Claude Code의 /model 픽커 슬롯)
# Opus는 최신인 4.8로 두는 것을 권장 (CLI 기본값과 일치)
ANTHROPIC_DEFAULT_SONNET_MODEL=global.anthropic.claude-sonnet-5
ANTHROPIC_DEFAULT_OPUS_MODEL=global.anthropic.claude-opus-4-8
ANTHROPIC_DEFAULT_HAIKU_MODEL=global.anthropic.claude-haiku-4-5-20251001-v1:0
CLAUDE_CODE_SUBAGENT_MODEL=global.anthropic.claude-sonnet-5`}
      </CodeBlock>

      <SubTitle>{ko ? "2.3 하루 사용 흐름" : "2.3 Daily workflow"}</SubTitle>
      <CodeBlock>
{`# 처음 한 번만: 로그인 (비밀번호 입력 → Cognito 인증)
cc-bedrock-local login

# claude 실행 — 만료 10분 전이면 자동 재발급
cc-bedrock-local claude

# 현재 잔여 시간 + 한도 상태 확인
cc-bedrock-local status

# 작업 끝나면 (선택) 토큰 캐시 삭제
cc-bedrock-local logout`}
      </CodeBlock>

      <SubTitle>{ko ? "2.4 서브커맨드 레퍼런스" : "2.4 Subcommand reference"}</SubTitle>
      <div className="rounded-lg overflow-hidden border border-white/5 mb-6">
        <table className="w-full text-sm">
          <thead className="bg-[#161b22] text-[10px] font-bold uppercase tracking-wider text-gray-500">
            <tr>
              <th className="text-left px-4 py-2.5 w-1/3">{ko ? "명령" : "Command"}</th>
              <th className="text-left px-4 py-2.5">{ko ? "동작" : "Action"}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5 text-xs">
            {[
              ["login", ko ? "비밀번호 프롬프트 → Cognito 인증 → 1h STS 발급 + refresh token 저장" : "Password prompt → Cognito auth → 1h STS issue + refresh token"],
              ["refresh", ko ? "캐시된 refresh token으로 silent 재발급 (만료되면 실패)" : "Silent refresh using cached refresh token (fails if expired)"],
              ["logout", ko ? "refresh token + state 캐시 삭제" : "Clear refresh token + state cache"],
              ["status", ko ? "남은 TTL + 활성 Deny / 한도 상태 출력" : "Remaining TTL + Deny / limit state"],
              ["claude [args]", ko ? "세션 확보 + 모델 env 주입 후 claude 실행" : "Ensure session + apply model env, then run claude"],
              ["set-model K=V", ko ? "sonnet/opus/haiku/subagent/pin 별칭으로 모델 ID 교체" : "Update model env (sonnet/opus/haiku/subagent/pin)"],
              ["models", ko ? "현재 모델 매핑 + 사용 가능한 추천 ID 출력" : "Print current model env + suggested IDs"],
              ["run -- <cmd>", ko ? "자격증명만 확보하고 임의 명령 실행" : "Refresh credentials then exec any command"],
              ["config", ko ? "현재 설정 파일 + 경로 출력" : "Print current config + file paths"],
              ["change-email", ko ? "새 이메일/비밀번호 받아서 config에 영속" : "Persist new email/password to config"],
            ].map(([cmd, desc], i) => (
              <tr key={i} className="hover:bg-white/[0.02]">
                <td className="px-4 py-3"><Code>{cmd}</Code></td>
                <td className="px-4 py-3 text-gray-400">{desc}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 3. /local page */}
      <SectionTitle id="local-page">
        <KeyRound className="w-5 h-5 inline mr-2 text-cyan-400" />
        {ko ? "3. Dashboard /local 페이지" : "3. Dashboard /local page"}
      </SectionTitle>
      <P>
        {ko ? (
          <>
            CLI 없이 브라우저에서 직접 자격증명을 발급할 수 있습니다. 좌측 사이드바의{" "}
            <strong className="text-white">Local Mode</strong> 항목 또는{" "}
            <a href="/local" className="text-cyan-400 hover:underline">/local</a> 경로로 진입.
          </>
        ) : (
          <>
            Issue credentials directly from the browser instead of the CLI. Use the{" "}
            <strong className="text-white">Local Mode</strong> sidebar link or visit{" "}
            <a href="/local" className="text-cyan-400 hover:underline">/local</a>.
          </>
        )}
      </P>

      <SubTitle>{ko ? "3.1 화면 구성" : "3.1 Sections"}</SubTitle>
      <ul className="text-sm text-gray-400 space-y-2 mb-6 list-disc pl-5">
        <li><strong className="text-white">Get Bedrock credentials</strong> — {ko ? "버튼 클릭 시 1h STS 자격증명 발급. ~/.aws/credentials 스니펫 + Shell environment 스니펫을 Copy 버튼으로 복사" : "Issues a 1h STS credential set; provides Copy buttons for ~/.aws/credentials + Shell env snippets"}</li>
        <li><strong className="text-white">Normalized token usage</strong> — {ko ? "본인 + 본인 부서의 daily / weekly / monthly 게이지 (≥80% 노랑, ≥95% 빨강)" : "Self + department daily / weekly / monthly gauges (≥80% yellow, ≥95% red)"}</li>
        <li><strong className="text-white">CLI helper</strong> — {ko ? "cc-bedrock-local.sh 다운로드 + 본인 환경 맞춤 설정 스니펫" : "Download cc-bedrock-local.sh + environment-specific config snippet"}</li>
        <li><strong className="text-white">{ko ? "Deny 활성 시" : "Deny banner (when active)"}</strong> — {ko ? "페이지 최상단에 빨간색 배너 — daily/weekly/monthly 한도 초과 시" : "Red banner at top when a daily/weekly/monthly limit is exceeded"}</li>
      </ul>

      <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-4 mb-6 flex gap-3">
        <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
        <div>
          <div className="text-sm font-bold text-amber-300 mb-1">
            {ko ? "만료 시간이 1시간인 이유" : "Why credentials expire in 1 hour"}
          </div>
          <p className="text-xs text-gray-400 leading-relaxed">
            {ko
              ? "AWS role chaining (한 role이 다른 role을 AssumeRole)은 어떤 설정에도 관계없이 세션을 최대 1시간으로 제한합니다. CLI는 잔여 시간 10분 미만이면 자동 refresh를 실행하므로 사실상 무중단입니다."
              : "AWS role-chaining limits chained AssumeRole sessions to a hard cap of 1 hour regardless of any duration setting. The CLI auto-refreshes when remaining TTL < 10 min, so usage is effectively uninterrupted."}
          </p>
        </div>
      </div>

      {/* 4. Token usage where */}
      <SectionTitle id="token-usage">
        <Gauge className="w-5 h-5 inline mr-2 text-cyan-400" />
        {ko ? "4. 토큰 사용량은 어디서 보나요?" : "4. Where do I see token usage?"}
      </SectionTitle>

      <div className="rounded-lg overflow-hidden border border-white/5 mb-6">
        <table className="w-full text-sm">
          <thead className="bg-[#161b22] text-[10px] font-bold uppercase tracking-wider text-gray-500">
            <tr>
              <th className="text-left px-4 py-2.5">{ko ? "페이지" : "Page"}</th>
              <th className="text-left px-4 py-2.5">{ko ? "누가 보나" : "Audience"}</th>
              <th className="text-left px-4 py-2.5">{ko ? "내용" : "What's shown"}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5 text-xs">
            {[
              ["/local", ko ? "본인" : "Self", ko ? "본인 + 본인 부서 normalized token (daily/weekly/monthly), Deny 상태" : "Self + department normalized tokens, Deny state"],
              ["/user", ko ? "본인" : "Self", ko ? "일일 토큰 사용량 카드 (EC2 모드 포함)" : "Daily token usage card (also for EC2 mode)"],
              ["/dept", ko ? "부서 관리자" : "Dept manager", ko ? "부서 멤버별 사용량 분포, 부서 예산 잔액" : "Per-member usage distribution + department budget balance"],
              ["/admin/tokens", "Admin", ko ? "1d/7d/30d 토큰 차트, top users, 부서별 분해" : "1d/7d/30d token charts, top users, department breakdown"],
              ["/analytics", "Admin", ko ? "모델 비율, 비용 트렌드, 리더보드" : "Model ratio, cost trend, leaderboard"],
              ["/monitoring", "Admin", ko ? "실시간 세션, Bedrock 호출 그래프 (DynamoDB-backed)" : "Live sessions, Bedrock call graph (DynamoDB-backed)"],
            ].map(([page, who, what], i) => (
              <tr key={i} className="hover:bg-white/[0.02]">
                <td className="px-4 py-3"><Code>{page}</Code></td>
                <td className="px-4 py-3 text-gray-400">{who}</td>
                <td className="px-4 py-3 text-gray-400">{what}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <SubTitle>{ko ? "4.1 Normalized token 가중치 (ADR-015)" : "4.1 Normalized token weights (ADR-015)"}</SubTitle>
      <P>
        {ko
          ? "한도는 USD 예산과 별개로 normalized token 단위로 관리됩니다 (다른 모델 간 가중치를 일관되게 적용)."
          : "Limits are tracked in normalized-token units (independent from USD budget) so that different model classes carry a consistent weight."}
      </P>
      <div className="grid grid-cols-3 gap-3 mb-6">
        {[
          { name: "Haiku 4.5", weight: "1×", color: "from-emerald-500/20 to-emerald-500/5", text: "text-emerald-300" },
          { name: "Sonnet 5", weight: "~3.5×", color: "from-cyan-500/20 to-cyan-500/5", text: "text-cyan-300" },
          { name: "Opus 4.8", weight: "~15×", color: "from-violet-500/20 to-violet-500/5", text: "text-violet-300" },
        ].map((m, i) => (
          <div key={i} className={`rounded-xl border border-white/5 bg-gradient-to-br ${m.color} p-5`}>
            <div className={`text-2xl font-black ${m.text} mb-1`}>{m.weight}</div>
            <div className="text-xs font-bold text-white">{m.name}</div>
          </div>
        ))}
      </div>

      {/* 5. Admin controls */}
      <SectionTitle id="admin">
        <ShieldCheck className="w-5 h-5 inline mr-2 text-cyan-400" />
        {ko ? "5. Admin 컨트롤" : "5. Admin controls"}
      </SectionTitle>

      <SubTitle>{ko ? "5.1 /admin/limits — 한도 CRUD" : "5.1 /admin/limits — limit CRUD"}</SubTitle>
      <P>
        {ko ? (
          <>
            Add/Update limit 폼에서 <Code>USER</Code>/<Code>DEPT</Code> + key(sub 8자 / 부서 이름) +
            period(daily/weekly/monthly) + maxNormalized(정수) 입력. Active limits 테이블에서 삭제도 가능.
          </>
        ) : (
          <>
            Use the Add/Update form: <Code>USER</Code>/<Code>DEPT</Code> + key (sub-8 chars / dept name) +
            period (daily/weekly/monthly) + maxNormalized (integer). Delete from the Active limits table.
          </>
        )}
      </P>
      <CodeBlock title="API">
{`GET    /api/admin/limits           — list active limits
POST   /api/admin/limits           — upsert (entity, key, period, maxNormalized)
DELETE /api/admin/limits?entity=USER&key=...&period=daily
POST   /api/admin/limits/reset     — force-reset + detach Deny policy`}
      </CodeBlock>

      <SubTitle>{ko ? "5.2 강제 reset + Deny 해제" : "5.2 Force-reset + Deny detach"}</SubTitle>
      <ul className="text-sm text-gray-400 space-y-2 mb-6 list-disc pl-5">
        <li>{ko ? "cc-on-bedrock-limits 테이블의 DENY#active row 삭제" : "Delete DENY#active row in cc-on-bedrock-limits"}</li>
        <li>{ko ? "사용자 IAM role(cc-on-bedrock-local-user-{sub})에서 Deny policy detach" : "Detach Deny policy from cc-on-bedrock-local-user-{sub} role"}</li>
        <li>{ko ? "사용자 PC에 캐싱된 자격증명은 그대로 유효 — 다음 호출부터 통과" : "Cached credentials on user PC remain valid — next call passes through"}</li>
      </ul>

      <SubTitle>{ko ? "5.3 부서 예산 (/admin/budgets)" : "5.3 Department budgets (/admin/budgets)"}</SubTitle>
      <P>
        {ko
          ? "Normalized token 한도와 별개로 USD 단위 예산도 부여 가능. budget-check Lambda가 5분마다 누적 사용량을 계산해 초과 시 동일한 Deny 메커니즘 발동 (ADR-023)."
          : "USD budgets are tracked independently from normalized-token limits. The budget-check Lambda runs every 5 min and triggers the same Deny mechanism when exceeded (ADR-023)."}
      </P>

      {/* 6. Troubleshooting */}
      <SectionTitle id="troubleshooting">
        <AlertTriangle className="w-5 h-5 inline mr-2 text-cyan-400" />
        {ko ? "6. 트러블슈팅" : "6. Troubleshooting"}
      </SectionTitle>

      {[
        {
          symptom: ko ? "login이 NotAuthorizedException으로 실패" : "login fails with NotAuthorizedException",
          cause: ko
            ? "Cognito 사용자가 USER_PASSWORD_AUTH flow 미허용 App Client에 매핑되어 있거나 비밀번호 강제 변경 상태"
            : "User mapped to an App Client without USER_PASSWORD_AUTH, or password force-reset state",
          fix: ko
            ? "브라우저에서 /login으로 1회 통과 후 다시 cc-bedrock-local login"
            : "Sign in once via /login in the browser to clear force-reset, then retry cc-bedrock-local login",
        },
        {
          symptom: ko ? "refresh 실패 — refresh token 만료" : "refresh fails — refresh token expired",
          cause: ko ? "Cognito App Client TTL 만료 (보통 30일)" : "Cognito App Client refresh TTL elapsed (typically 30 days)",
          fix: ko ? "cc-bedrock-local login으로 비밀번호 재인증" : "Run cc-bedrock-local login to re-authenticate",
        },
        {
          symptom: ko ? "claude 호출이 AccessDeniedException" : "claude returns AccessDeniedException",
          cause: ko
            ? "활성 Deny policy / 자격증명 만료 / 모델 ID가 IAM 정책에 없음"
            : "Active Deny policy / expired credentials / model ID not in IAM policy",
          fix: ko ? (
            <>
              <Code>cc-bedrock-local status</Code> 로 상태 확인 → Admin에게 reset 요청 또는{" "}
              <Code>cc-bedrock-local refresh</Code>
            </>
          ) : (
            <>
              Check with <Code>cc-bedrock-local status</Code> → ask Admin to reset, or run{" "}
              <Code>cc-bedrock-local refresh</Code>
            </>
          ),
        },
        {
          symptom: ko ? '/model 픽커에 "Custom" 슬롯만 보임' : 'Only "Custom" slot in /model picker',
          cause: ko ? "config에 ANTHROPIC_MODEL이 세팅됨" : "ANTHROPIC_MODEL is set in config",
          fix: <Code>cc-bedrock-local set-model pin=</Code>,
        },
        {
          symptom: ko ? "ValidationException: invalid model identifier" : "ValidationException: invalid model identifier",
          cause: ko ? "모델 ID가 region에 활성화돼 있지 않음" : "Model ID not enabled in this region's inference profile",
          fix: (
            <>
              <Code>cc-bedrock-local run -- aws bedrock list-inference-profiles</Code>{" "}
              {ko ? "로 활성 ID 확인 후 set-model로 교체" : "to list active IDs, then set-model to a valid one"}
            </>
          ),
        },
        {
          symptom: ko ? "~/.aws/credentials 다른 프로파일과 충돌" : "~/.aws/credentials conflict with another profile",
          cause: ko ? "기본 [default] 프로파일을 다른 용도로 사용 중" : "[default] profile already in use",
          fix: ko
            ? "CLI는 [cc-bedrock] 프로파일에만 씀 — claude에 AWS_PROFILE=cc-bedrock 자동 주입되므로 [default]는 그대로 두면 됨"
            : "CLI writes only to [cc-bedrock] profile and injects AWS_PROFILE=cc-bedrock into claude env — leave [default] alone",
        },
      ].map((t, i) => (
        <div key={i} className="rounded-lg border border-white/5 bg-[#0d1117]/50 p-4 mb-3">
          <div className="text-sm font-bold text-white mb-2">{t.symptom}</div>
          <div className="text-xs text-gray-500 mb-1">
            <span className="text-rose-400 font-semibold">{ko ? "원인" : "Cause"}:</span> {t.cause}
          </div>
          <div className="text-xs text-gray-400">
            <span className="text-emerald-400 font-semibold">{ko ? "조치" : "Fix"}:</span> {t.fix}
          </div>
        </div>
      ))}

      {/* 7. Compare with EC2 */}
      <SectionTitle id="compare">
        <Cpu className="w-5 h-5 inline mr-2 text-cyan-400" />
        {ko ? "7. EC2 DevEnv 모드와의 차이" : "7. Compared with EC2 DevEnv mode"}
      </SectionTitle>
      <CompareTable
        rows={[
          { item: ko ? "사용자 PC 환경" : "User PC environment", ec2: "code-server (browser IDE)", local: ko ? "본인 IDE/터미널 그대로" : "Your own IDE/terminal" },
          { item: ko ? "컴퓨팅 자원" : "Compute", ec2: "EC2 t4g.large (ARM64)", local: ko ? "본인 PC" : "Your own PC" },
          { item: ko ? "저장소" : "Storage", ec2: "EBS root (40~100 GB)", local: ko ? "본인 PC 디스크" : "Your own PC disk" },
          { item: ko ? "세션 지속성" : "Session", ec2: ko ? "Hibernation ~5s resume" : "Hibernation ~5s resume", local: ko ? "1h STS + 자동 refresh" : "1h STS + auto-refresh" },
          { item: ko ? "인프라 비용" : "Infra cost", ec2: ko ? "EC2 + EBS 시간당" : "EC2 + EBS hourly", local: "0" },
          { item: ko ? "거버넌스" : "Governance", ec2: ko ? "동일 (per-user IAM, normalized token, Deny)" : "Same", local: ko ? "동일" : "Same" },
          { item: ko ? "배포 기준" : "Deploy", ec2: "terraform -chdir=terraform apply", local: "/api/install | bash" },
        ]}
      />
      <P>
        {ko
          ? "두 모드는 같은 클러스터에 공존 가능합니다. 사용자별로 본인 선호에 따라 골라 쓰는 게 일반적인 운영 패턴."
          : "Both modes can coexist in the same cluster. Letting each user pick their preferred mode is the recommended operational pattern."}
      </P>

      {/* Quick links */}
      <SectionTitle id="links">
        {ko ? "8. 참고" : "8. References"}
      </SectionTitle>
      <ul className="text-sm space-y-2 list-disc pl-5 text-gray-400">
        <li>
          <a href="/local" className="text-cyan-400 hover:underline inline-flex items-center gap-1">
            {ko ? "/local — 본인 자격증명 발급" : "/local — issue your credentials"}
            <ArrowRight className="w-3 h-3" />
          </a>
        </li>
        <li>
          <a href="/admin/limits" className="text-cyan-400 hover:underline inline-flex items-center gap-1">
            /admin/limits — {ko ? "한도 CRUD (Admin)" : "limit CRUD (Admin)"}
            <ArrowRight className="w-3 h-3" />
          </a>
        </li>
        <li>
          <a href="/admin/tokens" className="text-cyan-400 hover:underline inline-flex items-center gap-1">
            /admin/tokens — {ko ? "토큰 사용량 대시보드 (Admin)" : "token usage dashboard (Admin)"}
            <ArrowRight className="w-3 h-3" />
          </a>
        </li>
        <li>
          <a href="https://github.com/Atom-oh/cc-on-bedrock/blob/main/docs/decisions/ADR-014-local-governance-mode.md" target="_blank" rel="noreferrer" className="text-cyan-400 hover:underline">
            ADR-014 — Local Governance Mode
          </a>
        </li>
        <li>
          <a href="https://github.com/Atom-oh/cc-on-bedrock/blob/main/docs/decisions/ADR-015-budget-token-integration.md" target="_blank" rel="noreferrer" className="text-cyan-400 hover:underline">
            ADR-015 — Dollar Budget × Normalized Token Limit
          </a>
        </li>
        <li>
          <a href="https://github.com/Atom-oh/cc-on-bedrock/blob/main/docs/decisions/ADR-022-eventbridge-role-preprovisioning.md" target="_blank" rel="noreferrer" className="text-cyan-400 hover:underline">
            ADR-022 — EventBridge Pre-Provisioning (per-user IAM)
          </a>
        </li>
        <li>
          <a href="https://github.com/Atom-oh/cc-on-bedrock/blob/main/tools/cc-bedrock-local.sh" target="_blank" rel="noreferrer" className="text-cyan-400 hover:underline">
            tools/cc-bedrock-local.sh — {ko ? "CLI 소스" : "CLI source"}
          </a>
        </li>
      </ul>

      <div className="mt-12 pt-6 border-t border-white/5 flex justify-between text-xs text-gray-500">
        <span>{ko ? "이 문서는 ADR-014/015/021/022 기반 구현을 반영합니다" : "This page reflects ADR-014/015/021/022 implementations"}</span>
        <span>cc-on-bedrock · Local Governance Mode</span>
      </div>
    </div>
  );
}
