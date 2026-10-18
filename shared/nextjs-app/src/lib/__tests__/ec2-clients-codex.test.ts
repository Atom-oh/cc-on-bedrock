import { describe, it, expect } from "vitest";
import { codexConfigToml, DEFAULT_CODEX_MODEL_ID } from "../ec2-clients";

// ADR-014: the DevEnv system config must keep the shape verified live against
// codex-cli 0.163 on bedrock-runtime (ap-northeast-2, 2026-10-18).
describe("codexConfigToml", () => {
  it("pins the bedrock-runtime provider, region and analytics off", () => {
    const toml = codexConfigToml("ap-northeast-2", "global.openai.gpt-6-luna");
    expect(toml).toContain('model_provider = "amazon-bedrock-runtime"');
    expect(toml).toContain('model = "global.openai.gpt-6-luna"');
    expect(toml).toContain("[model_providers.amazon-bedrock-runtime.aws]\nregion = \"ap-northeast-2\"");
    expect(toml).toContain('web_search = "disabled"');
    expect(toml).toContain("[analytics]\nenabled = false");
    // never routes to OpenAI directly
    expect(toml).not.toMatch(/api\.openai\.com|OPENAI_API_KEY/);
  });

  it("defaults to a cross-Region OpenAI profile", () => {
    expect(DEFAULT_CODEX_MODEL_ID).toMatch(/^global\.openai\.gpt-/);
    expect(codexConfigToml("us-east-1", undefined)).toContain(`model = "${DEFAULT_CODEX_MODEL_ID}"`);
  });

  it("rejects values that could break out of the user-data heredoc", () => {
    for (const bad of ["global.openai.gpt-6\nCODEXCFG\nrm -rf /", 'global.openai.gpt-6"', "anthropic.claude-opus-4-8", ""]) {
      expect(codexConfigToml("ap-northeast-2", bad)).toContain(`model = "${DEFAULT_CODEX_MODEL_ID}"`);
    }
  });
});
