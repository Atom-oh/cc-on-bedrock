import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { LOCAL_CLAUDE_MODELS as M } from "@/lib/local-models";
import { windowsInstallerScript } from "@/lib/windows-installer";

const tools = path.resolve(__dirname, "../../../../../tools");
const sh = readFileSync(path.join(tools, "cc-bedrock-local.sh"), "utf8");
const ps1 = readFileSync(path.join(tools, "cc-bedrock-local.ps1"), "utf8");

const env = {
  dashboardUrl: "https://dash.example.com",
  cognitoRegion: "ap-northeast-2",
  cognitoUserPoolId: "pool",
  cognitoCliClientId: "client",
  localOtelEndpoint: "",
  codexModelId: "global.openai.gpt-6.1-sol",
};

describe("Local CLI default Claude models", () => {
  it("are the Claude 5.5 global inference profiles", () => {
    expect(M).toEqual({
      sonnet: "global.anthropic.claude-sonnet-5-5",
      opus: "global.anthropic.claude-opus-5-5",
      haiku: "global.anthropic.claude-haiku-5-5",
      subagent: "global.anthropic.claude-sonnet-5-5",
    });
  });

  it("are written into the Windows installer config", () => {
    const s = windowsInstallerScript(env);
    expect(s).toContain(`'ANTHROPIC_DEFAULT_SONNET_MODEL=${M.sonnet}'`);
    expect(s).toContain(`'ANTHROPIC_DEFAULT_OPUS_MODEL=${M.opus}'`);
    expect(s).toContain(`'ANTHROPIC_DEFAULT_HAIKU_MODEL=${M.haiku}'`);
    expect(s).toContain(`'CLAUDE_CODE_SUBAGENT_MODEL=${M.subagent}'`);
  });

  it("match the built-in fallbacks of both CLIs", () => {
    expect(sh).toContain(`ANTHROPIC_DEFAULT_SONNET_MODEL:-${M.sonnet}}`);
    expect(sh).toContain(`ANTHROPIC_DEFAULT_OPUS_MODEL:-${M.opus}}`);
    expect(sh).toContain(`ANTHROPIC_SMALL_FAST_MODEL:-${M.haiku}}`);
    expect(sh).toContain(`CLAUDE_CODE_SUBAGENT_MODEL:-${M.subagent}}`);
    expect(ps1).toContain(`Cfg 'ANTHROPIC_DEFAULT_SONNET_MODEL' '${M.sonnet}'`);
    expect(ps1).toContain(`Cfg 'ANTHROPIC_DEFAULT_OPUS_MODEL' '${M.opus}'`);
    expect(ps1).toContain(`Cfg 'ANTHROPIC_SMALL_FAST_MODEL' '${M.haiku}'`);
    expect(ps1).toContain(`Cfg 'CLAUDE_CODE_SUBAGENT_MODEL' '${M.subagent}'`);
  });
});
