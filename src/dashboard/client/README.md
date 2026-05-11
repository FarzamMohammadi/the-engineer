# Dashboard Client

React SPA for monitoring The Engineer's daemon, tasks, and system health.

## Quick Start

```bash
# From repo root

# 1. Install dependencies (if not done)
pnpm install

# 2. Start the daemon (serves API on :3847)
pnpm dev

# 3. In a separate terminal — start the Vite dev server
pnpm dev:dashboard
# Opens at http://localhost:5173 — proxies /api to :3847
```

Production build:

```bash
pnpm build:dashboard   # outputs to dist/dashboard/
pnpm build             # full build (includes dashboard)
```

When built, the Hono server at `:3847` serves the SPA directly — no separate process needed.

## Tech Stack

| Layer         | Library                          |
| ------------- | -------------------------------- |
| Framework     | React 19                         |
| Bundler       | Vite 8                           |
| Styling       | Tailwind CSS v4 (CSS-based config) |
| Components    | shadcn/ui (Radix primitives)     |
| Data fetching | TanStack Query v5                |
| Routing       | React Router v7 (library mode)   |
| Real-time     | SSE via EventSource              |

## Project Structure

```
src/dashboard/client/
  index.html              # HTML entry point
  vite.config.ts          # Vite config (proxy, output, plugins)
  tsconfig.json           # Client-specific TypeScript config
  components.json         # shadcn/ui config
  src/
    main.tsx              # React root mount
    app.tsx               # Router + providers
    globals.css           # Tailwind v4 theme (dark-only, oklch)
    types/
      api.ts              # API response types (mirrors backend)
    lib/
      api-client.ts       # Typed fetch wrapper
      cn.ts               # clsx + tailwind-merge utility
      constants.ts        # State colors, phase labels, stale times
      formatters.ts       # Currency, duration, tokens, time
      query-keys.ts       # TanStack Query key factory
      routes.ts           # Route path constants
    hooks/
      use-sse.ts          # SSE connection with auto-reconnect
      use-system-status.ts
      use-tasks.ts
      use-metrics.ts
      use-observations.ts
      use-events.ts
    components/
      ui/                 # shadcn/ui primitives (card, button, badge, etc.)
      shared/             # Domain components (StateBadge, PhasePipeline, etc.)
      layout/             # AppShell, SidebarNav, SystemBar
    pages/
      overview/           # Dashboard home — daemon, tasks, cost, errors
      tasks/              # Task list + detail (placeholder)
      activity/           # Event stream (placeholder)
      metrics/            # Cost & token charts (placeholder)
      errors/             # Error log (placeholder)
```

## Routes

| Path              | Page     | Status      |
| ----------------- | -------- | ----------- |
| `/`               | Overview | Implemented |
| `/tasks`          | Tasks    | Placeholder |
| `/tasks/:taskId`  | Detail   | Placeholder |
| `/activity`       | Activity | Placeholder |
| `/metrics`        | Metrics  | Placeholder |
| `/errors`         | Errors   | Placeholder |

## Architecture Notes

- **Dark-only** theme using oklch color space in CSS variables.
- **SSE-driven updates**: the backend pushes observations and events; the client uses `useSseSubscription` to invalidate TanStack Query caches on new data.
- **API proxy**: Vite dev server proxies `/api/*` to `localhost:3847` so the client and server run on different ports during development.
- **Production serving**: the built SPA is served by `src/dashboard/server.ts` (Hono) with SPA catch-all routing.
- **No default exports** rule is relaxed for this directory (Vite/React conventions). Biome overrides are configured in the root `biome.json`.
- **Separate tsconfig**: the client has its own `tsconfig.json` with `react-jsx`, bundler module resolution, and path aliases (`@/*` maps to `./src/*`). The root `tsconfig.json` excludes this directory.
