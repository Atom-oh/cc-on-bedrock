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
  topN?: number;         // default 8
}): Promise<UserDailyTrend>;
```

Logic:
1. `getUsageRecords({ startDate, endDate, department })` — already supports both
   filters.
2. Pivot to `(userId × date)` summing `estimatedCost` and `totalTokens`.
3. Rank users by window-total cost; keep top `topN`, fold the rest into a single
   `others` series (summed per date). Set `othersCount`. The series set is fixed
   by **cost ranking and does not change when the UI toggles to tokens** — so
   lines never appear/disappear on toggle (stable legend). A token-heavy user
   outside the cost top-N therefore shows inside `others`; acceptable trade-off
   for a stable view.
4. Emit parallel `cost[]` and `tokens[]` point arrays over the **same** date
   axis (zero-filled for missing user/date cells) so the client toggle needs no
   refetch.

### 2. API — `/api/usage/route.ts`

New branch `type=user_daily_trend`. **Scope is decided server-side from the
session; client-supplied scope params are ignored** (security boundary):

| Session role                       | Effective filter                         |
|------------------------------------|------------------------------------------|
| `isAdmin`                          | none (all users)                         |
| `isDeptManager` (not admin)        | `department = session.department` forced |
| neither                            | `userId = session.subdomain` forced (single series) |

Date range comes from existing `start_date` / `end_date` query params (same as
other `/api/usage` types). `topN` accepts an optional clamp (default 8, max ~15).

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

Mounts:
- **`/monitoring`** (admin) — new section, fetches `type=user_daily_trend`.
- **dept-manager** — same `/monitoring` section is visible to dept-managers
  (server scopes to their department automatically). Gate the section on
  `isAdmin || isDeptManager`.
- **`/analytics`** self-view — same component; server returns the single
  own-user series, so it renders one line.

Date range uses the existing `FilterBar`.

## Data Flow

```
DynamoDB cc-on-bedrock-usage (PK=USER#{subdomain}, SK={date}#{model})
   │  getUsageRecords({startDate,endDate,department?})   ← existing
   ▼
getUserDailyTrend()  → pivot (user×date) → Top-N + others → {cost[],tokens[],series[]}
   │  /api/usage?type=user_daily_trend  (server-side RBAC scope)
   ▼
UserDailyTrendChart  → MultiLineChart + cost/token toggle + others caption
   ├── /monitoring   (admin: all · dept-manager: own dept)
   └── /analytics    (user: own single series)
```

## RBAC / Security

- The only trusted scope source is the NextAuth session. The API derives the
  filter from `session.user.{isAdmin,isDeptManager,department,subdomain}` and
  **never** reads a department/user scope from the request body or query for
  authorization. A dept-manager cannot widen to other departments by tampering
  with params; a regular user is always pinned to their own `subdomain`.
- Mirrors the existing pattern in `/api/usage` where
  `effectiveUserId = session.user.isAdmin ? userId : session.user.subdomain`.

## Testing

- **Unit (vitest, `src/lib/__tests__/`)** for `getUserDailyTrend`:
  - pivot correctness — known records → expected per-(user,date) cost/token cells.
  - Top-N + others — N+3 users → exactly N individual series + one `others`
    equal to the sum of the folded users; `othersCount === 3`.
  - zero-fill — a user absent on a date yields 0, not a gap.
  - department filter passes through to `getUsageRecords`.
- **API scope test** — assert the route forces `department`/`userId` from
  session regardless of incoming params (admin vs dept-manager vs user).
- **Type check** — `npx tsc --noEmit`.
- Manual: 6-11/6-12 window → psungbum + atomoh lines match the verified
  $5.55 / $0.55 figures; toggle flips to tokens; dept-manager login sees only
  their department.

## Affected Files

- `shared/nextjs-app/src/lib/usage-client.ts` — `getUserDailyTrend` + interfaces
- `shared/nextjs-app/src/app/api/usage/route.ts` — `type=user_daily_trend` branch
- `shared/nextjs-app/src/lib/auth.ts` — session `department` + `isDeptManager`
- `shared/nextjs-app/src/lib/types.ts` — `UserSession` fields
- `shared/nextjs-app/src/components/charts/user-daily-trend-chart.tsx` — new
- `shared/nextjs-app/src/app/monitoring/monitoring-dashboard.tsx` — mount (admin + dept-manager)
- `shared/nextjs-app/src/app/analytics/analytics-dashboard.tsx` — mount (self-view)
- `shared/nextjs-app/src/lib/__tests__/` — new unit tests
- `shared/nextjs-app/CLAUDE.md` — document the new lib fn + API type
