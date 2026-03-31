"use client";

interface FirstLaunchGuideProps {
  subdomain: string;
  onStart: () => void;
  loading?: boolean;
}

const STEPS = [
  { num: 1, icon: "🎯", title: "리소스 등급 선택", desc: "Light, Standard, Power 중 필요에 맞는 환경을 선택하세요", en: "Choose your tier" },
  { num: 2, icon: "🚀", title: "컨테이너 시작", desc: "아래 버튼을 클릭하면 개발 환경이 자동으로 준비됩니다", en: "Start your container" },
  { num: 3, icon: "💻", title: "code-server 접속", desc: "브라우저에서 VS Code 환경으로 바로 코딩을 시작할 수 있습니다", en: "Access code-server" },
  { num: 4, icon: "🤖", title: "Claude Code로 개발", desc: "AI 어시스턴트가 코딩, 디버깅, 리뷰를 도와줍니다", en: "Code with Claude" },
];

export default function FirstLaunchGuide({ subdomain, onStart, loading }: FirstLaunchGuideProps) {
  return (
    <div className="space-y-8">
      {/* Welcome Banner */}
      <div className="bg-gradient-to-r from-blue-600/10 to-purple-600/10 border border-blue-500/20 rounded-xl p-6 text-center">
        <div className="text-3xl mb-3">🎉</div>
        <h2 className="text-xl font-bold text-gray-100">개발 환경이 준비되었습니다!</h2>
        <p className="text-sm text-gray-400 mt-1">
          <span className="text-blue-400 font-mono">{subdomain}</span> 서브도메인이 할당되었습니다
        </p>
      </div>

      {/* Quick Start Steps */}
      <div className="bg-[#161b22] border border-gray-800 rounded-xl p-6">
        <h3 className="text-sm font-semibold text-gray-300 mb-4">Quick Start Guide</h3>
        <div className="space-y-4">
          {STEPS.map((step) => (
            <div key={step.num} className="flex items-start gap-4">
              <div className="w-10 h-10 rounded-xl bg-[#0d1117] border border-gray-800 flex items-center justify-center text-lg shrink-0">
                {step.icon}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-bold text-gray-600 uppercase">Step {step.num}</span>
                  <span className="text-sm font-medium text-gray-200">{step.title}</span>
                </div>
                <p className="text-xs text-gray-500 mt-0.5">{step.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* CTA */}
      <button
        onClick={onStart}
        disabled={loading}
        className="w-full py-3 bg-gradient-to-r from-blue-600 to-blue-700 hover:from-blue-500 hover:to-blue-600 disabled:from-gray-700 disabled:to-gray-700 text-white font-medium rounded-xl transition-all shadow-lg shadow-blue-500/20 hover:shadow-blue-500/30 flex items-center justify-center gap-2"
      >
        {loading ? (
          <>
            <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
            Starting...
          </>
        ) : (
          <>
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            컨테이너 시작하기
          </>
        )}
      </button>
    </div>
  );
}
