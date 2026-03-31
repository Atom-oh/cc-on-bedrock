"use client";

interface WelcomeOnboardingProps {
  email: string;
}

export default function WelcomeOnboarding({ email }: WelcomeOnboardingProps) {
  return (
    <div className="min-h-[60vh] flex items-center justify-center">
      <div className="max-w-lg text-center space-y-8">
        {/* Logo + Welcome */}
        <div className="space-y-4">
          <div className="w-16 h-16 mx-auto rounded-2xl bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center shadow-lg shadow-blue-500/20">
            <svg className="w-8 h-8 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
            </svg>
          </div>
          <h1 className="text-2xl font-bold text-gray-100">CC-on-Bedrock에 오신 것을 환영합니다</h1>
          <p className="text-sm text-gray-400">Welcome to your Claude Code development platform</p>
        </div>

        {/* Status */}
        <div className="bg-[#161b22] border border-yellow-500/20 rounded-xl p-6 space-y-3">
          <div className="flex items-center justify-center gap-3">
            <div className="relative flex h-3 w-3">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-yellow-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-3 w-3 bg-yellow-500" />
            </div>
            <span className="text-sm font-medium text-yellow-400">환경 준비 중</span>
          </div>
          <p className="text-sm text-gray-400">
            관리자가 개발 환경을 설정하고 있습니다.<br />
            서브도메인이 할당되면 바로 사용할 수 있습니다.
          </p>
          <p className="text-xs text-gray-600">{email}</p>
        </div>

        {/* Feature Cards */}
        <div className="grid grid-cols-3 gap-3">
          {[
            { icon: "⚡", title: "Claude Code", desc: "AI 코딩 어시스턴트" },
            { icon: "🔧", title: "code-server", desc: "브라우저 기반 VS Code" },
            { icon: "🛡️", title: "보안 격리", desc: "사용자별 독립 환경" },
          ].map((f) => (
            <div key={f.title} className="bg-[#161b22] border border-gray-800 rounded-lg p-3 text-center">
              <div className="text-2xl mb-2">{f.icon}</div>
              <p className="text-xs font-medium text-gray-300">{f.title}</p>
              <p className="text-[10px] text-gray-500 mt-0.5">{f.desc}</p>
            </div>
          ))}
        </div>

        {/* Admin Contact */}
        <p className="text-xs text-gray-600">
          문의: 관리자에게 서브도메인 할당을 요청하세요
        </p>
      </div>
    </div>
  );
}
