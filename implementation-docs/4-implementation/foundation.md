# Foundation — Technology Choices

The technology stack for The Engineer. Every choice here serves two masters: works for v1 (single user, single process) and doesn't block future evolution (multi-threaded, multi-user, scaled).

Part of **Layer 4** — see [`../layers.md`](../layers.md) for where this fits. Architecture decisions that these choices serve live in Layers 0-3.

**Reference project:** [OpenClaw](https://github.com/openclaw/openclaw) — similar architecture (TypeScript, plugin system, multi-channel, daemon, SQLite). Validated several of our choices during evaluation.

---

## Technology Stack Summary

| Category | v1 Choice | Future Path |
|----------|-----------|-------------|
| Language | TypeScript | Scales via worker_threads |
| Runtime | Node.js 22 LTS | Node 24+ brings stable `node:sqlite`, more worker_threads improvements |
| Package Manager | pnpm | Workspace support for monorepo |
| Module System | ESM only | Standard going forward |
| Storage | SQLite (better-sqlite3) | PostgreSQL or `node:sqlite` — behind interfaces |
| Build (dev) | tsx | — |
| Build (prod) | tsdown | — |
| Lint & Format | Biome | — |
| Validation | Zod | — |
| Testing | Vitest | Workspace configs for monorepo |
| v1 Triggers | Polling (GitHub API) | Webhooks via TriggerAdapter |

---

## Language & Runtime

### Decision #65: TypeScript as primary language

TypeScript's type system is the architectural enforcement layer for The Engineer. Our 30 event types, 5 adapter contracts, state machine transitions, and permission matrices become compile-time guarantees — not runtime hopes.

**Why TypeScript:**
- Strong type system enforces contracts designed in Layers 0-3 at compile time
- Native event loop matches our event-driven architecture (Event Bus, Daemon polling, async adapter calls)
- Plugin system via dynamic `import()` — clean, typed plugin loading
- Rich ecosystem: Octokit (GitHub), grammY (Telegram), Zod (validation) — all TypeScript-first
- Scales via `worker_threads` for future multi-threading without language change

**Alternatives considered:**
- **Python** — Weaker typing even with mypy. Dynamic types become a liability with 30 event payload shapes. GIL limits true concurrency (though I/O bound). AI ecosystem advantage doesn't apply — we *call* external LLMs, not run models.
- **Go** — Strong typing, excellent for daemons, goroutines for concurrency. But weaker plugin/dynamic loading, less ergonomic for rich event-driven pub/sub patterns, verbose for complex nested data structures.
- **Rust** — Maximum performance and safety. But massive development velocity hit for what's essentially an I/O orchestration system. Wrong tool for this job.

### Decision #66: Node.js 22 LTS

Active LTS through October 2027. Provides:
- Native ESM support (stable)
- `worker_threads` for future parallel task processing
- `node:sqlite` maturing as future built-in option (currently experimental)
- Performance improvements over 20.x (V8 engine updates)

**Future path:** Node 24+ will stabilize `node:sqlite` and improve worker_threads. Our choice of Node 22 LTS is the stable foundation; upgrading to future LTS versions is straightforward.

---

## Package Management

### Decision #67: pnpm

Fast, disk-efficient, strict dependency resolution. Content-addressable storage avoids duplicate packages across projects.

**Why pnpm:**
- Strict dependency resolution catches phantom dependencies (packages used but not declared)
- Built-in workspace support for future monorepo organization
- Faster installs than npm, comparable to bun
- Validated by OpenClaw (`"packageManager": "pnpm@10.23.0"`)
- Mature, well-documented, widely adopted in modern TypeScript projects

**Alternatives considered:**
- **npm** — Standard, ships with Node, zero setup. Slower, uses more disk, less strict.
- **bun** (as package manager only) — Fastest install times. Less mature lockfile ecosystem. Could revisit.

### Decision #68: ESM only

ES Modules exclusively. No CommonJS compatibility layer.

- Modern Node.js standard — all new libraries support it
- Clean dynamic `import()` for plugin loading (critical for our adapter/plugin system)
- Tree-shaking support for production builds
- `"type": "module"` in package.json

---

## Storage

### Decision #69: SQLite via better-sqlite3

Single embedded database for all persistent storage: Task Engine, Event Bus, Session/Memory.

**Why SQLite + better-sqlite3:**
- **Zero-config, zero-infrastructure.** Single file, no server to manage. Matches "design for one person first" (goals.md).
- **WAL mode** enables concurrent reads + single writer. Our Daemon is single-threaded by design — perfect fit. No write contention.
- **Handles millions of rows.** Our Event Bus (append-only, thousands to millions of events) and Task Engine (hundreds to thousands of tasks) are well within SQLite's capability.
- **better-sqlite3 is synchronous.** No async overhead for in-process database calls. Fastest SQLite binding for Node.js. Battle-tested.
- **Portable.** The DB file moves with the project. Easy backups (copy one file).

**Storage requirements served:**

| Store | Pattern | How SQLite serves it |
|-------|---------|---------------------|
| Task Engine | Read-modify-write, indexed queries | Standard SQL with indexes on state, parent_id, priority |
| Event Bus | Append-only, per-task ordering, replay | INSERT-only table with indexes on task_id, type, sequence |
| Session/Memory | Append-only journal + knowledge queries | Separate tables for journal, checkpoints, knowledge |
| Config | File-based, hot-reload | Not in SQLite — stays as YAML/TOML files (Layer 4 Session 25) |

**What about multi-threading?**

This was explicitly discussed. SQLite behind interfaces doesn't block future evolution:

1. **worker_threads + better-sqlite3**: Each worker opens its own connection. WAL mode supports concurrent readers + one writer. Works for moderate parallelism.
2. **`node:sqlite` (built-in)**: When it stabilizes in future Node.js versions, migration is a storage adapter swap.
3. **PostgreSQL**: If multi-process or multi-user scaling becomes real, the Task Engine / Event Bus / Session interfaces remain identical — only the storage implementation changes.
4. **The actual bottleneck is LLM calls**, not storage. Each task spends 95%+ of time waiting on LLM responses. SQLite can handle thousands of writes per second.

**Alternatives considered:**
- **PostgreSQL** — More powerful queries, JSONB, multi-user ready. But requires running a server, adds deployment complexity, overkill for single-user.
- **File-based (JSON/JSONL)** — Simplest for append-only. But no indexing, no transactions, no efficient queries without loading everything.
- **`node:sqlite` (built-in)** — What OpenClaw uses. Zero dependency but still experimental — API could change. Can migrate to it later.

---

## Build Tooling

### Decision #70: tsx (dev) + tsdown (production)

**Development:** `tsx` — fast TypeScript execution with watch mode. Run `.ts` files directly without a compile step. Fast feedback loop.

**Production:** `tsdown` — successor to tsup, built on esbuild. Produces optimized JavaScript bundles. Validated by OpenClaw.

**Why this split:**
- Development needs speed (tsx runs TS directly, ~instant startup)
- Production needs optimization (tsdown tree-shakes, bundles, minifies)
- Both are well-maintained, TypeScript-first tools

---

## Code Quality

### Decision #71: Biome for linting & formatting

Single tool replacing ESLint + Prettier. Rust-based, extremely fast.

**Why Biome:**
- One tool, one config — replaces two tools and their config files
- Rust-based: 10-100x faster than ESLint + Prettier
- Growing adoption, active development
- Supports TypeScript out of the box
- Formatter is Prettier-compatible (easy to adopt)

**Alternatives considered:**
- **oxlint + oxfmt** — What OpenClaw uses. Also Rust-based, very fast. But two separate tools.
- **ESLint + Prettier** — Industry standard, most plugins, most community support. Slower, more configuration.

---

## Validation

### Decision #72: Zod for runtime validation

TypeScript types exist only at compile time. At runtime — when events flow through the Event Bus, when adapters return data, when config files are loaded — we need runtime validation. Zod bridges this gap.

**Why Zod:**
- TypeScript-first: schemas infer TypeScript types automatically (`z.infer<typeof schema>`)
- Validates event payloads (30 types), adapter responses, config schemas at runtime
- Composable: build complex schemas from simple ones (matches our nested data structures)
- Excellent error messages for debugging
- Zero dependencies, small footprint
- De facto standard for TypeScript runtime validation

**Where Zod is used:**
- Event Bus: validate event payloads before publishing
- Adapter boundary: validate adapter responses match contracts
- Config loading: validate config files against schemas
- Task Engine: validate state transition inputs

---

## Testing

### Decision #73: Vitest for testing

Fast, TypeScript-native test framework with built-in coverage.

**Why Vitest:**
- Native TypeScript support (no compilation step for tests)
- Fast: uses esbuild for transformation, parallel test execution
- Compatible with Jest API (easy migration if needed)
- Supports multiple configs: unit, e2e, integration (via vitest workspaces)
- Built-in coverage via v8
- Validated by OpenClaw (multiple test configs: unit, e2e, live, gateway)

**Future path:** Vitest workspaces support monorepo test organization — each package gets its own test config while sharing a root config.

---

## v1 Trigger Strategy

### Decision #74: Polling only for v1

GitHub API polling at configurable intervals. No HTTP server, no webhooks, no exposed ports.

**Why polling for v1:**
- **Zero cost.** GitHub API free tier: 5,000 requests/hour. Polling every 30 seconds = ~120 requests/hour. Nowhere near the limit.
- **Zero infrastructure.** Runs on Farzam's machine. No server, no tunnel, no DNS.
- **Simple to develop and debug.** The Daemon's tick loop polls triggers — straightforward control flow.
- **Latency is acceptable.** 30-second delay between issue creation and The Engineer noticing it is negligible for tasks that take minutes to hours.

**Future path:** The TriggerAdapter contract already supports both polling plugins (`poll()` method) and webhook plugins (future, would implement a different trigger mechanism). Adding webhook support means adding a new TriggerPlugin — no changes to Core, Daemon, or existing polling plugins.

**When to add webhooks:** When real-time response matters (e.g., PR review comments need immediate reaction) or when polling becomes rate-limit constrained (e.g., monitoring many repos).
