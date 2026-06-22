"use client";

import { useEffect, useState } from "react";

// ADR-014: Local Governance Mode usage panel inside the user portal (/user tab).
// Mirrors /local page but embedded as a tab — for users who log in via Cognito
// on the dashboard and run Claude Code locally against Bedrock.

type CredentialsResponse = {
  credentials: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken: string;
    expiration: string;
  };
  profileSnippet: string;
  envSnippet: string;
  region: string;
  roleArn: string;
  inferenceProfileArn?: string;
  limitStatus?: {
    denyActive: boolean;
    denyReason?: string;
    resetAt?: string;
    period?: string;
  };
};

type UsageResponse = {
  sub: string;
  department: string;
  summary: Array<{
    period: "daily" | "weekly" | "monthly";
    userUsed: number;
    userLimit: number;
    deptUsed: number;
    deptLimit: number;
    resetAt: string | null;
  }>;
  denyActive: { reason?: string; resetAt?: string; period?: string } | null;
};

function pct(used: number, max: number): number {
  if (!max || max <= 0) return 0;
  return Math.min(100, Math.round((used / max) * 100));
}

function formatRemaining(iso: string | null | undefined): string {
  if (!iso) return "—";
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "now";
  const h = Math.floor(ms / 3600_000);
  const m = Math.floor((ms % 3600_000) / 60_000);
  if (h > 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  return `${h}h ${m}m`;
}

export default function LocalModeTab() {
  const [creds, setCreds] = useState<CredentialsResponse | null>(null);
  const [usage, setUsage] = useState<UsageResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const dashboardOrigin = typeof window !== "undefined" ? window.location.origin : "";
  const installCommand = `curl -fsSL ${dashboardOrigin || "https://dashboard.example.com"}/api/install | bash`;

  const refreshUsage = async () => {
    try {
      const r = await fetch("/api/local/limits", { cache: "no-store" });
      if (r.ok) setUsage(await r.json());
    } catch (e) {
      console.error(e);
    }
  };

  useEffect(() => {
    void refreshUsage();
  }, []);

  const fetchCreds = async () => {
    setError(null);
    setLoading(true);
    try {
      const r = await fetch("/api/local/credentials", { method: "POST" });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error ?? `request failed (${r.status})`);
      }
      setCreds(await r.json());
      void refreshUsage();
    } catch (e) {
      setError(e instanceof Error ? e.message : "unknown error");
    } finally {
      setLoading(false);
    }
  };

  const copy = async (text: string, label: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(null), 1500);
  };

  return (
    <div className="space-y-4">
      <header className="text-sm text-gray-400">
        Claude Code를 로컬 PC에서 Bedrock 직접 호출로 사용하기 위한 1h STS 자격증명, 자동 갱신 CLI, 사용량, 한도 상태입니다.
        (ADR-014 Local Governance Mode)
      </header>

      {/* Deny banner */}
      {usage?.denyActive && (
        <div className="rounded border border-red-500/40 bg-red-500/10 p-4 text-sm">
          <div className="font-semibold text-red-400">
            Bedrock 호출이 차단되어 있습니다 ({usage.denyActive.period})
          </div>
          <div className="text-red-300">{usage.denyActive.reason}</div>
          <div className="text-red-300">
            Reset: {usage.denyActive.resetAt} ({formatRemaining(usage.denyActive.resetAt)} 후)
          </div>
        </div>
      )}

      {/* Get credentials */}
      <section className="border border-gray-800 rounded p-4 bg-gray-900/50">
        <h3 className="text-base font-medium text-gray-200 mb-3">Bedrock 자격증명 발급</h3>
        <button
          onClick={fetchCreds}
          disabled={loading}
          className="px-4 py-2 rounded bg-blue-600 hover:bg-blue-500 text-white text-sm disabled:opacity-50"
        >
          {loading ? "Issuing…" : creds ? "Refresh one-hour credentials" : "Get one-hour credentials"}
        </button>
        {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
        {creds && (
          <div className="mt-4 space-y-3 text-sm">
            <div>
              <div className="text-gray-500">Expires</div>
              <div className="text-gray-200">
                {creds.credentials.expiration}{" "}
                <span className="text-gray-500">
                  (in {formatRemaining(creds.credentials.expiration)})
                </span>
              </div>
            </div>
            <div>
              <div className="flex justify-between items-center">
                <span className="text-gray-500">~/.aws/credentials snippet</span>
                <button
                  onClick={() => copy(creds.profileSnippet, "profile")}
                  className="text-xs text-blue-400 hover:text-blue-300"
                >
                  {copied === "profile" ? "✓ Copied" : "Copy"}
                </button>
              </div>
              <pre className="mt-1 p-3 bg-black/30 border border-gray-800 rounded text-xs overflow-auto text-gray-300">
                {creds.profileSnippet}
              </pre>
            </div>
            <div>
              <div className="flex justify-between items-center">
                <span className="text-gray-500">Shell environment</span>
                <button
                  onClick={() => copy(creds.envSnippet, "env")}
                  className="text-xs text-blue-400 hover:text-blue-300"
                >
                  {copied === "env" ? "✓ Copied" : "Copy"}
                </button>
              </div>
              <pre className="mt-1 p-3 bg-black/30 border border-gray-800 rounded text-xs overflow-auto text-gray-300">
                {creds.envSnippet}
              </pre>
            </div>
            <div className="text-xs text-gray-500">
              Role: <code className="text-gray-400">{creds.roleArn}</code>
            </div>
          </div>
        )}
      </section>

      {/* Usage gauges */}
      <section className="border border-gray-800 rounded p-4 bg-gray-900/50">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-base font-medium text-gray-200">Normalized token 사용량</h3>
          <button onClick={refreshUsage} className="text-xs text-blue-400 hover:text-blue-300">
            Refresh
          </button>
        </div>
        {!usage && <div className="text-sm text-gray-500">Loading…</div>}
        {usage && (
          <div className="space-y-3">
            {usage.summary.map((s) => (
              <div key={s.period}>
                <div className="flex items-baseline justify-between text-xs text-gray-500">
                  <span className="uppercase tracking-wide font-medium text-gray-300">
                    {s.period}
                  </span>
                  <span>
                    user {Math.round(s.userUsed).toLocaleString()} /{" "}
                    {s.userLimit ? Math.round(s.userLimit).toLocaleString() : "∞"}
                    {" · "}
                    dept {Math.round(s.deptUsed).toLocaleString()} /{" "}
                    {s.deptLimit ? Math.round(s.deptLimit).toLocaleString() : "∞"}
                    {" · "}
                    resets in {formatRemaining(s.resetAt)}
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-2 mt-1">
                  <div className="h-2 bg-gray-800 rounded overflow-hidden">
                    <div
                      style={{ width: `${pct(s.userUsed, s.userLimit)}%` }}
                      className={`h-2 ${
                        pct(s.userUsed, s.userLimit) >= 95
                          ? "bg-red-500"
                          : pct(s.userUsed, s.userLimit) >= 80
                          ? "bg-yellow-500"
                          : "bg-emerald-500"
                      }`}
                    />
                  </div>
                  <div className="h-2 bg-gray-800 rounded overflow-hidden">
                    <div
                      style={{ width: `${pct(s.deptUsed, s.deptLimit)}%` }}
                      className={`h-2 ${
                        pct(s.deptUsed, s.deptLimit) >= 95
                          ? "bg-red-500"
                          : pct(s.deptUsed, s.deptLimit) >= 80
                          ? "bg-yellow-500"
                          : "bg-emerald-500"
                      }`}
                    />
                  </div>
                </div>
              </div>
            ))}
            <div className="text-xs text-gray-500 mt-2">
              왼쪽 막대: 본인 한도, 오른쪽 막대: 부서 한도. ∞ 표시는 한도 미설정 상태입니다.
            </div>
          </div>
        )}
      </section>

      {/* Local Bedrock CLI — Cognito login + credential_process auto-renew */}
      <section className="border border-gray-800 rounded p-4 bg-gray-900/50">
        <div className="flex items-start justify-between gap-3 mb-2">
          <div>
            <h3 className="text-base font-medium text-gray-200">Local Bedrock CLI</h3>
            <p className="text-sm text-gray-500 mt-1">
              설치 후 Cognito로 로그인하면 <code className="text-gray-400">~/.aws/config</code>에{" "}
              <code className="text-gray-400">credential_process</code>가 등록됩니다. Claude Code 세션 중에도
              AWS SDK가 1h STS 만료 전에 자동으로 다시 발급받습니다.
            </p>
          </div>
          <button
            onClick={() => copy(installCommand, "install")}
            className="px-3 py-2 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium disabled:opacity-50 whitespace-nowrap"
          >
            {copied === "install" ? "Copied" : "Copy install"}
          </button>
        </div>
        <pre className="mt-3 p-3 bg-black/40 border border-gray-800 rounded overflow-auto text-xs text-gray-300">
          {installCommand}
        </pre>
        <div className="mt-3 text-xs text-gray-500 space-y-1">
          <div>
            설치 후 <code className="text-gray-300">cc</code>를 실행하면 Cognito 비밀번호를 묻고 Claude Code를 Bedrock 모드로 실행합니다.
          </div>
          <div>
            상태 확인: <code className="text-gray-300">cc --status</code> · 로그아웃:{" "}
            <code className="text-gray-300">cc --logout</code>
          </div>
        </div>
      </section>
    </div>
  );
}
