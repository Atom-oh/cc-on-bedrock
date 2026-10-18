// ADR-014: Codex CLI default model. Must be a cross-Region (global./us./…) OpenAI
// inference profile — the bedrock-runtime Responses API rejects foundation-model IDs
// and application inference profiles. The value is interpolated into root user-data
// and a downloadable shell script, so anything that is not a plain profile ID falls
// back to the default (no quotes, whitespace or newlines can reach a heredoc).
export const DEFAULT_CODEX_MODEL_ID = "global.openai.gpt-6.1-sol";

const CODEX_MODEL_RE = /^(global|us|us-gov|eu|apac)\.openai\.gpt-[A-Za-z0-9.-]+$/;

export function codexModelId(raw: string | undefined): string {
  return raw && CODEX_MODEL_RE.test(raw) ? raw : DEFAULT_CODEX_MODEL_ID;
}
