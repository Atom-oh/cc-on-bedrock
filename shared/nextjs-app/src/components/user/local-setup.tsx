"use client";

import { useEffect, useState } from "react";
import LocalModeTab from "./local-mode-tab";
import CcdashSetupCard from "./ccdash-setup-card";
import { installCommands } from "@/lib/install-commands";

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
{origin ? installCommands(origin).unix : " "}
        </pre>
        <div className="font-semibold mt-2 mb-1">Windows (PowerShell / cmd):</div>
        <pre className="bg-black/40 rounded p-2 overflow-auto text-xs text-gray-200">
{origin ? installCommands(origin).windows : " "}
        </pre>
        <div className="mt-2 text-blue-300/80">
          설치 후 <code className="text-gray-200">claude</code>와 <code className="text-gray-200">codex</code>를 그대로 실행하면 Bedrock을 사용합니다. Windows에서는 Claude Desktop의 Code 탭과 Codex 앱도 같은 설정을 읽습니다(설치 후 앱 재시작).
          1시간짜리 자격증명은 cache된 refresh token으로 자동 갱신되며, 30일 동안 쓰지 않았다면 <code className="text-gray-200">cc-bedrock-local login</code>으로 다시 로그인합니다.
        </div>
      </div>
      <CcdashSetupCard />
      <LocalModeTab />
    </>
  );
}
