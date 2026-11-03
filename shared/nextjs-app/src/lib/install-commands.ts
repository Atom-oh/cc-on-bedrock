// One-line Local CLI installers shown in the portal (ADR-006). The Windows line
// works from PowerShell and cmd; it configures Claude Code (CLI + Claude Desktop
// Code tab) and Codex (CLI + Codex app).
export function installCommands(origin: string): { unix: string; windows: string } {
  const base = origin || "https://dashboard.example.com";
  return {
    unix: `curl -fsSL ${base}/api/install | bash`,
    windows: `powershell -NoProfile -ExecutionPolicy Bypass -Command "irm ${base}/api/install/windows | iex"`,
  };
}
