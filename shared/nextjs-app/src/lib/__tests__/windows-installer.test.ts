import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { psQuote, windowsInstallerScript } from "@/lib/windows-installer";
import { installCommands } from "@/lib/install-commands";
import { GET as getCliPs1 } from "@/app/api/install/cli-ps1/route";

const env = {
  dashboardUrl: "https://dash.example.com/",
  cognitoRegion: "ap-northeast-2",
  cognitoUserPoolId: "ap-northeast-2_pool",
  cognitoCliClientId: "client'id",
  localOtelEndpoint: "",
  codexModelId: "global.openai.gpt-6.1-sol",
};

const cliPath = path.resolve(__dirname, "../../../../../tools/cc-bedrock-local.ps1");

describe("Windows installer (/api/install/windows)", () => {
  it("quotes values as PowerShell single-quoted literals", () => {
    expect(psQuote("a'b")).toBe("'a''b'");
    const s = windowsInstallerScript(env);
    expect(s).toContain("$CognitoClientId = 'client''id'");
    expect(s).toContain("$DashboardUrl = 'https://dash.example.com'");
  });

  it("downloads the PowerShell CLI, runs setup + login, and keeps desktop mode opt-in", () => {
    const s = windowsInstallerScript(env);
    expect(s).toContain("/api/install/cli-ps1");
    // Only the .cmd shim is on PATH; the .ps1 lives in lib and an old bin copy is removed.
    expect(s).toContain("'.local/lib/cc-bedrock'");
    expect(s).toContain("$Cli = Join-Path $LibDir 'cc-bedrock-local.ps1'");
    expect(s).toContain("Remove-Item -LiteralPath $OldCli -Force");
    // Forward slashes: backslashes would be eaten by the template literal (\l, \c).
    expect(s).toContain('-File "%~dp0../lib/cc-bedrock/cc-bedrock-local.ps1" %*');
    expect(s).toContain("Invoke-Cli setup");
    expect(s).toContain("Invoke-Cli login");
    // Claude Desktop third-party mode replaces claude.ai sign-in: default No.
    expect(s).toMatch(/\(y\/N\)'?\s*\n[\s\S]*if \(\$Desk -match '\^\[Yy\]'\) \{ \[void\]\(Invoke-Cli setup-desktop\) \}/);
  });

  it("is plain ASCII and free of PowerShell escapes the template literal would mangle", () => {
    const s = windowsInstallerScript(env);
    expect(/^[\x00-\x7f]*$/.test(s)).toBe(true);
    expect(s).not.toContain("`");
  });

  it("restricts the config directory to the owner", () => {
    expect(windowsInstallerScript(env)).toContain("/inheritance:r /grant:r");
  });

  it("shows a Windows one-liner next to the bash one", () => {
    const c = installCommands("https://dash.example.com");
    expect(c.unix).toBe("curl -fsSL https://dash.example.com/api/install | bash");
    expect(c.windows).toBe(
      'powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://dash.example.com/api/install/windows | iex"',
    );
  });
});

describe("Windows CLI (tools/cc-bedrock-local.ps1)", () => {
  const cli = readFileSync(cliPath, "utf8");

  it("is served by /api/install/cli-ps1", async () => {
    const r = await getCliPs1();
    expect(r.status).toBe(200);
    expect(await r.text()).toBe(cli);
  });

  // Windows PowerShell 5.1 reads a BOM-less file as the ANSI code page, so any
  // non-ASCII byte can corrupt string literals on a Korean/Japanese Windows.
  it("is plain ASCII", () => {
    expect(/^[\x00-\x7f]*$/.test(cli)).toBe(true);
  });

  // Claude Desktop Chat/Cowork refuse every fetch while coworkEgressAllowedHosts is unset.
  it("lets Claude Desktop fetch the web (all hosts unless DESKTOP_EGRESS_HOSTS narrows it)", () => {
    expect(cli).toContain("'coworkEgressAllowedHosts')");
    expect(cli).toContain("Cfg 'DESKTOP_EGRESS_HOSTS' '*'");
    expect(cli).toContain("$v['coworkEgressAllowedHosts'] = (ConvertTo-Json -InputObject $hosts -Compress)");
    expect(windowsInstallerScript(env)).toContain("'# DESKTOP_EGRESS_HOSTS=*'");
  });

  it("keeps the credential-process stdout contract", () => {
    expect(cli).toContain("[Console]::Out.Write($json");
    expect(cli).toContain('function Say([string]$msg) { [Console]::Error.WriteLine');
    expect(cli).not.toMatch(/Write-Host/);
  });

  it("writes the same managed keys as the bash CLI", () => {
    const sh = readFileSync(path.resolve(cliPath, "../cc-bedrock-local.sh"), "utf8");
    for (const key of [
      "[model_providers.amazon-bedrock-runtime.aws]",
      "[permissions.cc-bedrock]",
      "[permissions.cc-bedrock.filesystem]",
      "# managed by cc-bedrock-local",
      "Read(~/.config/cc-bedrock/**)",
      'model_provider = "amazon-bedrock-runtime"',
    ]) {
      expect(sh).toContain(key);
      expect(cli).toContain(key.replace('model_provider = "amazon-bedrock-runtime"', 'model_provider = `"amazon-bedrock-runtime`"'));
    }
  });
});
