# Per-User Daily Usage Trend — Design

**Date:** 2026-06-13
**Status:** Approved (brainstorming) → pending implementation plan
**Scope:** Dashboard (`shared/nextjs-app`) only. No IaC / Lambda / schema changes.

## Problem

The monitoring dashboard shows per-date totals (all users summed) and
per-user totals (whole window summed), but **not the cross-product**: there is
no view of each user's usage *over time*. An admin cannot see "who spent what,
on which day" — e.g. the 2026-06-11 psungbum spike vs. the 6-12 drop is
invisible as a trend. Users/dept-managers have no per-user time view either.

The underlying data already carries both dimensions: every
`cc-on-bedrock-usage` row is keyed `PK=USER#{subdomain}`, `SK={date}#{model}`
with `estimatedCost`, `totalTokens`, etc. This is purely an **aggregation +
presentation** gap — no new data capture, schema, or Lambda work.

## Goals

- Multi-line chart: X = date, one line per user, for a selected date range.
- Toggle between **cost ($)** and **total tokens** on the same chart.
- Three audiences, each scoped server-side:
  - **admin** → all users
  - **dept-manager** → their own department's users only
  - **regular user** → their own single series (self-view)
- Top-N users by window total drawn individually; the rest rolled into one
  `others` line so 30+ users stay readable with nothing silently dropped.

## Non-Goals (YAGNI)

- Hourly granularity (daily is sufficient).
- CSV export, alerting, scheduled reports.
- New DynamoDB GSI. Current scan + `department` FilterExpression is adequate at
  present user counts; revisit `dept-date-index` only past a few hundred users.
  **Caveat (codex finding #5):** `getUsageRecords` paginates the Scan but caps at
  `MAX_PAGES`, so an over-wide window can silently truncate. Mitigation in this
  feature: default the chart to a bounded window (e.g. last 30 days) and, if the
  Scan hits `MAX_PAGES`, surface a "range truncated — narrow the dates" notice
  rather than showing partial data as if complete. A GSI is the real fix later.

## Architecture

Three thin layers, each reusing existing primitives.

### 1. Aggregation — `usage-client.ts`

New function `getUserDailyTrend()`. Keeps existing `getDailyUsage` (date-only)
and `getUserSummaries` (user-only) untouched; this returns their intersection.

```ts
interface UserDailyTrendPoint {
  date: string;                          // X-axis
  [seriesKey: string]: number | string;  // one numeric field per user series
}

interface UserDailyTrendSeries {
  key: string;        // userId (subdomain) or "others"
  name: string;       // display label
  totalCost: number;  // window total — used for Top-N ranking + legend
}

interface UserDailyTrend {
  cost:   UserDailyTrendPoint[];   // same dates, cost values
  tokens: UserDailyTrendPoint[];   // same dates, token values
  series: UserDailyTrendSeries[];  // Top-N + optional "others"
  othersCount: number;             // n users folded into "others" (0 if none)
}

async function getUserDailyTrend(params: {
  startDate: string;
  endDate: string;
  department?: string;   // when set, only this department's records
  userId?: string;       // when set, only this user (self-view single series)
  topN?: number;         // default 8
}): Promise<UserDailyTrend>;
```

> **Consensus review fix (codex+gemini, 2/2):** `userId` was missing from the
> original signature, leaving the regular-user self-view with no data-layer
> scoping path. `getUsageRecords` already supports `userId` (a single-partition
> Query); pass it through. When `userId` is set, Top-N/others is moot (one
> series).

Logic:
1. `getUsageRecords({ startDate, endDate, department, userId })` — supports all
   three filters (userId → Query on one partition; department → Scan + filter).
2. Pivot to `(userId × date)` summing `estimatedCost` and `totalTokens`.
3. Rank users by window-total cost; keep top `topN`, fold the rest into a single
   `others` series (summed per date). Set `othersCount`. The series set is fixed
   by **cost ranking and does not change when the UI toggles to tokens** — so
   lines never appear/disappear on toggle (stable legend). A token-heavy user
   outside the cost top-N therefore shows inside `others`; acceptable trade-off
   for a stable view (independently flagged by gemini — accepted, not a defect).
4. Emit parallel `cost[]` and `tokens[]` point arrays over the **same** date
   axis so the client toggle needs no refetch. The axis is the **full calendar
   range** `startDate..endDate` (every day generated, zero-filled), not just
   dates that appear in records — so zero-usage days render as zero, not gaps
   (codex finding #6).

### 2. API — `/api/usage/route.ts`

New branch **`action=user_daily_trend`**. The existing route dispatches on the
`action` query param via `switch (action)` (NOT `type`) — the branch and all UI
fetches must use `action` or they never reach the handler (codex finding #4).
**Scope is decided server-side from the session; client-supplied scope params
are ignored** (security boundary):

| Session role                       | Effective filter                         |
|------------------------------------|------------------------------------------|
| `isAdmin`                          | none (all users)                         |
| `isDeptManager` (not admin)        | `department = session.department` forced |
| neither                            | `userId = session.subdomain` forced (single series) |

**Fail-closed on missing scope attribute (codex finding #2 — high).** The
existing route uses `effectiveUserId = isAdmin ? userId : session.subdomain`,
which **fails open**: if a non-admin's `subdomain` (or a dept-manager's
`department`) is `undefined`, the filter is dropped and the query returns *all*
users. This branch MUST instead return **403** when the required scope attribute
is absent:
- dept-manager with empty `session.department` → 403 (never an unfiltered scan)
- regular user with empty `session.subdomain` → 403
Only `isAdmin` may run with no scope filter.

Date range comes from existing `start_date` / `end_date` query params (same as
other `/api/usage` types). `topN` accepts an optional clamp (default 8, max ~15).

**Date-range validation up front (kiro finding — medium).** Validate the window
*before* querying, independent of the MAX_PAGES truncation notice: require
`start_date <= end_date`, reject future-dated ranges, and cap the span (e.g. ≤ 92
days) → `400` on violation. This bounds Scan cost and gives a clear error instead
of a silently truncated chart.

### 3. Auth — `auth.ts` + `types.ts`

Session currently exposes `groups`, `isAdmin`, `subdomain` but **not**
`department` or a dept-manager flag. Add (mirroring how `subdomain` is read from
`custom:subdomain`):

- JWT/token: `token.department = custom:department` (both cognito and
  credentials paths, lines ~105 and ~116).
- `UserSession` (in `types.ts`): add `department?: string` and
  `isDeptManager: boolean`.
- Session assembly (`auth.ts` ~line 140): `isDeptManager:
  groups.includes("dept-manager")`, `department: token.department`.

### 4. UI — one component, three mounts

New `components/charts/user-daily-trend-chart.tsx` wrapping the existing
`MultiLineChart` (`data: Record<string,unknown>[]`, `series: {key,name,color}[]`,
`yFormatter`). Adds:
- cost ↔ token toggle (switches which point array + `yFormatter` it feeds
  `MultiLineChart`; no refetch).
- assigns a stable color per series key; `others` gets a muted gray.
- caption when `othersCount > 0`: e.g. "Top 8 users shown · others (n) folded".

Mounts — **placement revised per codex finding #3 (high).** `/monitoring`
redirects every non-admin at the page level
(`monitoring/page.tsx`: `if (!session.user.isAdmin) redirect("/analytics")`) and
also hosts admin-only health/container/infra panels. Relaxing that guard to admit
dept-managers would expose all of that, not just the new chart. So instead of
opening `/monitoring`, mount the chart where each audience already has access:

- **`/monitoring`** (admin only) — new section; admin sees all users. Page guard
  unchanged.
- **`/analytics`** — non-admins already reach this page (the monitoring redirect
  sends them here). Mount the same `UserDailyTrendChart` here for **both**
  dept-managers and regular users. The server scope (section 2) decides what they
  get: dept-manager → their department's multi-line; regular user → own single
  line. No page-guard change needed, and no admin-only content is exposed.

This keeps RBAC at two layers: the page each role can already load, plus the
server-side scope that fills the chart.

Date range uses the existing `FilterBar`.

## Data Flow

```
DynamoDB cc-on-bedrock-usage (PK=USER#{subdomain}, SK={date}#{model})
   │  getUsageRecords({startDate,endDate,department?,userId?})   ← existing
   ▼
getUserDailyTrend()  → pivot (user×date) → Top-N + others → {cost[],tokens[],series[]}
   │  /api/usage?action=user_daily_trend  (server-side RBAC scope)
   ▼
UserDailyTrendChart  → MultiLineChart + cost/token toggle + others caption
   ├── /monitoring   (admin only: all users — page guard unchanged)
   └── /analytics    (dept-manager: own dept multi-line · user: own single series)
```

## RBAC / Security

- The only trusted scope source is the NextAuth session. The API derives the
  filter from `session.user.{isAdmin,isDeptManager,department,subdomain}` and
  **never** reads a department/user scope from the request body or query for
  authorization. A dept-manager cannot widen to other departments by tampering
  with params; a regular user is always pinned to their own `subdomain`.
- **Deliberately diverges** from the existing `/api/usage` pattern
  `effectiveUserId = session.user.isAdmin ? userId : session.user.subdomain`,
  which fails *open* (undefined scope → unfiltered). This branch fails *closed*:
  a non-admin missing the required scope attribute gets `403`, never all-users.

## Testing

- **Unit (vitest, `src/lib/__tests__/`)** for `getUserDailyTrend`:
  - pivot correctness — known records → expected per-(user,date) cost/token cells.
  - Top-N + others — N+3 users → exactly N individual series + one `others`
    equal to the sum of the folded users; `othersCount === 3`.
  - zero-fill — a user absent on a date yields 0, not a gap.
  - department filter passes through to `getUsageRecords`.
- **API scope test** — assert the route forces `department`/`userId` from
  session regardless of incoming params (admin vs dept-manager vs user).
- **Fail-closed test (codex #2)** — dept-manager with empty `session.department`
  and regular user with empty `session.subdomain` each get **403**, never an
  unfiltered result set.
- **Full-date-axis test (codex #6)** — a window with a gap day yields a zero
  point for that day in every series, not a missing date.
- **Type check** — `npx tsc --noEmit`.
- Manual: 6-11/6-12 window → psungbum + atomoh lines match the verified
  $5.55 / $0.55 figures; toggle flips to tokens; dept-manager login sees only
  their department.

## Affected Files

- `shared/nextjs-app/src/lib/usage-client.ts` — `getUserDailyTrend` + interfaces
- `shared/nextjs-app/src/app/api/usage/route.ts` — `action=user_daily_trend` branch
- `shared/nextjs-app/src/lib/auth.ts` — session `department` + `isDeptManager`
- `shared/nextjs-app/src/lib/types.ts` — `UserSession` fields
- `shared/nextjs-app/src/components/charts/user-daily-trend-chart.tsx` — new
- `shared/nextjs-app/src/app/monitoring/monitoring-dashboard.tsx` — mount (admin only)
- `shared/nextjs-app/src/app/analytics/analytics-dashboard.tsx` — mount (dept-manager dept view + regular-user self-view)
- `shared/nextjs-app/src/lib/__tests__/` — new unit tests
- `shared/nextjs-app/CLAUDE.md` — document the new lib fn + API type
