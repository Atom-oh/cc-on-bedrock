"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import type { UserSession, ContainerInfo } from "@/lib/types";
import {
  validateIamRequest,
  DEFAULT_SERVICE_ALLOWLIST,
  DEFAULT_WILDCARD_OK_ACTIONS,
  type IamStatement,
} from "@/lib/iam-request-validation";

interface SettingsTabProps {
  user: UserSession;
  container: ContainerInfo | null;
}

export default function SettingsTab({ user, container }: SettingsTabProps) {
  const [currentPassword, setCurrentPassword] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordTouched, setPasswordTouched] = useState(false);
  const [passwordLoading, setPasswordLoading] = useState(false);
  const [passwordFetching, setPasswordFetching] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const autoHideRef = useRef<NodeJS.Timeout | null>(null);

  // ─── Exposed ports (custom routes, ADR-027) ───
  type RouteRow = { path: string; port: number; label: string };
  const [routes, setRoutes] = useState<RouteRow[]>([]);
  const [routeStatus, setRouteStatus] = useState<{ path: string; state: string; reason?: string }[]>([]);
  const [routesSaving, setRoutesSaving] = useState(false);
  const [routesError, setRoutesError] = useState<string | null>(null);
  const [routesPending, setRoutesPending] = useState(false);
  const [routesVersion, setRoutesVersion] = useState<number>(0);

  const domainName = process.env.NEXT_PUBLIC_DOMAIN_NAME ?? "atomai.click";
  const devSubdomain = process.env.NEXT_PUBLIC_DEV_SUBDOMAIN ?? "dev";
  const codeServerUrl = user.subdomain
    ? `https://${user.subdomain}.${devSubdomain}.${domainName}`
    : null;

  // Load custom routes (also re-used after save to refresh routeStatus + version)
  const loadRoutes = useCallback(async () => {
    try {
      const res = await fetch("/api/user/custom-routes");
      const d = await res.json();
      if (d.success) {
        setRoutes(d.data.routes ?? []);
        setRouteStatus(d.data.status ?? []);
        setRoutesVersion(d.data.version ?? 0);
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { loadRoutes(); }, [loadRoutes]);

  const saveRoutes = async () => {
    setRoutesSaving(true);
    setRoutesError(null);
    try {
      const res = await fetch("/api/user/custom-routes", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        // M3: echo the loaded version so a stale-tab save is rejected (409) not silently lost.
        body: JSON.stringify({ routes, version: routesVersion }),
      });
      const d = await res.json();
      if (!res.ok || !d.success) {
        setRoutesError(res.status === 409 ? (d.error ?? "동시 수정 충돌 — 새로고침하세요") : (d.error ?? "저장 실패"));
        if (res.status === 409) await loadRoutes(); // refresh to latest
        return;
      }
      setRoutesPending(d.data.pending === true);
      await loadRoutes(); // MINOR: refresh routeStatus (✅/⚠️) + new version after save
    } finally {
      setRoutesSaving(false);
    }
  };

  const addRoute = () => {
    if (routes.length >= 5) return;
    setRoutes([...routes, { path: "/preview", port: 5173, label: "App" }]);
  };
  const removeRoute = (i: number) => setRoutes(routes.filter((_, idx) => idx !== i));
  const updateRoute = (i: number, patch: Partial<RouteRow>) =>
    setRoutes(routes.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

  // Fetch current code-server password
  useEffect(() => {
    const fetchPassword = async () => {
      try {
        const res = await fetch("/api/user/password");
        if (res.ok) {
          const data = await res.json();
          if (data.success) setCurrentPassword(data.data.password);
        }
      } catch { /* ignore */ }
      finally { setPasswordFetching(false); }
    };
    fetchPassword();
  }, []);

  // Auto-hide password after 10 seconds
  useEffect(() => {
    if (showPassword) {
      if (autoHideRef.current) clearTimeout(autoHideRef.current);
      autoHideRef.current = setTimeout(() => setShowPassword(false), 10000);
    }
    return () => { if (autoHideRef.current) clearTimeout(autoHideRef.current); };
  }, [showPassword]);

  // Clear password state on unmount (tab switch)
  useEffect(() => {
    return () => {
      setShowPassword(false);
    };
  }, []);

  const validatePassword = (pw: string): string | null => {
    if (pw.length < 8) return "Password must be at least 8 characters";
    if (!/[A-Z]/.test(pw)) return "Must contain an uppercase letter";
    if (!/[0-9]/.test(pw)) return "Must contain a number";
    if (!/[^A-Za-z0-9]/.test(pw)) return "Must contain a special character";
    return null;
  };

  const handleCopyPassword = useCallback(() => {
    if (!currentPassword) return;
    navigator.clipboard.writeText(currentPassword);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [currentPassword]);

  const handleChangePassword = async () => {
    setError(null);
    setSuccess(null);

    const validationError = validatePassword(newPassword);
    if (validationError) {
      setError(validationError);
      return;
    }

    if (newPassword !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }

    setPasswordLoading(true);
    try {
      const res = await fetch("/api/user/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newPassword }),
      });
      const data = await res.json();
      if (data.success) {
        setSuccess(data.message ?? "Password changed successfully");
        setCurrentPassword(newPassword);
        setNewPassword("");
        setConfirmPassword("");
        setPasswordTouched(false);
      } else {
        setError(data.error ?? "Failed to change password");
      }
    } catch {
      setError("Failed to change password");
    } finally {
      setPasswordLoading(false);
    }
  };

  const isRunning = container?.status === "RUNNING";
  const showValidation = passwordTouched && newPassword.length >= 8;
  const validationError = validatePassword(newPassword);

  return (
    <div className="space-y-6">
      {error && (
        <div className="bg-red-900/30 border border-red-500/30 text-red-400 px-4 py-3 rounded-lg animate-fade-in" role="alert" aria-live="polite">
          {error}
        </div>
      )}
      {success && (
        <div className="bg-green-900/30 border border-green-500/30 text-green-400 px-4 py-3 rounded-lg animate-fade-in" role="status" aria-live="polite">
          {success}
        </div>
      )}

      {/* Password Management */}
      <div className="bg-[#161b22] rounded-xl border border-gray-800 p-6">
        <h2 className="text-lg font-semibold text-gray-100 mb-4">Code-Server Password</h2>

        {/* Current Password Display */}
        <div className="bg-[#0d1117] rounded-lg p-4 mb-4">
          <p className="text-xs text-gray-500 mb-2" id="current-pw-label">Current Password</p>
          <div className="flex items-center gap-2">
            {passwordFetching ? (
              <span className="text-sm text-gray-500">Loading...</span>
            ) : currentPassword ? (
              <>
                <code className="text-sm text-gray-200 font-mono bg-gray-800 px-2 py-1 rounded" aria-labelledby="current-pw-label">
                  {showPassword ? currentPassword : "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022"}
                </code>
                <button
                  onClick={() => setShowPassword(!showPassword)}
                  className="p-1.5 text-gray-400 hover:text-gray-200 rounded hover:bg-gray-800 transition-colors"
                  aria-label={showPassword ? "Hide password" : "Show password"}
                >
                  {showPassword ? (
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                    </svg>
                  ) : (
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                    </svg>
                  )}
                </button>
                <button
                  onClick={handleCopyPassword}
                  className="p-1.5 text-gray-400 hover:text-gray-200 rounded hover:bg-gray-800 transition-colors"
                  aria-label="Copy password to clipboard"
                >
                  {copied ? (
                    <svg className="w-4 h-4 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                  ) : (
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                    </svg>
                  )}
                </button>
                {copied && <span className="text-xs text-green-400">Copied!</span>}
              </>
            ) : (
              <span className="text-sm text-gray-500">No password set</span>
            )}
          </div>
          {showPassword && (
            <p className="text-xs text-gray-600 mt-1">Auto-hides in 10 seconds</p>
          )}
        </div>

        {/* Change Password Form */}
        <div className="space-y-3">
          {isRunning && (
            <div className="bg-yellow-900/20 border border-yellow-800/30 rounded-lg px-3 py-2">
              <p className="text-xs text-yellow-400">Instance is running. New password will apply after restart.</p>
            </div>
          )}

          <div>
            <label htmlFor="new-password" className="block text-xs text-gray-500 mb-1">New Password</label>
            <input
              id="new-password"
              type="password"
              value={newPassword}
              onChange={(e) => { setNewPassword(e.target.value); if (!passwordTouched) setPasswordTouched(true); }}
              onBlur={() => setPasswordTouched(true)}
              placeholder="Min 8 chars, uppercase, number, special char"
              className="w-full bg-[#0d1117] border border-gray-700 rounded-lg p-3 text-sm text-gray-200 placeholder-gray-600 focus:border-blue-500 focus:outline-none"
              autoComplete="new-password"
            />
          </div>
          <div>
            <label htmlFor="confirm-password" className="block text-xs text-gray-500 mb-1">Confirm Password</label>
            <input
              id="confirm-password"
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Re-enter new password"
              className="w-full bg-[#0d1117] border border-gray-700 rounded-lg p-3 text-sm text-gray-200 placeholder-gray-600 focus:border-blue-500 focus:outline-none"
              autoComplete="new-password"
            />
          </div>

          {newPassword && confirmPassword && newPassword !== confirmPassword && (
            <p className="text-xs text-red-400" role="alert">Passwords do not match</p>
          )}
          {showValidation && validationError && (
            <p className="text-xs text-yellow-400">{validationError}</p>
          )}

          <button
            onClick={handleChangePassword}
            disabled={passwordLoading || !newPassword || !confirmPassword || newPassword !== confirmPassword || !!validationError}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 disabled:text-gray-500 text-white text-sm font-medium rounded-lg transition-colors"
          >
            {passwordLoading ? "Changing..." : "Change Password"}
          </button>

          <p className="text-xs text-gray-500">
            This changes both your Cognito login password and code-server password.
          </p>
        </div>
      </div>

      {/* Account Info */}
      <div className="bg-[#161b22] rounded-xl border border-gray-800 p-6">
        <h2 className="text-lg font-semibold text-gray-100 mb-4">Account Information</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <InfoField label="Email" value={user.email} />
          <InfoField label="Subdomain" value={user.subdomain ?? "-"} />
          <InfoField label="Groups" value={user.groups.join(", ") || "-"} />
          <InfoField label="Security Policy" value={user.securityPolicy ?? "restricted"} capitalize />
          <InfoField label="Resource Tier" value={user.resourceTier ?? "standard"} capitalize />
          <InfoField label="OS" value={user.containerOs === "al2023" ? "Amazon Linux 2023" : "Ubuntu 24.04"} />
          {codeServerUrl && (
            <div className="sm:col-span-2">
              <p className="text-xs text-gray-500 mb-1">VSCode URL</p>
              <a
                href={codeServerUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-blue-400 hover:text-blue-300 break-all"
              >
                {codeServerUrl}
              </a>
            </div>
          )}
        </div>
      </div>

      {/* Change Requests */}
      <div className="bg-[#161b22] rounded-xl border border-gray-800 p-6">
        <h2 className="text-lg font-semibold text-gray-100 mb-4">Change Requests</h2>
        <div className="space-y-4">
          <RequestSection
            title="Resource Tier"
            current={user.resourceTier ?? "standard"}
            options={[
              { value: "light", label: "Light", desc: "t4g.medium (2 vCPU, 4 GiB)" },
              { value: "standard", label: "Standard", desc: "t4g.large (2 vCPU, 8 GiB)" },
              { value: "power", label: "Power", desc: "t4g.xlarge (4 vCPU, 16 GiB)" },
            ]}
            type="tier_change"
            fieldName="newTier"
            onSuccess={() => setSuccess("Tier change request submitted")}
            onError={(msg) => setError(msg)}
          />
          <RequestSection
            title="DLP Security Policy"
            current={user.securityPolicy ?? "restricted"}
            options={[
              { value: "open", label: "Open", desc: "All outbound, full access" },
              { value: "restricted", label: "Restricted", desc: "HTTPS + DNS only" },
              { value: "locked", label: "Locked", desc: "VPC internal only" },
            ]}
            type="dlp_change"
            fieldName="newPolicy"
            onSuccess={() => setSuccess("DLP policy change request submitted")}
            onError={(msg) => setError(msg)}
          />
          <IamRequestSection
            onSuccess={() => setSuccess("IAM extension request submitted")}
            onError={(msg) => setError(msg)}
          />

          {/* ─── Exposed Ports (custom routes, ADR-027) ─── */}
          <section className="mt-8">
            <h3 className="text-sm font-semibold text-gray-200">포트 노출 / Exposed Ports</h3>
            <p className="text-xs text-gray-500 mt-1">
              앱이 해당 path 밑에서 서빙되도록 설정 필요 (Vite <code>base</code>, Next <code>basePath</code>,
              Streamlit <code>--server.baseUrlPath</code>). 최대 5개. 8080은 code-server 예약.
            </p>
            <div className="mt-3 space-y-2">
              {routes.map((r, i) => {
                const st = routeStatus.find((s) => s.path === r.path);
                return (
                  <div key={i} className="flex items-center gap-2">
                    <input
                      value={r.label}
                      onChange={(e) => updateRoute(i, { label: e.target.value })}
                      placeholder="Label"
                      className="w-28 bg-[#0d1117] border border-gray-700 rounded px-2 py-1 text-sm text-gray-200"
                    />
                    <input
                      value={r.path}
                      onChange={(e) => updateRoute(i, { path: e.target.value })}
                      placeholder="/preview"
                      className="w-32 bg-[#0d1117] border border-gray-700 rounded px-2 py-1 text-sm text-gray-200"
                    />
                    <input
                      type="number"
                      value={r.port}
                      onChange={(e) => updateRoute(i, { port: Number(e.target.value) })}
                      placeholder="5173"
                      className="w-24 bg-[#0d1117] border border-gray-700 rounded px-2 py-1 text-sm text-gray-200"
                    />
                    <span className="text-xs text-gray-500 truncate">
                      {codeServerUrl ? `${codeServerUrl}${r.path === "/" ? "" : r.path}` : ""}
                    </span>
                    {st &&
                      (st.state === "ok" ? (
                        <span className="text-xs text-green-400">✅</span>
                      ) : (
                        <span className="text-xs text-amber-400" title={st.reason}>
                          ⚠️
                        </span>
                      ))}
                    <button onClick={() => removeRoute(i)} className="text-xs text-red-400">
                      삭제
                    </button>
                  </div>
                );
              })}
            </div>
            <div className="mt-3 flex items-center gap-3">
              <button
                onClick={addRoute}
                disabled={routes.length >= 5}
                className="text-sm px-3 py-1 rounded bg-gray-800 text-gray-200 disabled:opacity-50"
              >
                + 추가
              </button>
              <button
                onClick={saveRoutes}
                disabled={routesSaving}
                className="text-sm px-3 py-1 rounded bg-blue-600 text-white disabled:opacity-50"
              >
                저장
              </button>
              {routesPending && (
                <span className="text-xs text-amber-400">인스턴스 시작 시 반영됩니다</span>
              )}
              {routesError && <span className="text-xs text-red-400">{routesError}</span>}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function InfoField({ label, value, capitalize }: { label: string; value: string; capitalize?: boolean }) {
  return (
    <div className="bg-[#0d1117] rounded-lg p-4">
      <p className="text-xs text-gray-500 mb-1">{label}</p>
      <p className={`text-sm text-gray-200 ${capitalize ? "capitalize" : ""}`}>{value}</p>
    </div>
  );
}

function RequestSection({ title, current, options, type, fieldName, onSuccess, onError }: {
  title: string;
  current: string;
  options: { value: string; label: string; desc: string }[];
  type: string;
  fieldName: string;
  onSuccess: () => void;
  onError: (msg: string) => void;
}) {
  const [selected, setSelected] = useState(current);
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    if (selected === current) return;
    if (!reason.trim()) { onError("Please provide a reason"); return; }
    setSubmitting(true);
    try {
      const res = await fetch("/api/user/container-request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type, [fieldName]: selected, reason }),
      });
      const data = await res.json();
      if (res.ok) { onSuccess(); setReason(""); }
      else onError(data.error ?? "Request failed");
    } catch { onError("Network error"); }
    finally { setSubmitting(false); }
  };

  return (
    <div className="bg-[#0d1117] rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <p className="text-sm font-medium text-gray-200">{title}</p>
        <span className="text-xs px-2 py-0.5 bg-gray-800 text-gray-400 rounded capitalize">{current}</span>
      </div>
      <div className="flex gap-2 mb-3">
        {options.map((opt) => (
          <button
            key={opt.value}
            onClick={() => setSelected(opt.value)}
            className={`flex-1 px-3 py-2 rounded-lg border text-left transition-all ${
              selected === opt.value
                ? opt.value === current ? "border-gray-600 bg-gray-800/50" : "border-blue-500 bg-blue-900/20"
                : "border-gray-700 hover:border-gray-600"
            }`}
          >
            <p className="text-xs font-medium text-gray-200">{opt.label}</p>
            <p className="text-[10px] text-gray-500">{opt.desc}</p>
          </button>
        ))}
      </div>
      {selected !== current && (
        <div className="space-y-2">
          <input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Reason for change..."
            className="w-full bg-[#161b22] border border-gray-700 rounded-lg p-2 text-sm text-gray-200 placeholder-gray-600 focus:border-blue-500 focus:outline-none"
          />
          <button
            onClick={handleSubmit}
            disabled={submitting || !reason.trim()}
            className="px-4 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 disabled:text-gray-500 text-white text-xs font-medium rounded-lg transition-colors"
          >
            {submitting ? "Submitting..." : "Submit Request"}
          </button>
        </div>
      )}
    </div>
  );
}

// ADR-026 T8: custom resource-specific IAM statement authoring (replaces preset POLICY_SETS).
type StmtRow = { service: string; actions: string; resources: string };

function buildStatements(rows: StmtRow[]) {
  return rows
    .map((r) => ({
      Action: r.actions
        .split(/[\s,]+/)
        .filter(Boolean)
        .map((a) => (a.includes(":") ? a : `${r.service}:${a}`)),
      Resource: r.resources.split(/[\s,\n]+/).filter(Boolean),
    }))
    .filter((s) => s.Action.length > 0 || s.Resource.length > 0);
}

function IamRequestSection({ onSuccess, onError }: { onSuccess: () => void; onError: (msg: string) => void }) {
  const [mode, setMode] = useState<"form" | "json">("form");
  const [rows, setRows] = useState<StmtRow[]>([{ service: "s3", actions: "", resources: "" }]);
  const [jsonText, setJsonText] = useState("");
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [expanded, setExpanded] = useState(false);

  // JSON mode: paste a statement array `[{Action,Resource}]` OR a full policy `{Statement:[...]}`.
  let built: unknown[] = [];
  let parseError = "";
  if (mode === "json") {
    const t = jsonText.trim();
    if (t) {
      try {
        const parsed: unknown = JSON.parse(t);
        const arr = Array.isArray(parsed)
          ? parsed
          : parsed && Array.isArray((parsed as { Statement?: unknown }).Statement)
            ? (parsed as { Statement: unknown[] }).Statement
            : null;
        if (!arr || arr.length === 0) parseError = "JSON must be a statement array or a policy with a non-empty Statement[]";
        else built = arr;
      } catch (e) {
        parseError = "Invalid JSON: " + (e instanceof Error ? e.message : String(e));
      }
    }
  } else {
    built = buildStatements(rows);
  }
  // Client-side pre-validation mirrors the server validator (single source of truth).
  // accountId/region omitted → cross-account/region is enforced server-side (fail-closed).
  const clientErrors = parseError
    ? [parseError]
    : built.length > 0
      ? validateIamRequest(built as IamStatement[], {
          serviceAllowlist: DEFAULT_SERVICE_ALLOWLIST,
          wildcardOkActions: DEFAULT_WILDCARD_OK_ACTIONS,
        }).errors
      : [];
  const canSubmit = built.length > 0 && reason.trim().length > 0 && clientErrors.length === 0;

  const addRow = () => setRows([...rows, { service: "s3", actions: "", resources: "" }]);
  const removeRow = (i: number) => setRows(rows.filter((_, idx) => idx !== i));
  const updateRow = (i: number, patch: Partial<StmtRow>) =>
    setRows(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

  const handleSubmit = async () => {
    if (!canSubmit) { onError("Fix validation errors and provide a reason"); return; }
    setSubmitting(true);
    try {
      const res = await fetch("/api/user/container-request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "iam_extension", statements: built, reason }),
      });
      const data = await res.json();
      if (res.ok) {
        onSuccess();
        setReason("");
        setRows([{ service: "s3", actions: "", resources: "" }]);
        setJsonText("");
        setExpanded(false);
      } else {
        onError(Array.isArray(data.details) ? data.details.join("; ") : (data.error ?? "Request failed"));
      }
    } catch { onError("Network error"); }
    finally { setSubmitting(false); }
  };

  return (
    <div className="bg-[#0d1117] rounded-lg p-4">
      <button onClick={() => setExpanded(!expanded)} className="flex items-center justify-between w-full">
        <p className="text-sm font-medium text-gray-200">IAM Permission Extension (resource-specific)</p>
        <svg className={`w-4 h-4 text-gray-400 transition-transform ${expanded ? "rotate-180" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {expanded && (
        <div className="mt-3 space-y-3">
          <p className="text-[10px] text-gray-500">
            서비스·액션·리소스 ARN을 직접 지정해 신청합니다. 읽기 와일드카드(Get*/List*/Describe*)만 허용,
            `*`·`s3:*`·쓰기 와일드카드·교차계정은 거부됩니다. 관리자 승인 후 부여됩니다.
          </p>
          {/* Form ↔ raw-JSON input toggle */}
          <div className="flex gap-1 text-[10px]">
            <button onClick={() => setMode("form")} className={`px-2 py-0.5 rounded ${mode === "form" ? "bg-blue-600 text-white" : "bg-gray-800 text-gray-300"}`}>Form</button>
            <button onClick={() => setMode("json")} className={`px-2 py-0.5 rounded ${mode === "json" ? "bg-blue-600 text-white" : "bg-gray-800 text-gray-300"}`}>JSON</button>
          </div>
          {mode === "json" && (
            <textarea
              value={jsonText}
              onChange={(e) => setJsonText(e.target.value)}
              placeholder={'[\n  {"Action": ["s3:GetObject"], "Resource": ["arn:aws:s3:::my-bucket/*"]}\n]'}
              rows={8}
              className="w-full bg-[#161b22] border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 placeholder-gray-600 font-mono"
            />
          )}
          {mode === "form" && rows.map((r, i) => (
            <div key={i} className="border border-gray-700 rounded-lg p-2 space-y-2">
              <div className="flex items-center gap-2">
                <select
                  value={r.service}
                  onChange={(e) => updateRow(i, { service: e.target.value })}
                  className="bg-[#161b22] border border-gray-700 rounded px-2 py-1 text-xs text-gray-200"
                >
                  {DEFAULT_SERVICE_ALLOWLIST.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
                <span className="text-[10px] text-gray-500">Statement {i + 1}</span>
                {rows.length > 1 && (
                  <button onClick={() => removeRow(i)} className="ml-auto text-xs text-red-400">삭제</button>
                )}
              </div>
              <input
                value={r.actions}
                onChange={(e) => updateRow(i, { actions: e.target.value })}
                placeholder="actions (예: GetObject, List*) — 콤마/공백 구분"
                className="w-full bg-[#161b22] border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 placeholder-gray-600"
              />
              <textarea
                value={r.resources}
                onChange={(e) => updateRow(i, { resources: e.target.value })}
                placeholder={"resource ARN (한 줄에 하나, 예: arn:aws:s3:::bucket/prefix/*)\n읽기 전용이면 * 가능"}
                rows={2}
                className="w-full bg-[#161b22] border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 placeholder-gray-600 font-mono"
              />
            </div>
          ))}
          {mode === "form" && <button onClick={addRow} className="text-xs px-2 py-1 rounded bg-gray-800 text-gray-200">+ Statement 추가</button>}

          {clientErrors.length > 0 && (
            <ul className="text-[10px] text-red-400 list-disc pl-4">
              {clientErrors.slice(0, 6).map((e, i) => <li key={i}>{e}</li>)}
            </ul>
          )}

          <input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Reason for requesting access..."
            className="w-full bg-[#161b22] border border-gray-700 rounded-lg p-2 text-sm text-gray-200 placeholder-gray-600 focus:border-blue-500 focus:outline-none"
          />
          <div className="flex items-center justify-end">
            <button
              onClick={handleSubmit}
              disabled={submitting || !canSubmit}
              className="px-4 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 disabled:text-gray-500 text-white text-xs font-medium rounded-lg transition-colors"
            >
              {submitting ? "Submitting..." : "Submit Request"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
