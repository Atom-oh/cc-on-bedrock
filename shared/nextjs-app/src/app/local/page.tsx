"use client";

import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";

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

export default function LocalGovernancePage() {
  const { data: session, status } = useSession();
  const [creds, setCreds] = useState<CredentialsResponse | null>(null);
  const [usage, setUsage] = useState<UsageResponse | null>(null);
  const [loadingCreds, setLoadingCreds] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const refreshUsage = async () => {
    try {
      const r = await fetch("/api/local/limits", { cache: "no-store" });
      if (r.ok) setUsage(await r.json());
    } catch (e) {
      console.error(e);
    }
  };

  useEffect(() => {
    if (status === "authenticated") void refreshUsage();
  }, [status]);

  const fetchCreds = async () => {
    setError(null);
    setLoadingCreds(true);
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
      setLoadingCreds(false);
    }
  };

  const copy = async (text: string, label: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(null), 1500);
  };

  if (status === "loading") return <div className="p-8">Loading…</div>;
  if (status !== "authenticated") return <div className="p-8">Sign in required.</div>;

  return (
    <div className="p-8 max-w-4xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Local Governance Mode</h1>
        <p className="text-sm text-gray-600 mt-1">
          Use Claude Code from your local machine against Amazon Bedrock under governed
          per-user STS credentials (8-hour TTL). Token usage and limits are enforced via{" "}
          <code>cc-on-bedrock-local-user-*</code> IAM roles.
        </p>
      </header>

      {/* Deny banner */}
      {usage?.denyActive && (
        <div className="rounded border border-red-300 bg-red-50 p-4 text-sm">
          <div className="font-semibold text-red-700">
            Bedrock access is blocked ({usage.denyActive.period})
          </div>
          <div className="text-red-700">{usage.denyActive.reason}</div>
          <div className="text-red-700">
            Resets at {usage.denyActive.resetAt} (in {formatRemaining(usage.denyActive.resetAt)})
          </div>
        </div>
      )}

      {/* Get credentials */}
      <section className="border rounded p-4 bg-white">
        <h2 className="text-lg font-medium mb-2">Get Bedrock credentials</h2>
        <button
          onClick={fetchCreds}
          disabled={loadingCreds}
          className="px-4 py-2 rounded bg-blue-600 text-white text-sm disabled:opacity-50"
        >
          {loadingCreds ? "Issuing…" : creds ? "Refresh credentials" : "Get credentials"}
        </button>
        {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
        {creds && (
          <div className="mt-4 space-y-3 text-sm">
            <div>
              <div className="text-gray-500">Expires</div>
              <div>
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
                  className="text-xs text-blue-600"
                >
                  {copied === "profile" ? "✓ Copied" : "Copy"}
                </button>
              </div>
              <pre className="mt-1 p-3 bg-gray-50 border rounded text-xs overflow-auto">
                {creds.profileSnippet}
              </pre>
            </div>
            <div>
              <div className="flex justify-between items-center">
                <span className="text-gray-500">Shell environment</span>
                <button
                  onClick={() => copy(creds.envSnippet, "env")}
                  className="text-xs text-blue-600"
                >
                  {copied === "env" ? "✓ Copied" : "Copy"}
                </button>
              </div>
              <pre className="mt-1 p-3 bg-gray-50 border rounded text-xs overflow-auto">
                {creds.envSnippet}
              </pre>
            </div>
            <div className="text-gray-500">
              Role: <code>{creds.roleArn}</code>
            </div>
          </div>
        )}
      </section>

      {/* Usage gauges */}
      <section className="border rounded p-4 bg-white">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-medium">Normalized token usage</h2>
          <button onClick={refreshUsage} className="text-xs text-blue-600">
            Refresh
          </button>
        </div>
        {!usage && <div className="text-sm text-gray-500">Loading…</div>}
        {usage && (
          <div className="space-y-3">
            {usage.summary.map((s) => (
              <div key={s.period}>
                <div className="flex items-baseline justify-between text-xs text-gray-500">
                  <span className="uppercase tracking-wide font-medium text-gray-700">
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
                  <div className="h-2 bg-gray-100 rounded overflow-hidden">
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
                  <div className="h-2 bg-gray-100 rounded overflow-hidden">
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
          </div>
        )}
      </section>

      {/* CLI helper download */}
      <section className="border rounded p-4 bg-white">
        <h2 className="text-lg font-medium mb-2">CLI helper</h2>
        <p className="text-sm text-gray-600 mb-2">
          Download <code>cc-bedrock-local.sh</code> to refresh credentials and run{" "}
          <code>claude</code> with the right environment.
        </p>
        <pre className="p-3 bg-gray-50 border rounded text-xs overflow-auto">
{`# one-time setup
curl -fsSL ${typeof window !== "undefined" ? window.location.origin : ""}/tools/cc-bedrock-local.sh \\
  -o /usr/local/bin/cc-bedrock-local
chmod +x /usr/local/bin/cc-bedrock-local

# configure
mkdir -p ~/.config/cc-bedrock
cat > ~/.config/cc-bedrock/config <<EOF
DASHBOARD_URL=${typeof window !== "undefined" ? window.location.origin : "https://dashboard.example.com"}
CC_BEDROCK_TOKEN=<paste the CLI token from the Dashboard>
AWS_PROFILE_NAME=cc-bedrock
AWS_REGION=ap-northeast-2
EOF

# use it
cc-bedrock-local refresh
cc-bedrock-local run -- claude`}
        </pre>
      </section>
    </div>
  );
}
