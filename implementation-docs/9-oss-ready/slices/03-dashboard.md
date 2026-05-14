# Slice 3: Dashboard — Complete Frontend Rewrite

**Status:** COMPLETE
**Sessions:** 4 (planning), 5-7 (implementation), 8 (coding standards audit)
**Session 5 completed:** 2026-05-11
**Session 6 completed:** 2026-05-11
**Session 7 completed:** 2026-05-12
**Session 8 completed:** 2026-05-13

## Goal

Rewrite the dashboard frontend as a proper React SPA focused on **observability** — total transparency into what The Engineer is doing at any moment. The backend API stays and gets refined incrementally where needed.

The current frontend is a 2,400-line monolithic HTML file with embedded CSS/JS — 32 global functions, imperative DOM manipulation, no components, no routing. It works but it's unmaintainable and doesn't surface information well.

The new dashboard is a read-heavy observability control room. The admin can see everything, debug anything, and respond to blocked tasks. No tests (peripheral service). Documentation stays in sync.

---

## Tech Stack

| Layer | Choice | Why |
|-------|--------|-----|
| UI Framework | React 19 + Vite | Full ecosystem, shadcn/ui requires React |
| Components | shadcn/ui + Tailwind CSS v4 | Pre-built, polished, zero custom UI chrome |
| Data Fetching | TanStack Query v5 | Caching, polling, SSE invalidation |
| Tables | TanStack Table v8 | Sorting, filtering, expanding rows |
| Routing | React Router v7 | Deep-linking, browser back/forward |
| Charts | Recharts (via shadcn/ui charts) | Cost trends, phase performance |
| Icons | Lucide React | shadcn/ui default icon set |

---

## Layout

Sidebar navigation (Grafana/Datadog pattern). Left sidebar with 5 nav links, system bar across the top of the content area, main content fills the rest. Maximum vertical space for data.

---

## Project Structure

```
src/dashboard/
  index.ts                    # startDashboard() — keep as-is
  server.ts                   # Hono app — modify for SPA serving
  api/                        # Backend routes — keep, refine incrementally
  client/                     # NEW — React SPA
    index.html
    vite.config.ts
    tsconfig.json
    tailwind.config.ts
    postcss.config.js
    components.json            # shadcn/ui config
    src/
      main.tsx                 # React root mount
      app.tsx                  # RouterProvider + QueryClient + SSE
      globals.css              # Tailwind base + theme variables

      components/
        ui/                    # shadcn/ui installed components
        layout/
          app-shell.tsx        # Sidebar + system bar + <Outlet />
          sidebar-nav.tsx      # 5 nav links with active states
          system-bar.tsx       # Status dot, counters, cost, SSE
        shared/
          state-badge.tsx      # Task state with color coding
          phase-pipeline.tsx   # RRPIR phase visualization
          cost-display.tsx     # Currency formatting
          time-ago.tsx         # Relative timestamps
          json-viewer.tsx      # Expandable JSON for traces
          empty-state.tsx      # Consistent empty messaging

      pages/
        overview/
          overview-page.tsx
          daemon-status.tsx
          active-tasks-card.tsx
          blocked-tasks-card.tsx
          cost-ticker.tsx
          recent-errors.tsx
          activity-snapshot.tsx

        tasks/
          tasks-page.tsx            # List view
          task-detail-page.tsx      # Immersive detail (own route)
          task-table.tsx            # TanStack Table
          task-filters.tsx          # State filter chips
          task-overview-tab.tsx     # State, metadata, blocked details
          task-timeline-tab.tsx     # Unified chronological feed
          task-phases-tab.tsx       # RRPIR breakdown cards
          task-llm-tab.tsx          # LLM call inspector
          task-tools-tab.tsx        # Tool execution log
          blocked-response.tsx      # Response textarea + conversation

        activity/
          activity-page.tsx         # Real-time SSE stream viewer
          activity-feed.tsx         # Structured log entries
          activity-filters.tsx      # Type, task, level filters

        metrics/
          metrics-page.tsx
          cost-trend-chart.tsx      # Per-day bar/line (Recharts)
          cost-by-task.tsx          # Top-N horizontal bars
          cost-by-phase.tsx         # Phase breakdown chart
          token-usage.tsx           # Input/output/cache stat cards
          phase-performance.tsx     # Avg duration, avg cost
          quota-status.tsx          # Progress bars

        errors/
          errors-page.tsx
          error-list.tsx            # Combined error view
          error-card.tsx            # Error detail + click-through

      hooks/
        use-sse.ts                 # SSE connection + event distribution
        use-system-status.ts       # /api/system/status polling
        use-tasks.ts               # Task list + detail queries
        use-metrics.ts             # Cost + quota queries
        use-observations.ts        # Observation queries
        use-events.ts              # Event queries

      lib/
        api-client.ts              # Typed fetch wrapper
        formatters.ts              # fmt$, fmtMs, fmtTime, etc.
        constants.ts               # State colors, phase labels
        query-keys.ts              # TanStack Query key factory
        routes.ts                  # Route path constants

      types/
        api.ts                     # TS interfaces for API responses
```

---

## Routing

```
/                           → Overview (home)
/tasks                      → Task list
/tasks/:taskId              → Task detail (overview tab default)
/tasks/:taskId/timeline     → Task detail timeline
/tasks/:taskId/phases       → Task detail phases
/tasks/:taskId/llm          → Task detail LLM calls
/tasks/:taskId/tools        → Task detail tools
/activity                   → Activity feed
/metrics                    → Metrics & cost
/errors                     → Errors
```

---

## Information Architecture (5 Views)

### 1. Overview — "Is everything OK?"

- Daemon status card (running/stopped, PID, uptime)
- Active tasks at a glance (title, phase, time elapsed)
- **Blocked tasks prominently surfaced** (these need attention NOW)
- Cost ticker: today / this month
- Recent error count with severity
- Latest activity snapshot (last ~10 items from SSE)

### 2. Tasks — "What is The Engineer working on?"

**List view:** TanStack Table with columns: title, state badge, phase, cost, tokens, last transition. Sortable. State filter chips at top. Click row → navigate to detail.

**Detail view (immersive, full-page, scoped to ONE task):**

When the admin drills into a task, everything on screen is scoped to that task only. No cross-task noise. You're watching one engineer work on one task.

- Back button to list
- Header: title, state badge, phase pipeline visualization
- If blocked: response UI prominently at top (not buried in a tab)
- Sub-tabs:
  - **Overview:** State, sub_state, metadata, acceptance criteria, decisions, blocked details
  - **Timeline:** Unified chronological feed (state changes + journal + tool executions). Color-coded by kind, filterable.
  - **Phases:** RRPIR cards — which ran, duration bar, cost, LLM iterations, status
  - **LLM Calls:** Inspector — each call shows model, tokens, cost, latency. Expandable prompt/response from blob store (lazy loaded).
  - **Tools:** Execution log — tool name, status (ok/error), duration, expandable input/output

### 3. Activity — "What's happening RIGHT NOW?"

- Real-time SSE stream, structured log viewer (not raw dump)
- Each entry: timestamp, type badge, name, task link, level indicator
- Filterable by observation type, event type, task ID, level
- Auto-scroll with pause on hover
- Capped at 500 items in view
- SSE events appended directly (no API re-fetch for real-time feel)

### 4. Metrics — "How much am I spending?"

- Cost trend chart (per-day, last 30 days) — Recharts bar/line
- Cost by task (top-20) — horizontal bar chart
- Cost by phase — breakdown chart
- Token usage stat cards (input / output / cache read / total)
- Phase performance (avg duration, avg cost per phase type)
- Quota status with progress bars + reset time

### 5. Errors — "What went wrong?"

- Failed tasks with failure reason
- Error-level observations with context
- Health events
- Each entry links to task detail for full trace
- Level filter (error / warn)

---

## SSE Integration

1. `SSEProvider` at app root — single EventSource to `/api/stream`, manages reconnection with exponential backoff
2. `useSSE(eventType, callback)` hook — components subscribe to specific events
3. Centralized cache invalidation in `app.tsx`:
   - `task.state_changed` / `task.created` → invalidate `["tasks"]` + `["system-status"]`
   - `phase_transition` → invalidate `["tasks", taskId, "phases"]` + `["metrics-cost"]`
   - `error` observation → invalidate `["errors"]`, increment error badge
   - Any observation → invalidate `["system-status"]` (updates trace counts)
4. Activity page: SSE events appended to local array (true streaming, no re-fetch)
5. Task detail: SSE observations for viewed task ID update relevant tab in real-time

**TanStack Query stale times:**

- System status: 3s (lightweight)
- Task list: 5s (SSE supplements)
- Task detail: 10s (SSE handles real-time)
- Metrics: 30s (expensive, SSE triggers refresh)
- Blob content: Infinity (immutable)

---

## Build Integration

### Root config changes

- `tsconfig.json`: Add `"exclude": ["src/dashboard/client"]`
- `biome.json`: Add override for `src/dashboard/client/**` — relax `noDefaultExport`
- `knip.json`: Add `src/dashboard/client/**` to ignore (separate toolchain)
- `package.json`: Add build/dev scripts, add React + tooling dependencies
- `.gitignore`: No changes needed (`dist/` already ignored)

### New scripts in package.json

```json
"build:dashboard": "vite build --config src/dashboard/client/vite.config.ts",
"dev:dashboard": "vite --config src/dashboard/client/vite.config.ts",
"build": "tsdown src/index.ts --format esm && cp -r src/db/migrations dist/migrations && pnpm run build:dashboard"
```

### Vite config

- Root: `src/dashboard/client/`
- Output: `dist/dashboard/`
- Dev server: port 5173, proxy `/api/*` → `http://localhost:3847`

### Client tsconfig

- Target: ES2022, Module: ESNext, JSX: react-jsx, moduleResolution: bundler
- Separate from root tsconfig entirely

### Hono server changes (server.ts)

- Serve built SPA from `dist/dashboard/` with `serveStatic()`
- SPA catch-all: any non-`/api/*` request returns `index.html` (client-side routing)
- CORS: add `http://localhost:5173` for Vite dev server
- Remove old `readFileSync(htmlPath)` approach

---

## Backend Changes (Incremental)

Only where needed for the frontend. Done in the same session as the feature:

1. **Session 5 (upfront):** CORS update + SPA serving in `server.ts`
2. **Session 6:** New `POST /api/tasks/:id/cancel` endpoint (transitions task to failed)
3. **Session 7:** Optimize `/api/metrics/cost` — replace in-memory loops over 50K+ observations with SQL aggregation queries. New `GET /api/errors` consolidated endpoint.

---

## Files to Delete

- `src/dashboard/static/index.html` — replaced by React SPA
- `tests/unit/dashboard/api/api.test.ts` — no dashboard tests
- `tests/unit/dashboard/api/messages.test.ts` — no dashboard tests

---

## Documentation Updates

Files referencing the dashboard that need updating after rewrite:

- `docs/contribution-docs/how-tos/observability.md` — "Dashboard Integration" section
- `docs/architecture/overview.md` — mentions War Room dashboard
- `docs/cli.md` — mentions War Room in startup sequence

Light touch: update file paths and descriptions where they reference old static HTML.

---

## Session Phasing

### Session 5: Foundation + Layout + Overview

1. Create `src/dashboard/client/` structure
2. Install deps: React 19, Vite, Tailwind v4, shadcn/ui, TanStack Query, React Router
3. Configure: vite.config.ts, tsconfig.json, tailwind theme (port existing color palette)
4. Install shadcn/ui base components: button, card, badge, separator, tabs, tooltip, skeleton, scroll-area
5. Build app shell: router, query client, SSE provider
6. Build layout: `app-shell.tsx`, `sidebar-nav.tsx`, `system-bar.tsx`
7. Build shared components: state-badge, phase-pipeline, cost-display, time-ago, empty-state
8. Build `lib/`: api-client, formatters, constants, query-keys, routes
9. Build `types/api.ts`
10. Build all hooks
11. Build Overview page (all 6 sub-components)
12. Backend: update CORS, add SPA serving, update build scripts
13. Config: update tsconfig, biome, knip

**Deliverable:** Navigable SPA with working Overview, all other pages as placeholders.

### Session 6: Tasks (List + Immersive Detail)

1. Install shadcn/ui: table, textarea, select, collapsible, input
2. Install TanStack Table
3. Build task list: task-table, task-filters, tasks-page
4. Build task detail page: header, phase pipeline, back nav
5. Build all 5 detail tabs: overview, timeline, phases, LLM calls, tools
6. Build blocked-response component (conversation thread + textarea)
7. Backend: add `/api/tasks/:id/cancel`

**Deliverable:** Complete Tasks flow — list → immersive detail with all tabs.

### Session 7: Activity + Metrics + Errors + Polish

1. Install shadcn/ui: chart, progress, switch
2. Install Recharts
3. Build Activity page: feed, filters, SSE streaming
4. Build Metrics page: all 6 chart/stat components
5. Build Errors page: list, cards, click-through
6. Backend: optimize metrics queries, add `/api/errors` endpoint
7. Polish: loading skeletons, error boundaries, keyboard shortcuts
8. Delete old HTML + old tests
9. Update documentation

**Deliverable:** Complete 5-page SPA, all features working, old frontend removed.

### Session 8 (if needed): Final Polish

- Backend query layer extraction if handlers are still messy
- Performance profiling on large datasets
- Edge case handling
- Any remaining doc updates

---

## Verification (Each Implementation Session)

1. `pnpm dev:dashboard` — Vite dev server starts, proxies API calls
2. Start the daemon separately (`pnpm dev`) to have a real API backend
3. Navigate all 5 pages, verify data loads
4. Check SSE connection indicator (system bar)
5. Verify task drill-down: list → detail → back
6. `pnpm build` — full build succeeds (tsdown + vite)
7. `pnpm lint` — passes (biome + tsc + knip + madge)
8. Test with no data (empty DB) — empty states render correctly

---

## Decisions Made

1. React 19 + Vite + shadcn/ui + Tailwind v4 — leverage ecosystem, spend zero effort on custom UI chrome
2. Sidebar navigation (Grafana/Datadog pattern) — more vertical space for data
3. 5 views (Overview, Tasks, Activity, Metrics, Errors) — down from 8 tabs in current dashboard
4. Immersive task detail — when you drill in, everything is scoped to that one task
5. TanStack Query + URL params for state — no Zustand, component state + URL is sufficient
6. SSE-driven cache invalidation — real-time updates without constant polling of expensive endpoints
7. No tests — peripheral service, type safety is the primary defense
8. Backend refines incrementally — not a big-bang rewrite, each change pairs with its frontend feature
9. Delete existing dashboard tests — no maintenance burden for a peripheral service
10. Frontend source in `src/dashboard/client/` — co-located with backend API routes

**Session 6 (implementation):**
- Filter chips (badge buttons) preferred over `<select>` for task state filtering — more visible, faster interaction
- Mutations use arrow returns (not `async/await`) since `apiFetch` already returns a Promise — satisfies biome `useAwait` rule
- `tsconfig.test.json` must exclude `src/dashboard/client` — Session 5 gap, fixed in Session 6
- LLM trace row split into `parseLlmMeta` + `LlmTraceHeader` sub-components to stay under biome complexity threshold

## Discovered from Other Slices

(None yet — this is the first user-facing slice)
