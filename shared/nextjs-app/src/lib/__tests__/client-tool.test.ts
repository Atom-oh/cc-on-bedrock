import { describe, it, expect } from "vitest";
import { clientTool, toolForModel } from "../client-tool";

describe("clientTool (ADR-014 audit attribution)", () => {
  it("uses the real CloudTrail user agents", () => {
    expect(clientTool("claude-cli/2.1.302 (external, sdk-cli)")).toBe("claude-code");
    expect(clientTool("codex_exec/0.163.0 (Amazon Linux AMI 2023.0.0; aarch64) vscode/1.106.3")).toBe("codex");
    expect(clientTool("codex_cli_rs/0.163.0")).toBe("codex");
  });
  it("falls back to the model vendor", () => {
    expect(clientTool("Boto3/1.43", "global.openai.gpt-6.1-sol")).toBe("codex");
    expect(clientTool(undefined, "global.anthropic.claude-opus-4-8")).toBe("claude-code");
    expect(clientTool("Boto3/1.43", "amazon.titan-embed-text-v2:0")).toBe("other");
    expect(toolForModel("")).toBe("other");
  });
});
