# Active — Phase 9: OSS Ready

> **ALWAYS READ BEFORE PROCEEDING.** Then read [approach.md](approach.md) and the current slice file.
> These references are permanent. Never remove them.

## Key Files

- [vision.md](vision.md) — why we're doing this, what done looks like
- [approach.md](approach.md) — strategy, lenses, co-founder rules, session protocol
- Current slice: `slices/04-startup.md` (to be created)
- Previous slice: `slices/03-dashboard.md`

## Current State

**Phase:** 9 — OSS Ready
**Session:** 8 (Coding Standards Audit — Dashboard — COMPLETE)
**Slice:** 03-dashboard — COMPLETE (including coding standards audit)
**Next slice:** 04-startup
**Current slice file:** `slices/04-startup.md` (to be created)

### What's Done

- Vision, approach, and active files created
- 16-slice roadmap defined
- Lenses established (resilience, plugin integrity, plugin authoring simplicity, UX quality)
- Co-founder dynamic agreed
- Strategy agreed: vertical slices, RRPIR per slice, tangents welcome, no coming back
- **Slice 1 COMPLETE:** `docs/coding-standards.md` written — 10 categories of coding standards decided via deep Q&A
- **Slice 2 COMPLETE:** Repo readiness — Biome aligned (120 chars, noDefaultExport, PascalCase enums, smart constructor naming), lint split (check-only vs fix), CI parallelized (3 jobs), tests restructured (tests/unit/ mirroring src/), 13 migrations consolidated to 2, unused exports removed, safe deps updated, hardcoded paths fixed
- **Slice 3 COMPLETE:** Dashboard frontend rewrite — 5-page React SPA, all features working, coding standards enforced
  - **Session 4 (planning):** Tech stack, layout, information architecture, session phasing
  - **Session 5:** Foundation + Layout + Overview page
    - 48 new files, 6 modified root files
    - 21 devDependencies installed (React 19, Vite 8, Tailwind v4, shadcn/ui, TanStack Query v5, React Router v7, Lucide, Radix)
    - 8 shadcn/ui primitives, 5 shared components, 3 layout components, 6 hooks, 6 lib modules
    - Overview page with 6 sub-components
  - **Session 6:** Tasks — List + Immersive Detail
    - 14 new files, TanStack Table with sorting/filtering, immersive detail with 5 tabs
    - Blocked response with Cmd+Enter send, cancel endpoint
  - **Session 7:** Activity + Metrics + Errors + Polish + Cleanup
    - 17 new files: 3 UI primitives (chart, progress, switch), 1 backend endpoint (errors), 1 hook (useErrors), 2 shared components (error-boundary, keyboard shortcuts), 3 Activity components, 6 Metrics components, 2 Errors components
    - Activity: real-time SSE stream viewer with type/level filter chips, auto-scroll toggle, backfill from API + live SSE append, 500-item cap
    - Metrics: today/month spend cards, token usage stat cards, cost trend chart (Recharts), cost by task (horizontal bars), cost by phase chart, phase performance stats, quota status with progress bars
    - Errors: consolidated view combining failed tasks + error observations + error events, level filter chips, error cards with task click-through
    - Backend: `GET /api/errors` consolidated endpoint (3 sources: failed tasks, error observations, error events)
    - SSE fix: unified the disconnected listener maps so `useSseSubscription` actually delivers events
    - Polish: loading skeletons in every component, error boundary wrapping page content, keyboard navigation (g+o/t/a/m/e)
    - Cleanup: deleted old static HTML (`src/dashboard/static/index.html`), deleted old dashboard tests (2 files), removed legacy HTML fallback from server.ts, removed empty directories
    - Docs: updated `observability.md`, `architecture/overview.md`, `cli.md` to reference React SPA instead of "War Room"
    - 2 new devDependencies: @radix-ui/react-progress, @radix-ui/react-switch
  - **Session 8:** Coding Standards Audit
    - Tightened biome.json: `useFilenamingConvention` project-wide, dashboard override reduced from 10 to 4 rules
    - JSDoc on all exports, return type annotations, newspaper order fixes, abbreviation elimination across 65 files
    - Fixed sed-introduced bug in activity-page.tsx (unused loop variable)
    - All checks pass: build, 2520 tests (104 files), lint (0 errors, 10 pre-existing warnings)

### What's Next

**Slice 4: Startup & Configuration**

Read `slices/04-startup.md` (to be created), then plan:
- CLI entry, bootstrap, plugin loading, daemon startup
- Configuration validation, env var resolution
- First impressions — the "5-minute clone-and-run" experience

### Decisions Made This Phase

**Session 4 (planning):**
- Tech stack: React 19 + Vite + shadcn/ui + Tailwind CSS v4 + TanStack Query v5 + TanStack Table v8 + React Router v7 + Recharts
- Sidebar navigation (Grafana/Datadog pattern) over top tabs
- 5 views: Overview, Tasks, Activity, Metrics, Errors (consolidated from 8 tabs)
- Immersive task detail — scoped entirely to one task, no cross-task noise
- TanStack Query + URL params for state management (no Zustand)
- SSE provider with centralized cache invalidation
- No tests for dashboard (peripheral service) — delete existing dashboard API tests
- Backend changes incremental — paired with frontend features
- React source in `src/dashboard/client/` with own tsconfig/vite config
- 3 implementation sessions (5: foundation+overview, 6: tasks, 7: activity+metrics+errors+polish)

**Session 5 (implementation):**
- Tailwind v4 uses CSS-based config (`@theme` directive in globals.css), not tailwind.config.ts — deviated from plan to follow v4 conventions
- Biome `all: true` requires 10 rule overrides for React/JSX compatibility (noDefaultExport, noReactSpecificProps, useImportExtensions, etc.)
- All dashboard client deps in devDependencies (bundled by Vite, never needed at Node.js runtime)
- Old dashboard test deletion deferred to Session 7 (when old frontend is fully removed)
- Dark-only theme using oklch color space with zinc base

**Session 6 (implementation):**
- Filter chips over `<select>` for task state filtering — more visible, better UX
- Mutations use arrow returns, not async/await — `apiFetch` returns Promise, biome `useAwait` enforced
- `tsconfig.test.json` must exclude dashboard client — fixed gap from Session 5
- LLM trace row decomposed into sub-components to stay under biome complexity limit

**Session 7 (implementation):**
- SSE hook had a bug — two disconnected listener maps (ref-local vs module-level). Fixed by consolidating to single module-level `sseListeners` map
- Backend errors endpoint aggregates 3 sources (failed tasks, error observations, error events) into uniform `ErrorEntry` shape — avoids N+1 queries on the frontend
- Chart component is a lightweight wrapper (ChartContainer + ChartTooltip + CHART_COLORS), not the full shadcn/ui chart — pragmatic, covers our needs
- Keyboard shortcuts use "g then key" pattern (like GitHub) — g+o, g+t, g+a, g+m, g+e
- Activity page backfills from API then appends SSE events with deduplication — true streaming feel without missing history

**Session 8 (coding standards audit):**
- Dashboard override reduced from 10 to 4 disabled rules — only React-essential rules stay off (`noNamespaceImport`, `noReactSpecificProps`, `useImportExtensions`, `noUndeclaredVariables`)
- `useFilenamingConvention` added project-wide for kebab-case file naming enforcement
- 5 of 10 coding standards are biome-automatable; the other 5 (newspaper order, function declarations, return types, JSDoc, guard clauses) require manual review
