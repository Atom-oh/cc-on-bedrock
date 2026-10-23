"use client";

import { useEffect, useState } from "react";
import LocalModeTab from "./local-mode-tab";

// ADR-006 local setup: one-line installer plus the credentials/usage panel. The CLI
// authenticates with Cognito and receives 1-hour STS credentials scoped to the user's
// inference profile; no Bedrock API key is distributed.
export default function LocalSetup() {
  const [origin, setOrigin] = useState("");
  useEffect(() => setOrigin(window.location.origin), []);

  return (
    <>
      <div className="mb-4 rounded border border-blue-500/30 bg-blue-500/5 p-3 text-xs text-blue-300">
        <div className="font-semibold mb-1">한 줄 설치 (no browser flow):</div>
        <pre className="bg-black/40 rounded p-2 overflow-auto text-xs text-gray-200">
{origin ? `curl -fsSL ${origin}/api/install | bash` : " "}
        </pre>
        <div className="mt-2 text-blue-300/80">
          설치 후 새 셸에서 <code className="text-gray-200">cc</code> 명령으로 Claude Code, <code className="text-gray-200">ccx</code> 명령으로 Codex를 Bedrock에서 실행.
          자격증명은 1시간 후 자동 만료되며 재실행 시 cache된 refresh token으로 무인터랙션 갱신됩니다.
        </div>
      </div>
      <LocalModeTab />
    </>
  );
}
