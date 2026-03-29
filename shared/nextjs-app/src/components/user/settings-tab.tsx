"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import type { UserSession, ContainerInfo } from "@/lib/types";

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

  const domainName = process.env.NEXT_PUBLIC_DOMAIN_NAME ?? "atomai.click";
  const devSubdomain = process.env.NEXT_PUBLIC_DEV_SUBDOMAIN ?? "dev";
  const codeServerUrl = user.subdomain
    ? `https://${user.subdomain}.${devSubdomain}.${domainName}`
    : null;

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
              <p className="text-xs text-yellow-400">Container is running. New password will apply after restart.</p>
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
          <InfoField label="OS" value={user.containerOs === "al2023" ? "Amazon Linux 2023" : "Ubuntu 24.04"} />
          <InfoField label="Storage Type" value={(user.storageType ?? "efs").toUpperCase()} />
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
