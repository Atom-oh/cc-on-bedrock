import type {
  LiteLLMKey,
  SpendLog,
  ModelMetrics,
  SpendSummary,
  ProxyHealth,
} from "./types";

const LITELLM_API_URL = process.env.LITELLM_API_URL ?? "http://localhost:4000";
const LITELLM_MASTER_KEY = process.env.LITELLM_MASTER_KEY ?? "";

async function litellmFetch<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const url = `${LITELLM_API_URL}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${LITELLM_MASTER_KEY}`,
      ...options.headers,
    },
    cache: "no-store",
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LiteLLM API error (${res.status}): ${text}`);
  }

  return res.json() as Promise<T>;
}

// ─── Health ───

export async function getProxyHealth(): Promise<ProxyHealth> {
  const url = `${LITELLM_API_URL}/health/liveness`;
  const res = await fetch(url, { cache: "no-store" });
  if (res.ok) {
    return { status: "connected" };
  }
  return { status: `error: ${res.status}` };
}

// ─── Keys ───

export async function generateKey(params: {
  user_id: string;
  key_alias?: string;
  models?: string[];
  max_budget?: number;
  tpm_limit?: number;
  rpm_limit?: number;
  duration?: string;
}): Promise<LiteLLMKey> {
  return litellmFetch<LiteLLMKey>("/key/generate", {
    method: "POST",
    body: JSON.stringify({
      ...params,
      models: params.models ?? ["claude-opus-4-6", "claude-sonnet-4-6"],
    }),
  });
}

export async function listKeys(): Promise<LiteLLMKey[]> {
  const result = await litellmFetch<{ keys: LiteLLMKey[] }>("/key/list");
  return result.keys ?? [];
}

export async function deleteKey(key: string): Promise<void> {
  await litellmFetch("/key/delete", {
    method: "POST",
    body: JSON.stringify({ keys: [key] }),
  });
}

export async function updateKey(params: {
  key: string;
  max_budget?: number;
  tpm_limit?: number;
  rpm_limit?: number;
}): Promise<LiteLLMKey> {
  return litellmFetch<LiteLLMKey>("/key/update", {
    method: "POST",
    body: JSON.stringify(params),
  });
}

// ─── Spend / Metrics ───

export async function getSpendLogs(params?: {
  user_id?: string;
  start_date?: string;
  end_date?: string;
  api_key?: string;
}): Promise<SpendLog[]> {
  // LiteLLM quirk: /spend/logs with start_date/end_date returns aggregated data.
  // Without date params (or with api_key), it returns individual log entries.
  // So we fetch all logs and filter by date client-side.
  const searchParams = new URLSearchParams();
  if (params?.api_key) searchParams.set("api_key", params.api_key);
  if (params?.user_id) searchParams.set("user_id", params.user_id);

  const qs = searchParams.toString();
  const logs = await litellmFetch<SpendLog[]>(`/spend/logs${qs ? `?${qs}` : ""}`);

  // Client-side date filtering
  if (params?.start_date || params?.end_date) {
    const start = params.start_date ?? "1970-01-01";
    const end = params.end_date ?? "2099-12-31";
    return (logs ?? []).filter((log) => {
      const logDate = (log.startTime ?? "").split("T")[0];
      return logDate >= start && logDate <= end;
    });
  }
  return logs ?? [];
}

export async function getModelMetrics(params?: {
  start_date?: string;
  end_date?: string;
}): Promise<ModelMetrics[]> {
  const searchParams = new URLSearchParams();
  if (params?.start_date) searchParams.set("start_date", params.start_date);
  if (params?.end_date) searchParams.set("end_date", params.end_date);

  const qs = searchParams.toString();
  const result = await litellmFetch<{ data: ModelMetrics[] }>(
    `/model/metrics${qs ? `?${qs}` : ""}`
  );
  return result.data ?? [];
}

export async function getSpendPerDay(params?: {
  start_date?: string;
  end_date?: string;
  user_id?: string;
}): Promise<SpendSummary[]> {
  const searchParams = new URLSearchParams();
  if (params?.start_date) searchParams.set("start_date", params.start_date);
  if (params?.end_date) searchParams.set("end_date", params.end_date);
  if (params?.user_id) searchParams.set("user_id", params.user_id);

  const qs = searchParams.toString();
  return litellmFetch<SpendSummary[]>(
    `/global/spend/report${qs ? `?${qs}` : ""}`
  );
}

export async function getTotalSpend(): Promise<{
  total_spend: number;
  total_tokens: number;
}> {
  return litellmFetch("/global/spend");
}

// ─── Admin: Key Budget Tracking ───

export interface KeySpendInfo {
  token: string;
  key_alias: string;
  key_name: string;
  spend: number;
  max_budget: number | null;
  last_active: string | null;
  created_at: string;
  metadata: Record<string, unknown>;
}

export async function getKeySpendList(): Promise<KeySpendInfo[]> {
  const result = await litellmFetch<KeySpendInfo[]>("/spend/keys");
  return result ?? [];
}

// ─── Admin: System Health Detail ───

export interface SystemHealthDetail {
  status: string;
  db: string;
  cache: string;
  litellm_version: string;
  model_count?: number;
}

export async function getSystemHealth(): Promise<SystemHealthDetail> {
  const url = `${LITELLM_API_URL}/health/readiness`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${LITELLM_MASTER_KEY}` },
    cache: "no-store",
  });
  if (!res.ok) return { status: "error", db: "unknown", cache: "unknown", litellm_version: "unknown" };
  const data = await res.json();
  return {
    status: data.status ?? "unknown",
    db: data.db ?? "unknown",
    cache: data.cache ?? "none",
    litellm_version: data.litellm_version ?? "unknown",
  };
}

// ─── Admin: Model Info ───

export async function getModelCount(): Promise<number> {
  const result = await litellmFetch<{ data: unknown[] }>("/model/info");
  return result.data?.length ?? 0;
}
