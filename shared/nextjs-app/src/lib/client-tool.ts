// ADR-014: which AI coding CLI produced a Bedrock call. Pure (no AWS SDK) so it
// is shared by the usage pipeline readers, the audit view, and unit tests.
// Mirrors lambda/audit-logger.py client_tool() and bedrock-usage-tracker.py tool_for_model().

export type UsageTool = "claude-code" | "codex" | "other";

/** Usage rows carry no user agent — the model vendor identifies the CLI. */
export function toolForModel(model: string): UsageTool {
  const m = (model ?? "").toLowerCase();
  if (m.includes("claude") || m.includes("anthropic")) return "claude-code";
  if (m.includes("gpt") || m.includes("openai")) return "codex";
  return "other";
}

/**
 * CloudTrail userAgent is authoritative (`claude-cli/2.1.302 (external, sdk-cli)`,
 * `codex_exec/0.163.0 (…)`, `codex_cli_rs/…`); fall back to the model vendor.
 */
export function clientTool(userAgent: string | undefined, model?: string): UsageTool {
  const ua = (userAgent ?? "").toLowerCase();
  if (ua.includes("codex")) return "codex";
  if (ua.includes("claude-cli") || ua.includes("claude-code")) return "claude-code";
  return toolForModel(model ?? "");
}
