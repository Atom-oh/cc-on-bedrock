// Pure client-safe helpers for the asynchronous insight regenerate (admin Overview panel):
// POST /api/admin/session-insights answers 202 {date, requestedAt}; the panel polls GET
// with `insightDate` until the row is newer than the request. No AWS imports here.

export const POLL_INTERVAL_MS = 5_000;
export const POLL_TIMEOUT_MS = 3 * 60_000;

/**
 * Whether the regenerated insight has landed: the row is for `date` and was generated
 * after `requestedAt` (ISO, from the POST response).
 */
export function insightRefreshed(
  insight: { date: string; generatedAt: string } | null | undefined,
  date: string,
  requestedAt: string
): boolean {
  if (!insight || insight.date !== date) return false;
  const gen = Date.parse(insight.generatedAt);
  const req = Date.parse(requestedAt);
  return Number.isFinite(gen) && Number.isFinite(req) && gen > req;
}

/** Whether another poll fits: started at `startedAt` (ms), now `now` (ms). */
export function shouldKeepPolling(startedAt: number, now: number, timeoutMs: number = POLL_TIMEOUT_MS): boolean {
  return now - startedAt < timeoutMs;
}
