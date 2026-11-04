// Default Claude models written into the Local CLI config by both installers
// (/api/install for bash, /api/install/windows for PowerShell). Bedrock global
// cross-region inference profile IDs. Keep in sync with the built-in fallbacks in
// tools/cc-bedrock-local.sh and tools/cc-bedrock-local.ps1 (asserted in tests).
export const LOCAL_CLAUDE_MODELS = {
  sonnet: "global.anthropic.claude-sonnet-5-5",
  opus: "global.anthropic.claude-opus-5-5",
  haiku: "global.anthropic.claude-haiku-5-5",
  subagent: "global.anthropic.claude-sonnet-5-5",
} as const;
