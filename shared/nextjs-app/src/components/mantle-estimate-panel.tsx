"use client";

import { useEffect, useState } from "react";

// ADR-014 §9 stage 1: ESTIMATED Codex-on-bedrock-mantle cost (month to date).
// Admin view lists every user; user view shows only the caller. Never a budget figure.

interface UserEstimate {
  email: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCost: number;
  models: string[];
  updatedAt: string;
}

const usd = (n: number) => `~$${n.toFixed(n < 1 ? 4 : 2)}`;

export default function MantleEstimatePanel({ scope }: { scope: "admin" | "user" }) {
  const [period, setPeriod] = useState("");
  const [users, setUsers] = useState<UserEstimate[] | null>(null);
  const [caveat, setCaveat] = useState("");
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    const url = scope === "admin" ? "/api/admin/mantle-estimates" : "/api/user/mantle-estimate";
    fetch(url)
      .then((r) => r.json())
      .then((j) => {
        if (!j.success) throw new Error(j.error);
        setPeriod(j.data.period);
        setCaveat(j.data.caveat);
        setTruncated(Boolean(j.data.truncated));
        setUsers(scope === "admin" ? j.data.users : j.data.estimate ? [j.data.estimate] : []);
      })
      .catch(() => setError(true));
  }, [scope]);

  if (error || users === null) return null;
  if (scope === "user" && users.length === 0) return null; // never used mantle this month

  return (
    <div className="mt-3 rounded border border-amber-500/30 bg-amber-500/5 p-3 text-xs">
      <div className="font-medium text-amber-400">
        Codex on bedrock-mantle — 추정 비용 {period} (예산 미반영)
      </div>
      {users.length === 0 ? (
        <div className="mt-1 text-gray-500">이번 달 mantle 사용 없음</div>
      ) : (
        <table className="mt-2 w-full text-left text-gray-300">
          <thead className="text-gray-500">
            <tr>
              {scope === "admin" && <th className="py-1 pr-3 font-normal">User</th>}
              <th className="py-1 pr-3 font-normal">Est. cost</th>
              <th className="py-1 pr-3 font-normal">Input / output tokens</th>
              <th className="py-1 pr-3 font-normal">Models</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.email} className="border-t border-gray-800">
                {scope === "admin" && <td className="py-1 pr-3">{u.email}</td>}
                <td className="py-1 pr-3">{usd(u.estimatedCost)}</td>
                <td className="py-1 pr-3">{u.inputTokens.toLocaleString()} / {u.outputTokens.toLocaleString()}</td>
                <td className="py-1 pr-3">{u.models.join(", ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {truncated && (
        <div className="mt-2 text-red-400">일부 행을 읽지 못해 합계가 불완전합니다 (truncated).</div>
      )}
      <div className="mt-2 text-gray-500">
        추정치이며 실제 청구액과 다를 수 있습니다 (단가표 기준, 캐시·할인 미반영, 웹 검색 요금 제외, 최대 약 15분 지연). {caveat}
      </div>
    </div>
  );
}
