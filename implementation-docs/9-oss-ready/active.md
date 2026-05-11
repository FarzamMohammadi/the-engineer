# Active — Phase 9: OSS Ready

> **ALWAYS READ BEFORE PROCEEDING.** Then read [approach.md](approach.md) and the current slice file.
> These references are permanent. Never remove them.

## Key Files

- [vision.md](vision.md) — why we're doing this, what done looks like
- [approach.md](approach.md) — strategy, lenses, co-founder rules, session protocol
- Current slice: `slices/03-dashboard.md`

## Current State

**Phase:** 9 — OSS Ready
**Session:** 5 (Dashboard foundation + layout + overview — COMPLETE)
**Slice:** 03-dashboard — Session 5 COMPLETE, Session 6 next
**Current slice file:** `slices/03-dashboard.md`

### What's Done

- Vision, approach, and active files created
- 16-slice roadmap defined
- Lenses established (resilience, plugin integrity, plugin authoring simplicity, UX quality)
- Co-founder dynamic agreed
- Strategy agreed: vertical slices, RRPIR per slice, tangents welcome, no coming back
- **Slice 1 COMPLETE:** `docs/coding-standards.md` written — 10 categories of coding standards decided via deep Q&A
- **Slice 2 COMPLETE:** Repo readiness — Biome aligned (120 chars, noDefaultExport, PascalCase enums, smart constructor naming), lint split (check-only vs fix), CI parallelized (3 jobs), tests restructured (tests/unit/ mirroring src/), 13 migrations consolidated to 2, unused exports removed, safe deps updated, hardcoded paths fixed
- **Slice 3 PLANNING COMPLETE:** Dashboard frontend rewrite planned — tech stack, layout, information architecture, session phasing (Sessions 5-7)
- **Slice 3 SESSION 5 COMPLETE:** Foundation + Layout + Overview page implemented
  - 48 new files in `src/dashboard/client/` (43 source + 5 config/docs)
  - 6 modified root files (biome.json, knip.json, package.json, pnpm-lock.yaml, tsconfig.json, src/dashboard/server.ts)
  - 21 devDependencies installed (React 19, Vite 8, Tailwind v4, shadcn/ui, TanStack Query v5, React Router v7, Lucide, Radix)
  - 8 shadcn/ui primitives, 5 shared components, 3 layout components, 6 hooks, 6 lib modules
  - Overview page with 6 sub-components (daemon status, active tasks, blocked tasks, cost ticker, recent errors, activity snapshot)
  - 4 placeholder pages (Tasks, Activity, Metrics, Errors)
  - Backend: CORS updated for Vite dev server, SPA catch-all serving from dist/dashboard/
  - All checks pass: build, tests, lint (biome + tsc + knip + madge), dev server

### What's Next

**Session 6: Dashboard Implementation — Tasks (List + Immersive Detail)**

Read `slices/03-dashboard.md` Session 6 scope, then execute:
1. Install shadcn/ui components: table, textarea, select, collapsible, input
2. Install TanStack Table v8
3. Build task list: task-table with TanStack Table, task-filters (state chips), tasks-page
4. Build task detail page: header, phase pipeline, back nav
5. Build all 5 detail tabs: overview, timeline, phases, LLM calls, tools
6. Build blocked-response component (conversation thread + textarea)
7. Backend: add `POST /api/tasks/:id/cancel` endpoint
8. Deliverable: Complete Tasks flow — list → immersive detail with all tabs

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
