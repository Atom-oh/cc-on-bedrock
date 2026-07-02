"use client";

import { useLanguage } from "@/lib/i18n";
import { asset } from "@/lib/assets";
import Mermaid from "@/components/doc/Mermaid";
import { PageShell, H2, H3, P, Code, CodeBlock, Tag, Callout, Table } from "@/components/doc/primitives";

export default function LocalModePage() {
  const { t } = useLanguage();

  return (
    <PageShell
      title="Local Governance Mode"
      subtitle={t(
        "본인 노트북/워크스테이션에서 직접 claude를 실행하면서 회사 거버넌스(예산 한도, IAM 권한 경계, 사용량 추적)는 그대로 적용받는 모드. EC2-per-user DevEnv를 띄우지 않으므로 인프라 비용이 들지 않습니다.",
        "Run claude directly on your laptop while still enforcing company governance (budget limits, IAM permission boundary, usage tracking). No EC2 DevEnv instance is provisioned — Bedrock invocations only."
      )}
      tags={[
        { label: "Local Mode", color: "cyan" },
        { label: t("추천", "Recommended"), color: "green" },
        { label: t("비용 0", "Zero infra"), color: "orange" },
      ]}
    >
      <H2 id="flow">{t("1. 전체 흐름", "1. End-to-end flow")}</H2>
      <P>
        {t(
          "사용자 PC → Cognito → Dashboard → STS Issuer Lambda → per-user IAM role → Bedrock 호출 후 사용량이 로깅·집계·한도 평가되는 13 단계.",
          "User PC → Cognito → Dashboard → STS Issuer Lambda → per-user IAM role → Bedrock, with 13 steps for logging, aggregation, and limit enforcement."
        )}
      </P>
      <Mermaid
        caption={t("거래 흐름 (Local Governance Mode)", "Transaction flow (Local Governance Mode)")}
        chart={`flowchart LR
  User["User PC<br/>cc-bedrock-local CLI<br/>또는 /local 페이지"]
  Cognito["Cognito User Pool"]
  Dashboard["Dashboard (Next.js)"]
  STS["STS Issuer Lambda<br/>(IAM Function URL)"]
  Role["per-user IAM Role<br/>cc-on-bedrock-local-user-*"]
  Limits[("cc-on-bedrock-limits<br/>DynamoDB")]
  Bedrock[("Bedrock Runtime<br/>Inference Profile")]
  CW["CloudWatch Logs<br/>(invocation logging)"]
  Tracker["bedrock-usage-tracker<br/>Lambda"]
  Usage[("cc-on-bedrock-usage<br/>DynamoDB Streams")]
  Enforcer["token-limit-enforcer<br/>Lambda (stream consumer)"]

  User -->|"1. USER_PASSWORD_AUTH"| Cognito
  Cognito -->|"2. JWT"| User
  User -->|"3. POST /api/local/credentials<br/>(Bearer)"| Dashboard
  Dashboard -->|"4. invoke (IAM)"| STS
  STS -->|"5. AssumeRole 1h"| Role
  STS -->|"6. read DENY#active"| Limits
  STS -->|"7. STS creds + limit_status"| Dashboard
  Dashboard -->|"8. ~/.aws snippet + Shell env"| User

  User -->|"9. claude (CLAUDE_CODE_USE_BEDROCK=1)<br/>InvokeModel / Converse"| Bedrock
  Bedrock -->|"10. invocation log"| CW
  CW -->|"11. subscription filter<br/>(cc-on-bedrock-* prefix)"| Tracker
  Tracker -->|"12. write usage"| Usage
  Usage -->|"13. stream"| Enforcer
  Enforcer -->|"한도 초과 시<br/>DENY#active + IAM Deny"| Limits

  classDef store fill:#151d30,stroke:#00d4ff,color:#e5e7eb
  classDef lambda fill:#1a2540,stroke:#a855f7,color:#e5e7eb
  classDef user fill:#0f1629,stroke:#00ff88,color:#e5e7eb
  class Limits,Usage store
  class STS,Tracker,Enforcer lambda
  class User,Dashboard user`}
      />
      <details className="mb-5 rounded-lg border border-navy-600">
        <summary className="px-4 py-2 text-[11px] font-bold text-gray-500 uppercase tracking-widest cursor-pointer hover:text-gray-300">
          {t("ASCII 버전 (mermaid 미지원 환경)", "ASCII version (for non-mermaid renderers)")}
        </summary>
        <pre className="p-4 bg-navy-800 text-xs text-gray-300 overflow-x-auto leading-relaxed border-t border-navy-600">
{`User PC (cc-bedrock-local CLI or /local page)
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
   ↓ 7. claude → Bedrock → invocation logging
   → CloudWatch Logs → subscription filter → tracker Lambda
   → cc-on-bedrock-usage DynamoDB (Streams)
   → token-limit-enforcer Lambda
   → 한도 초과 시 DENY#active + IAM Deny attach`}
        </pre>
      </details>

      <H2 id="cli">{t("2. CLI 사용법 — cc-bedrock-local", "2. CLI usage — cc-bedrock-local")}</H2>

      <H3>{t("2.1 설치", "2.1 Install")}</H3>
      <CodeBlock title={t("원라인 설치", "One-liner")} lang="bash">
{`curl -fsSL https://cconbedrock-dashboard.<your-domain>/tools/cc-bedrock-local.sh \\
  -o ~/.local/bin/cc-bedrock-local
chmod +x ~/.local/bin/cc-bedrock-local

# PATH (이미 있으면 생략)
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc`}
      </CodeBlock>

      <H3>{t("2.2 설정 파일", "2.2 Config file")}</H3>
      <CodeBlock title="~/.config/cc-bedrock/config (mode 600)" lang="bash">
{`# 필수
DASHBOARD_URL=https://cconbedrock-dashboard.<your-domain>
COGNITO_REGION=ap-northeast-2
COGNITO_USER_POOL_ID=ap-northeast-2_xxxxxxxxx
COGNITO_CLIENT_ID=xxxxxxxxxxxxxxxxxxxxxxxxxx
EMAIL=you@company.com

# 선택
AWS_PROFILE_NAME=cc-bedrock
AWS_REGION=ap-northeast-2

# 모델 매핑 (Opus는 최신인 4.8로 두는 것을 권장)
ANTHROPIC_DEFAULT_SONNET_MODEL=global.anthropic.claude-sonnet-5
ANTHROPIC_DEFAULT_OPUS_MODEL=global.anthropic.claude-opus-4-8
ANTHROPIC_DEFAULT_HAIKU_MODEL=global.anthropic.claude-haiku-4-5-20251001-v1:0
CLAUDE_CODE_SUBAGENT_MODEL=global.anthropic.claude-sonnet-5`}
      </CodeBlock>

      <H3>{t("2.3 하루 사용 흐름", "2.3 Daily workflow")}</H3>
      <CodeBlock lang="bash">
{`cc-bedrock-local login        # 비밀번호 → Cognito 인증
cc-bedrock-local claude       # 자동 refresh + claude 실행
cc-bedrock-local status       # 잔여 TTL + Deny 상태
cc-bedrock-local logout       # 토큰 캐시 삭제`}
      </CodeBlock>

      <H3>{t("2.4 서브커맨드 레퍼런스", "2.4 Subcommand reference")}</H3>
      <Table
        columns={[
          { key: "cmd", label: t("명령", "Command") },
          { key: "act", label: t("동작", "Action") },
        ]}
        rows={[
          { cmd: <Code>login</Code>, act: t("비밀번호 → Cognito → 1h STS + refresh token", "Password → Cognito → 1h STS + refresh") },
          { cmd: <Code>refresh</Code>, act: t("캐시된 refresh token으로 silent 재발급", "Silent refresh with cached token") },
          { cmd: <Code>logout</Code>, act: t("refresh + state 캐시 삭제", "Clear refresh + state cache") },
          { cmd: <Code>status</Code>, act: t("남은 TTL + 활성 Deny / 한도 상태", "Remaining TTL + Deny / limit state") },
          { cmd: <Code>claude [args]</Code>, act: t("세션 확보 + 모델 env 주입 후 claude 실행", "Ensure session + model env, then run claude") },
          { cmd: <Code>set-model K=V</Code>, act: t("sonnet / opus / haiku / subagent / pin 별칭으로 모델 ID 교체", "Replace model ID via alias") },
          { cmd: <Code>models</Code>, act: t("현재 모델 매핑 + 추천 ID", "Current mapping + suggested IDs") },
          { cmd: <Code>run -- {"<cmd>"}</Code>, act: t("자격증명만 확보 후 임의 명령 실행", "Refresh creds then exec any command") },
          { cmd: <Code>config</Code>, act: t("현재 설정 + 경로", "Print config + paths") },
        ]}
      />

      <H2 id="local-page">{t("3. Dashboard /local 페이지", "3. Dashboard /local page")}</H2>
      <P>{t("CLI 없이 브라우저에서 직접 자격증명 발급:", "Issue credentials in the browser without the CLI:")}</P>

      <H3>{t("3.1 첫 진입 화면", "3.1 Initial view")}</H3>
      <div className="rounded-lg overflow-hidden border border-navy-600 mb-5">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={asset("/img/local-page.png")} alt={t("/local 초기 화면", "/local initial view")} width={1440} height={900} className="w-full h-auto" />
      </div>

      <H3>{t("3.2 자격증명 발급 후", "3.2 After Get credentials")}</H3>
      <div className="rounded-lg overflow-hidden border border-navy-600 mb-5">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={asset("/img/local-page-with-creds.png")} alt={t("/local 자격증명 발급 후", "/local with credentials")} width={1440} height={900} className="w-full h-auto" />
      </div>

      <Callout type="warn" title={t("만료 시간이 1시간인 이유", "Why credentials expire in 1 hour")}>
        {t(
          "AWS role chaining(한 role이 다른 role을 AssumeRole)은 어떤 설정에도 관계없이 세션을 최대 1시간으로 제한. CLI는 잔여 10분 미만이면 자동 refresh.",
          "AWS role-chaining limits chained AssumeRole to a hard 1-hour cap. CLI auto-refreshes when TTL < 10 min."
        )}
      </Callout>

      <H2 id="token-usage">{t("4. 토큰 사용량 위치", "4. Where token usage shows")}</H2>
      <Table
        columns={[
          { key: "page", label: t("페이지", "Page") },
          { key: "who", label: t("누가", "Audience") },
          { key: "what", label: t("내용", "Content") },
        ]}
        rows={[
          { page: <Code>/local</Code>, who: t("본인", "Self"), what: t("본인 + 부서 normalized token, Deny 상태", "Self + dept normalized tokens, Deny state") },
          { page: <Code>/user</Code>, who: t("본인", "Self"), what: t("일일 토큰 사용량 카드 (EC2 모드 포함)", "Daily token usage card") },
          { page: <Code>/dept</Code>, who: t("부서 관리자", "Dept mgr"), what: t("멤버별 분포 + 부서 예산", "Per-member distribution + budget") },
          { page: <Code>/admin/tokens</Code>, who: "Admin", what: t("1d/7d/30d 차트 + top users + 부서별 분해", "1d/7d/30d charts + top users + dept breakdown") },
          { page: <Code>/analytics</Code>, who: "Admin", what: t("모델 비율 + 비용 트렌드 + 리더보드", "Model ratio + cost trend + leaderboard") },
          { page: <Code>/monitoring</Code>, who: "Admin", what: t("실시간 세션 + Bedrock 호출", "Live sessions + Bedrock calls") },
        ]}
      />

      <H3>{t("Admin Token Dashboard", "Admin Token Dashboard")} <Code>/admin/tokens</Code></H3>
      <div className="rounded-lg overflow-hidden border border-navy-600 mb-5">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={asset("/img/local-admin-tokens.png")} alt="/admin/tokens" width={1440} height={900} className="w-full h-auto" />
      </div>

      <H3>{t("Normalized 토큰 가중치", "Normalized token weights")}</H3>
      <div className="grid grid-cols-3 gap-3 mb-6">
        {[
          { name: "Haiku 4.5", weight: "1×", color: "from-accent-green/30 to-accent-green/5", text: "text-accent-green" },
          { name: "Sonnet 5", weight: "~3.5×", color: "from-accent-cyan/30 to-accent-cyan/5", text: "text-accent-cyan" },
          { name: "Opus 4.8", weight: "~15×", color: "from-accent-purple/30 to-accent-purple/5", text: "text-accent-purple" },
        ].map((m) => (
          <div key={m.name} className={`rounded-xl border border-navy-600 bg-gradient-to-br ${m.color} p-5`}>
            <div className={`text-2xl font-black mb-1 ${m.text}`}>{m.weight}</div>
            <div className="text-xs font-bold text-white">{m.name}</div>
          </div>
        ))}
      </div>

      <H2 id="admin">{t("5. Admin 컨트롤", "5. Admin controls")}</H2>
      <H3><Code>/admin/limits</Code> — {t("한도 CRUD", "limit CRUD")}</H3>
      <div className="rounded-lg overflow-hidden border border-navy-600 mb-5">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={asset("/img/local-admin-limits.png")} alt="/admin/limits" width={1440} height={900} className="w-full h-auto" />
      </div>
      <CodeBlock title="API">
{`GET    /api/admin/limits           — list active limits
POST   /api/admin/limits           — upsert (entity, key, period, maxNormalized)
DELETE /api/admin/limits?entity=USER&key=...&period=daily
POST   /api/admin/limits/reset     — force-reset + detach Deny policy`}
      </CodeBlock>

      <H2 id="troubleshooting">{t("6. 트러블슈팅", "6. Troubleshooting")}</H2>
      {[
        {
          s: t("login이 NotAuthorizedException으로 실패", "login fails with NotAuthorizedException"),
          c: t("USER_PASSWORD_AUTH 미허용 App Client 또는 비밀번호 강제 변경 상태", "App Client without USER_PASSWORD_AUTH or force-reset password"),
          f: t("브라우저 /login으로 1회 통과 후 cc-bedrock-local login", "Sign in via /login once, then retry"),
        },
        {
          s: t("refresh 실패", "refresh fails"),
          c: t("refresh token TTL 만료 (보통 30일)", "refresh token TTL expired (~30 days)"),
          f: <><Code>cc-bedrock-local login</Code></>,
        },
        {
          s: t("claude가 AccessDeniedException", "claude returns AccessDeniedException"),
          c: t("활성 Deny / 자격증명 만료 / 모델 ID 정책 누락", "Active Deny / expired creds / model ID missing in policy"),
          f: <><Code>cc-bedrock-local status</Code> {t("로 확인 → reset 요청 또는 refresh", "→ ask admin reset or refresh")}</>,
        },
        {
          s: t('/model 픽커에 "Custom"만 보임', 'Only "Custom" in /model picker'),
          c: <><Code>ANTHROPIC_MODEL</Code> {t("이 config에 세팅됨", "is set in config")}</>,
          f: <Code>cc-bedrock-local set-model pin=</Code>,
        },
        {
          s: "ValidationException: invalid model identifier",
          c: t("region에 모델 미활성", "Model not enabled in region"),
          f: <><Code>aws bedrock list-inference-profiles</Code> {t("로 활성 ID 확인 후 set-model", "to list active IDs, then set-model")}</>,
        },
      ].map((tip, i) => (
        <div key={i} className="rounded-lg border border-navy-600 bg-navy-800/40 p-4 mb-3">
          <div className="text-sm font-bold text-white mb-2">{tip.s}</div>
          <div className="text-xs text-gray-500 mb-1">
            <span className="text-accent-red font-semibold">{t("원인", "Cause")}:</span> {tip.c}
          </div>
          <div className="text-xs text-gray-400">
            <span className="text-accent-green font-semibold">{t("조치", "Fix")}:</span> {tip.f}
          </div>
        </div>
      ))}

      <H2 id="compare">{t("7. EC2 모드와의 차이", "7. Compared with EC2 mode")}</H2>
      <Table
        columns={[
          { key: "item", label: t("항목", "Item") },
          { key: "ec2", label: "EC2 DevEnv" },
          { key: "local", label: "Local Governance" },
        ]}
        rows={[
          { item: t("PC 환경", "PC env"), ec2: "code-server (browser)", local: t("본인 IDE/터미널", "Your own IDE/terminal") },
          { item: t("컴퓨팅", "Compute"), ec2: "EC2 t4g.large", local: t("본인 PC", "Your own PC") },
          { item: t("저장소", "Storage"), ec2: "EBS 40–100 GB", local: t("본인 PC 디스크", "Your own PC disk") },
          { item: t("세션", "Session"), ec2: "Hibernation ~5s resume", local: "1h STS + auto-refresh" },
          { item: t("인프라 비용", "Infra cost"), ec2: t("EC2 + EBS 시간당", "EC2 + EBS hourly"), local: "0" },
          { item: t("거버넌스", "Governance"), ec2: t("동일", "Same"), local: t("동일", "Same") },
        ]}
      />
    </PageShell>
  );
}
