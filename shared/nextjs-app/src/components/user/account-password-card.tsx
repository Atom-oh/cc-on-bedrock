"use client";

import { useState } from "react";
import { validatePassword } from "@/lib/password-policy";

// Governance-mode account settings: change the Cognito sign-in password.
// (DevEnv mode changes it from Settings → Code-Server Password, which also
// syncs the code-server secret.) The API re-checks the current password.
export default function AccountPasswordCard() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const policyError = next ? validatePassword(next) : null;
  const mismatch = !!next && !!confirm && next !== confirm;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    const problem = validatePassword(next) ?? (next !== confirm ? "Passwords do not match" : null);
    if (problem) return setError(problem);
    setLoading(true);
    try {
      const res = await fetch("/api/user/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword: current, newPassword: next }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) {
        setSuccess(data.message ?? "Password changed successfully.");
        setCurrent("");
        setNext("");
        setConfirm("");
      } else {
        setError(data.error ?? "Failed to change password");
      }
    } catch {
      setError("Failed to change password");
    } finally {
      setLoading(false);
    }
  };

  const inputClass =
    "w-full bg-[#0d1117] border border-gray-700 rounded-lg p-3 text-sm text-gray-200 placeholder-gray-600 focus:border-blue-500 focus:outline-none";

  return (
    <form onSubmit={submit} className="bg-[#161b22] rounded-xl border border-gray-800 p-5 space-y-3">
      <h2 className="text-lg font-semibold text-gray-100">Account Password</h2>
      <p className="text-xs text-gray-500">Change the password you use to sign in to this dashboard and the local CLI.</p>
      {error && <p className="text-sm text-red-400" role="alert">{error}</p>}
      {success && <p className="text-sm text-green-400" role="status">{success}</p>}
      <div>
        <label htmlFor="acct-current-password" className="block text-xs text-gray-500 mb-1">Current Password</label>
        <input id="acct-current-password" type="password" value={current} onChange={(e) => setCurrent(e.target.value)}
          autoComplete="current-password" className={inputClass} />
      </div>
      <div>
        <label htmlFor="acct-new-password" className="block text-xs text-gray-500 mb-1">New Password</label>
        <input id="acct-new-password" type="password" value={next} onChange={(e) => setNext(e.target.value)}
          placeholder="Min 8 chars, uppercase, number, special char" autoComplete="new-password" className={inputClass} />
      </div>
      <div>
        <label htmlFor="acct-confirm-password" className="block text-xs text-gray-500 mb-1">Confirm New Password</label>
        <input id="acct-confirm-password" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)}
          autoComplete="new-password" className={inputClass} />
      </div>
      {mismatch && <p className="text-xs text-red-400">Passwords do not match</p>}
      {policyError && next.length >= 8 && <p className="text-xs text-yellow-400">{policyError}</p>}
      <button
        type="submit"
        disabled={loading || !current || !next || !confirm || mismatch || !!policyError}
        className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 disabled:text-gray-500 text-white text-sm font-medium rounded-lg transition-colors"
      >
        {loading ? "Changing..." : "Change Password"}
      </button>
    </form>
  );
}
