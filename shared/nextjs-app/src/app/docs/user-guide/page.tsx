"use client";

import { useI18n } from "@/lib/i18n";
import { User, Monitor, Play, Square, Clock, HardDrive, Key, Sparkles, ArrowRight } from "lucide-react";

function SectionTitle({ children, id }: { children: React.ReactNode; id?: string }) {
  return (
    <h2 id={id} className="text-xl font-bold text-white mt-10 mb-4 flex items-center gap-2 scroll-mt-8">
      <span className="w-1 h-6 bg-violet-500 rounded-full" />
      {children}
    </h2>
  );
}

function P({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-gray-400 leading-relaxed mb-3">{children}</p>;
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

function StepFlow({ steps }: { steps: { icon: any; title: string; desc: string }[] }) {
  return (
    <div className="space-y-2 mb-6">
      {steps.map((step, i) => {
        const Icon = step.icon;
        return (
          <div key={i} className="flex items-start gap-3">
            <div className="flex flex-col items-center">
              <div className="w-8 h-8 rounded-lg bg-violet-500/10 border border-violet-500/20 flex items-center justify-center shrink-0">
                <Icon className="w-4 h-4 text-violet-400" />
              </div>
              {i < steps.length - 1 && <div className="w-px h-6 bg-white/5 mt-1" />}
            </div>
            <div className="pt-1">
              <div className="text-sm font-bold text-white">{step.title}</div>
              <div className="text-xs text-gray-500 mt-0.5">{step.desc}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default function UserGuidePage() {
  const { locale } = useI18n();
  const ko = locale === "ko";

  return (
    <div className="max-w-4xl mx-auto">
      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-3">
          <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-violet-500 to-purple-500 flex items-center justify-center">
            <User className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-2xl font-black text-white">
              {ko ? "사용자 가이드" : "User Guide"}
            </h1>
            <p className="text-sm text-gray-500">
              {ko ? "개발환경 사용법" : "How to use your dev environment"}
            </p>
          </div>
        </div>
      </div>

      {/* Login */}
      <SectionTitle id="login">{ko ? "로그인" : "Login"}</SectionTitle>
      <P>
        {ko
          ? "대시보드(dashboard.your-domain.com)에 접속하면 Cognito Hosted UI로 자동 redirect됩니다. 이메일과 비밀번호로 로그인하세요."
          : "Accessing the dashboard (dashboard.your-domain.com) automatically redirects to Cognito Hosted UI. Log in with your email and password."}
      </P>
      <StepFlow steps={[
        {
          icon: Monitor,
          title: ko ? "대시보드 접속" : "Access Dashboard",
          desc: ko ? "https://dashboard.your-domain.com 접속" : "Navigate to https://dashboard.your-domain.com",
        },
        {
          icon: Key,
          title: ko ? "Cognito 로그인" : "Cognito Login",
          desc: ko ? "이메일 + 비밀번호 입력. 최초 로그인 시 비밀번호 변경 필요." : "Enter email + password. First login requires password change.",
        },
        {
          icon: User,
          title: ko ? "대시보드 진입" : "Enter Dashboard",
          desc: ko ? "'내 환경' 탭에서 개발환경 관리. 사이드바에서 다른 기능 접근." : "Manage dev env in 'My Environment' tab. Access other features from sidebar.",
        },
      ]} />

      {/* Start Environment */}
      <SectionTitle id="start">{ko ? "개발환경 시작" : "Start Dev Environment"}</SectionTitle>
      <P>
        {ko
          ? "'내 환경' 페이지에서 인스턴스를 시작합니다. 첫 시작 시 AMI에서 새 EC2 인스턴스를 생성하고, 이후에는 기존 인스턴스를 Start합니다."
          : "Start your instance from 'My Environment' page. First start creates a new EC2 from AMI; subsequent starts resume the existing instance."}
      </P>

      <div className="rounded-xl bg-[#0d1117] border border-white/5 p-5 mb-4">
        <h3 className="text-sm font-bold text-white mb-4">{ko ? "프로비저닝 단계 (첫 시작)" : "Provisioning Steps (First Start)"}</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          {[
            { step: 1, label: ko ? "IAM Role 생성" : "Create IAM Role", desc: "cc-on-bedrock-task-{subdomain}" },
            { step: 2, label: ko ? "보안 그룹 설정" : "Security Group Setup", desc: ko ? "DLP 정책에 따라 SG 할당" : "Assign SG based on DLP policy" },
            { step: 3, label: ko ? "EC2 인스턴스 생성" : "Create EC2 Instance", desc: ko ? "ARM64 (Graviton), EBS 30GB gp3" : "ARM64 (Graviton), 30GB gp3 EBS" },
            { step: 4, label: ko ? "비밀번호 저장" : "Store Password", desc: "Secrets Manager" },
            { step: 5, label: ko ? "라우팅 등록" : "Register Route", desc: ko ? "DynamoDB cc-routing-table" : "DynamoDB cc-routing-table" },
            { step: 6, label: ko ? "Health Check" : "Health Check", desc: ko ? "code-server 준비 확인" : "Verify code-server ready" },
          ].map((s) => (
            <div key={s.step} className="flex items-center gap-3 px-3 py-2 rounded-lg bg-white/5">
              <span className="w-6 h-6 rounded-md bg-violet-500/10 text-violet-400 text-xs font-bold flex items-center justify-center shrink-0">
                {s.step}
              </span>
              <div>
                <div className="text-xs font-bold text-white">{s.label}</div>
                <div className="text-[10px] text-gray-500">{s.desc}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="rounded-xl bg-[#0d1117] border border-amber-500/20 p-4 mb-4">
        <div className="flex items-center gap-2 mb-2">
          <Clock className="w-4 h-4 text-amber-400" />
          <span className="text-sm font-bold text-white">{ko ? "시작 시간" : "Startup Time"}</span>
        </div>
        <div className="grid grid-cols-2 gap-3 text-xs">
          <div className="px-3 py-2 rounded-lg bg-white/5">
            <div className="font-bold text-white">{ko ? "첫 시작" : "First Start"}</div>
            <div className="text-gray-500">{ko ? "2~3분 (인스턴스 생성)" : "2-3 min (instance creation)"}</div>
          </div>
          <div className="px-3 py-2 rounded-lg bg-white/5">
            <div className="font-bold text-white">{ko ? "재시작" : "Restart"}</div>
            <div className="text-gray-500">{ko ? "30~75초 (EBS 보존)" : "30-75 sec (EBS preserved)"}</div>
          </div>
        </div>
      </div>

      {/* Code Server */}
      <SectionTitle id="code-server">{ko ? "code-server 사용" : "Using code-server"}</SectionTitle>
      <P>
        {ko
          ? "인스턴스가 Running 상태가 되면 'code-server 열기' 링크가 표시됩니다. 클릭하면 브라우저에서 VS Code 환경을 사용할 수 있습니다."
          : "Once the instance is Running, a 'Open code-server' link appears. Click to access VS Code in your browser."}
      </P>

      <div className="rounded-xl bg-[#0d1117] border border-white/5 p-5 mb-4">
        <h3 className="text-sm font-bold text-white mb-3">{ko ? "접속 URL" : "Access URL"}</h3>
        <div className="flex items-center gap-2 px-4 py-3 rounded-lg bg-[#161b22] border border-white/5 font-mono text-sm text-primary-400">
          https://{"{subdomain}"}.dev.your-domain.com
        </div>
        <div className="mt-3 text-xs text-gray-500">
          {ko
            ? "Cognito 인증 후 자동으로 code-server에 접속됩니다. 비밀번호는 '내 환경 > 설정' 탭에서 확인할 수 있습니다."
            : "After Cognito auth, you'll be automatically connected to code-server. Password can be found in 'My Environment > Settings' tab."}
        </div>
      </div>

      {/* Claude Code & Kiro */}
      <SectionTitle id="ai-tools">{ko ? "Claude Code & Kiro 사용" : "Using Claude Code & Kiro"}</SectionTitle>
      <P>
        {ko
          ? "code-server 터미널에서 Claude Code와 Kiro를 바로 사용할 수 있습니다. Bedrock 접근은 Instance Profile을 통해 자동 인증됩니다."
          : "Use Claude Code and Kiro directly from the code-server terminal. Bedrock access is automatically authenticated via Instance Profile."}
      </P>

      <CodeBlock title={ko ? "Claude Code 실행" : "Run Claude Code"}>{`# Claude Code starts directly — no API key needed
# CLAUDE_CODE_USE_BEDROCK=1 is pre-configured
claude

# Or start with a specific task
claude "Explain this codebase"

# Check Bedrock connectivity
aws bedrock-runtime invoke-model --model-id anthropic.claude-sonnet-4-6-v1 \\
  --body '{"prompt":"Hi","max_tokens":10}' /dev/null`}</CodeBlock>

      <CodeBlock title={ko ? "Kiro 실행" : "Run Kiro"}>{`# Kiro is also pre-installed
kiro

# Kiro uses the same Instance Profile for Bedrock access`}</CodeBlock>

      <div className="rounded-xl bg-[#0d1117] border border-white/5 p-4 mb-4">
        <div className="flex items-center gap-2 mb-3">
          <Sparkles className="w-4 h-4 text-amber-400" />
          <span className="text-sm font-bold text-white">{ko ? "사용 가능 모델" : "Available Models"}</span>
        </div>
        <div className="grid grid-cols-2 gap-2 text-xs">
          <div className="px-3 py-2 rounded-lg bg-amber-500/5 border border-amber-500/10">
            <div className="font-bold text-white">Claude Opus 4.6</div>
            <div className="text-gray-500">{ko ? "최고 성능, 복잡한 작업" : "Highest performance, complex tasks"}</div>
          </div>
          <div className="px-3 py-2 rounded-lg bg-blue-500/5 border border-blue-500/10">
            <div className="font-bold text-white">Claude Sonnet 4.6</div>
            <div className="text-gray-500">{ko ? "빠른 응답, 일반 개발" : "Fast response, general development"}</div>
          </div>
        </div>
      </div>

      {/* Storage */}
      <SectionTitle id="storage">{ko ? "스토리지 관리" : "Storage Management"}</SectionTitle>
      <P>
        {ko
          ? "EBS Root Volume(30GB gp3)에 모든 데이터가 저장됩니다. 인스턴스를 중지해도 데이터가 보존됩니다 (apt, npm -g, pip 포함 모든 시스템 상태)."
          : "All data is stored on EBS Root Volume (30GB gp3). Data persists even when the instance is stopped (all system state including apt, npm -g, pip)."}
      </P>

      <div className="rounded-xl bg-[#0d1117] border border-white/5 p-4 mb-4">
        <div className="flex items-center gap-2 mb-3">
          <HardDrive className="w-4 h-4 text-primary-400" />
          <span className="text-sm font-bold text-white">{ko ? "데이터 보존 정책" : "Data Preservation Policy"}</span>
        </div>
        <div className="grid grid-cols-2 gap-2 text-xs">
          {[
            { event: ko ? "사용자 중지" : "User Stop", preserved: true },
            { event: ko ? "관리자 중지" : "Admin Stop", preserved: true },
            { event: ko ? "유휴 자동 중지" : "Idle Auto-Stop", preserved: true },
            { event: ko ? "야간 일괄 중지" : "EOD Batch Stop", preserved: true },
            { event: ko ? "인스턴스 충돌" : "Instance Crash", preserved: true },
            { event: ko ? "AZ 장애" : "AZ Failure", preserved: true, note: ko ? "Snapshot 복구" : "Snapshot recovery" },
          ].map((item) => (
            <div key={item.event} className="flex items-center justify-between px-3 py-2 rounded-lg bg-white/5">
              <span className="text-gray-400">{item.event}</span>
              <span className="text-emerald-400 font-bold">
                {item.preserved ? "Preserved" : "Lost"}
                {item.note && <span className="text-gray-500 font-normal ml-1">({item.note})</span>}
              </span>
            </div>
          ))}
        </div>
      </div>

      <P>
        {ko
          ? "디스크 사용량은 '내 환경 > 스토리지' 탭에서 확인할 수 있습니다. 용량이 부족하면 EBS 확장을 신청할 수 있습니다 (관리자 승인 필요)."
          : "Check disk usage in 'My Environment > Storage' tab. If low on space, request EBS expansion (admin approval required)."}
      </P>

      {/* Stop & Idle */}
      <SectionTitle id="stop">{ko ? "중지 및 유휴 정책" : "Stop & Idle Policy"}</SectionTitle>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4">
        <div className="rounded-xl bg-[#0d1117] border border-white/5 p-4">
          <div className="flex items-center gap-2 mb-2">
            <Square className="w-4 h-4 text-rose-400" />
            <span className="text-xs font-bold text-white">{ko ? "수동 중지" : "Manual Stop"}</span>
          </div>
          <div className="text-xs text-gray-500">
            {ko ? "'내 환경'에서 '인스턴스 중지' 클릭" : "Click 'Stop Instance' in 'My Environment'"}
          </div>
        </div>
        <div className="rounded-xl bg-[#0d1117] border border-white/5 p-4">
          <div className="flex items-center gap-2 mb-2">
            <Clock className="w-4 h-4 text-amber-400" />
            <span className="text-xs font-bold text-white">{ko ? "유휴 자동 중지" : "Idle Auto-Stop"}</span>
          </div>
          <div className="text-xs text-gray-500">
            {ko ? "45분 비활동 시 자동 중지 (30분 경고)" : "Auto-stop after 45min idle (30min warning)"}
          </div>
        </div>
        <div className="rounded-xl bg-[#0d1117] border border-white/5 p-4">
          <div className="flex items-center gap-2 mb-2">
            <Play className="w-4 h-4 text-emerald-400" />
            <span className="text-xs font-bold text-white">Keep-Alive</span>
          </div>
          <div className="text-xs text-gray-500">
            {ko ? "'스토리지' 탭에서 자동 중지 일시 보류" : "Pause auto-stop from 'Storage' tab"}
          </div>
        </div>
      </div>

      {/* Resource Tiers */}
      <SectionTitle id="tiers">{ko ? "리소스 등급" : "Resource Tiers"}</SectionTitle>
      <div className="rounded-xl bg-[#0d1117] border border-white/5 overflow-hidden mb-4">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-white/5 bg-[#161b22]">
              <th className="text-left px-4 py-3 font-bold text-gray-400">{ko ? "등급" : "Tier"}</th>
              <th className="text-left px-4 py-3 font-bold text-gray-400">vCPU</th>
              <th className="text-left px-4 py-3 font-bold text-gray-400">Memory</th>
              <th className="text-left px-4 py-3 font-bold text-gray-400">{ko ? "용도" : "Use Case"}</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-white/5">
              <td className="px-4 py-3 font-bold text-white">Light</td>
              <td className="px-4 py-3 text-gray-400">1</td>
              <td className="px-4 py-3 text-gray-400">4 GiB</td>
              <td className="px-4 py-3 text-gray-500">{ko ? "학습, 간단한 작업" : "Learning, simple tasks"}</td>
            </tr>
            <tr className="border-b border-white/5">
              <td className="px-4 py-3 font-bold text-white">Standard</td>
              <td className="px-4 py-3 text-gray-400">2</td>
              <td className="px-4 py-3 text-gray-400">8 GiB</td>
              <td className="px-4 py-3 text-gray-500">{ko ? "일반 개발" : "General development"}</td>
            </tr>
            <tr>
              <td className="px-4 py-3 font-bold text-white">Power</td>
              <td className="px-4 py-3 text-gray-400">4</td>
              <td className="px-4 py-3 text-gray-400">12 GiB</td>
              <td className="px-4 py-3 text-gray-500">{ko ? "대규모 빌드, 복잡한 작업" : "Heavy builds, complex tasks"}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <P>
        {ko
          ? "리소스 등급 변경은 '내 환경' 페이지에서 신청할 수 있으며, 관리자 승인이 필요합니다."
          : "Resource tier changes can be requested from 'My Environment' page and require admin approval."}
      </P>
    </div>
  );
}
