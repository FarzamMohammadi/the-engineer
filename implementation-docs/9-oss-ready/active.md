# Active — Phase 9: OSS Ready

> **ALWAYS READ BEFORE PROCEEDING.** Then read [approach.md](approach.md) and the current slice file.
> These references are permanent. Never remove them.

## Key Files

- [vision.md](vision.md) — why we're doing this, what done looks like
- [approach.md](approach.md) — strategy, lenses, co-founder rules, session protocol
- Current slice: `slices/03-dashboard.md`

## Current State

**Phase:** 9 — OSS Ready
**Session:** 4 (Dashboard planning complete)
**Slice:** 03-dashboard — PLANNING COMPLETE, implementation next
**Current slice file:** `slices/03-dashboard.md`

### What's Done

- Vision, approach, and active files created
- 16-slice roadmap defined
- Lenses established (resilience, plugin integrity, plugin authoring simplicity, UX quality)
- Co-founder dynamic agreed
- Strategy agreed: vertical slices, RRPIR per slice, tangents welcome, no coming back
- **Slice 1 COMPLETE:** `docs/coding-standards.md` written — 10 categories of coding standards decided via deep Q&A
- **Slice 2 COMPLETE:** Repo readiness — Biome aligned (120 chars, noDefaultExport, PascalCase enums, smart constructor naming), lint split (check-only vs fix), CI parallelized (3 jobs), tests restructured (tests/unit/ mirroring src/), 13 migrations consolidated to 2, unused exports removed, safe deps updated, hardcoded paths fixed
- **Slice 3 PLANNING COMPLETE:** Dashboard frontend rewrite planned — tech stack (React 19 + Vite + shadcn/ui + Tailwind v4 + TanStack Query/Table + React Router + Recharts), 5-view information architecture, sidebar layout, immersive task detail, SSE integration, session phasing (3 implementation sessions + optional polish)

### What's Next

**Session 5: Dashboard Implementation — Foundation + Layout + Overview**

Read `slices/03-dashboard.md` for the full plan, then execute Session 5 scope:
1. Create `src/dashboard/client/` React project structure
2. Install all dependencies (React 19, Vite, Tailwind v4, shadcn/ui, TanStack Query, React Router)
3. Configure build integration (vite.config, tsconfig, biome override, knip ignore)
4. Build app shell (router, query client, SSE provider)
5. Build layout (app-shell, sidebar-nav, system-bar)
6. Build shared components + lib utilities + hooks
7. Build Overview page (all sub-components)
8. Backend: update CORS, add SPA serving
9. Deliverable: Navigable SPA with working Overview, all other pages as placeholders

### Decisions Made This Session

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
