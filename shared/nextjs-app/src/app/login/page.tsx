"use client";

import { signIn } from "next-auth/react";
import { useSearchParams } from "next/navigation";
import { useState, Suspense } from "react";
import { NEW_PASSWORD_REQUIRED } from "@/lib/auth-errors";
import { validatePassword } from "@/lib/password-policy";

// signin → (invited user) newPassword → signed in
// signin → forgot → reset (emailed code) → signin
type Mode = "signin" | "newPassword" | "forgot" | "reset";

const INPUT_CLASS =
  "w-full bg-white/[0.04] border border-white/[0.08] rounded-xl px-4 py-3 text-sm text-white placeholder-white/20 focus:border-blue-500/50 focus:outline-none focus:ring-1 focus:ring-blue-500/30 transition-all";
const LABEL_CLASS = "block text-xs text-white/40 mb-1.5 font-medium";
const LINK_CLASS = "text-xs text-blue-400/80 hover:text-blue-300 transition-colors";

const API_ERRORS: Record<string, string> = {
  invalid_credentials: "The temporary password is incorrect or has expired. Use \"Forgot password?\" to get a new one.",
  invalid_password: "The new password does not meet the password policy.",
  code_mismatch: "The verification code is incorrect.",
  code_expired: "The verification code has expired. Request a new one.",
  too_many_attempts: "Too many attempts. Please wait a few minutes and try again.",
  not_required: "This account already has a password. Sign in with it.",
  invalid_request: "Please check the fields and try again.",
};

async function postJson(url: string, body: Record<string, string>): Promise<{ ok: boolean; error?: string; message?: string }> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, error: data.error, message: data.message };
  } catch {
    return { ok: false };
  }
}

function apiError(r: { error?: string; message?: string }): string {
  return r.message ?? (r.error && API_ERRORS[r.error]) ?? "Something went wrong. Please try again.";
}

function LoginContent() {
  const searchParams = useSearchParams();
  const callbackUrl = searchParams.get("callbackUrl") ?? "/";
  const error = searchParams.get("error");
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [urlErrorDismissed, setUrlErrorDismissed] = useState(false);

  const switchMode = (next: Mode, message: string | null = null) => {
    setMode(next);
    setLoginError(null);
    setNotice(message);
    setUrlErrorDismissed(true);
    setNewPassword("");
    setConfirmPassword("");
    if (next !== "reset") setCode("");
  };

  const finishSignIn = async (pw: string) => {
    const result = await signIn("cognito-credentials", { email, password: pw, callbackUrl, redirect: false });
    if (result?.error === NEW_PASSWORD_REQUIRED) {
      switchMode("newPassword", "Welcome! Set a new password to finish your first sign-in.");
      setLoading(false);
    } else if (result?.error) {
      setLoginError("Invalid email or password");
      setLoading(false);
    } else if (result?.url) {
      window.location.href = result.url;
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) return;
    setLoading(true);
    setLoginError(null);
    setNotice(null);
    await finishSignIn(password);
  };

  // Shared check for the two "choose a new password" forms.
  const newPasswordProblem = (): string | null =>
    validatePassword(newPassword) ?? (newPassword !== confirmPassword ? "Passwords do not match" : null);

  const handleNewPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    const problem = newPasswordProblem();
    if (problem) return setLoginError(problem);
    setLoading(true);
    setLoginError(null);
    const r = await postJson("/api/auth/password/new", { email, temporaryPassword: password, newPassword });
    if (!r.ok) {
      setLoginError(apiError(r));
      setLoading(false);
      return;
    }
    setPassword(newPassword);
    await finishSignIn(newPassword);
  };

  const handleForgot = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email) return;
    setLoading(true);
    setLoginError(null);
    const r = await postJson("/api/auth/password/forgot", { email });
    setLoading(false);
    if (!r.ok) return setLoginError(apiError(r));
    switchMode(
      "reset",
      "If an account exists for this email, we sent a verification code. If you were invited and never signed in, you will receive a new temporary password instead — use it on the sign-in screen."
    );
  };

  const handleReset = async (e: React.FormEvent) => {
    e.preventDefault();
    const problem = newPasswordProblem();
    if (problem) return setLoginError(problem);
    setLoading(true);
    setLoginError(null);
    const r = await postJson("/api/auth/password/reset", { email, code, newPassword });
    setLoading(false);
    if (!r.ok) return setLoginError(apiError(r));
    setPassword("");
    switchMode("signin", "Your password was reset. Sign in with the new password.");
  };

  const urlError = urlErrorDismissed ? null : error === "CredentialsSignin" ? "Invalid email or password" : error ? `Error: ${error}` : null;
  const displayError = loginError ?? urlError;

  const spinner = (
    <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
    </svg>
  );
  const submitButton = (label: string, busyLabel: string, disabled: boolean) => (
    <button
      type="submit"
      disabled={loading || disabled}
      className="w-full group relative flex items-center justify-center gap-3 px-6 py-3.5 rounded-2xl bg-gradient-to-r from-blue-600 to-blue-500 hover:from-blue-500 hover:to-blue-400 text-white font-semibold text-sm transition-all duration-300 shadow-lg shadow-blue-500/25 hover:shadow-blue-500/40 hover:scale-[1.02] active:scale-[0.98] disabled:opacity-60 disabled:cursor-not-allowed disabled:hover:scale-100 mt-2"
    >
      {loading ? <>{spinner}{busyLabel}</> : label}
    </button>
  );
  const newPasswordFields = (
    <>
      <div>
        <label htmlFor="new-password" className={LABEL_CLASS}>New password</label>
        <input id="new-password" type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)}
          placeholder="At least 8 characters" required autoComplete="new-password" className={INPUT_CLASS} />
        <p className="mt-1.5 text-[11px] text-white/30">8+ characters with an uppercase letter, a number and a symbol.</p>
      </div>
      <div>
        <label htmlFor="confirm-password" className={LABEL_CLASS}>Confirm new password</label>
        <input id="confirm-password" type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)}
          placeholder="Re-enter the new password" required autoComplete="new-password" className={INPUT_CLASS} />
      </div>
    </>
  );
  const backToSignIn = (
    <div className="text-center">
      <button type="button" onClick={() => switchMode("signin")} className={LINK_CLASS}>Back to sign in</button>
    </div>
  );

  return (
    <div className="min-h-screen flex items-center justify-center relative overflow-hidden bg-[#0a0f1a]">
      {/* Animated background orbs */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute -top-40 -left-40 w-96 h-96 bg-blue-500/10 rounded-full blur-3xl animate-pulse" />
        <div className="absolute -bottom-40 -right-40 w-96 h-96 bg-indigo-500/10 rounded-full blur-3xl animate-pulse [animation-delay:2s]" />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-blue-500/5 rounded-full blur-3xl" />
      </div>

      {/* Grid pattern overlay */}
      <div
        className="absolute inset-0 opacity-[0.03]"
        style={{
          backgroundImage: "linear-gradient(rgba(255,255,255,.1) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.1) 1px, transparent 1px)",
          backgroundSize: "64px 64px",
        }}
      />

      {/* Login card */}
      <div className="relative z-10 w-full max-w-md mx-4">
        <div className="bg-white/[0.03] backdrop-blur-xl border border-white/[0.08] rounded-3xl p-10 shadow-2xl shadow-black/40">
          {/* Logo */}
          <div className="flex flex-col items-center mb-8">
            <div className="relative mb-5">
              <div className="w-20 h-20 rounded-2xl bg-gradient-to-br from-blue-500/20 to-indigo-500/20 border border-blue-500/30 flex items-center justify-center animate-glow">
                <span className="text-3xl font-black bg-clip-text text-transparent bg-gradient-to-r from-blue-400 to-blue-500 tracking-tighter">
                  CC
                </span>
              </div>
              <div className="absolute -bottom-1 -right-1 w-5 h-5 bg-emerald-500 rounded-full border-[3px] border-[#0a0f1a] shadow-lg shadow-emerald-500/30" />
            </div>
            <h1 className="text-2xl font-bold text-white tracking-tight">CC-on-Bedrock</h1>
            <div className="flex items-center gap-2 mt-2">
              <span className="px-2.5 py-0.5 text-[10px] font-semibold tracking-wider uppercase bg-blue-500/15 text-blue-400 border border-blue-500/20 rounded-full">
                Enterprise
              </span>
              <span className="text-sm text-white/40">Cloud Development Platform</span>
            </div>
          </div>

          {/* Divider */}
          <div className="h-px bg-gradient-to-r from-transparent via-white/10 to-transparent mb-6" />

          {/* Notice / Error */}
          {notice && (
            <div className="mb-5 px-4 py-3 rounded-xl bg-blue-500/10 border border-blue-500/20 text-sm text-blue-300" role="status">
              {notice}
            </div>
          )}
          {displayError && (
            <div className="mb-5 px-4 py-3 rounded-xl bg-red-500/10 border border-red-500/20 text-sm text-red-400" role="alert">
              {displayError}
            </div>
          )}

          {mode === "signin" && (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label htmlFor="email" className={LABEL_CLASS}>Email</label>
                <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@company.com" required autoComplete="email" autoFocus className={INPUT_CLASS} />
              </div>
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label htmlFor="password" className="block text-xs text-white/40 font-medium">Password</label>
                  <button type="button" onClick={() => switchMode("forgot")} className={LINK_CLASS}>Forgot password?</button>
                </div>
                <input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter your password" required autoComplete="current-password" className={INPUT_CLASS} />
              </div>
              {submitButton("Sign In", "Signing in...", !email || !password)}
            </form>
          )}

          {mode === "newPassword" && (
            <form onSubmit={handleNewPassword} className="space-y-4">
              <p className="text-sm text-white/60">Signing in as <span className="text-white">{email}</span></p>
              {newPasswordFields}
              {submitButton("Set password and sign in", "Saving...", !newPassword || !confirmPassword)}
              {backToSignIn}
            </form>
          )}

          {mode === "forgot" && (
            <form onSubmit={handleForgot} className="space-y-4">
              <p className="text-sm text-white/60">Enter your account email. We will email you a verification code.</p>
              <div>
                <label htmlFor="forgot-email" className={LABEL_CLASS}>Email</label>
                <input id="forgot-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@company.com" required autoComplete="email" autoFocus className={INPUT_CLASS} />
              </div>
              {submitButton("Send verification code", "Sending...", !email)}
              {backToSignIn}
            </form>
          )}

          {mode === "reset" && (
            <form onSubmit={handleReset} className="space-y-4">
              <p className="text-sm text-white/60">Resetting the password for <span className="text-white">{email}</span></p>
              <div>
                <label htmlFor="code" className={LABEL_CLASS}>Verification code</label>
                <input id="code" type="text" inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value.trim())}
                  placeholder="6-digit code from the email" required autoComplete="one-time-code" autoFocus className={INPUT_CLASS} />
              </div>
              {newPasswordFields}
              {submitButton("Reset password", "Resetting...", !code || !newPassword || !confirmPassword)}
              <div className="flex items-center justify-between">
                <button type="button" onClick={() => switchMode("forgot")} className={LINK_CLASS}>Resend code</button>
                <button type="button" onClick={() => switchMode("signin")} className={LINK_CLASS}>Back to sign in</button>
              </div>
            </form>
          )}

          {/* Footer */}
          <p className="mt-6 text-center text-xs text-white/20">
            Secured by Amazon Cognito
          </p>
        </div>

        {/* Bottom branding */}
        <p className="mt-8 text-center text-xs text-white/15">
          Powered by Amazon Bedrock &middot; Opus 4.8 &middot; Sonnet 5
        </p>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center bg-[#0a0f1a]">
          <div className="animate-spin h-8 w-8 border-2 border-blue-500 border-t-transparent rounded-full" />
        </div>
      }
    >
      <LoginContent />
    </Suspense>
  );
}
