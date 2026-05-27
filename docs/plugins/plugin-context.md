# Plugin Context

Every plugin — trigger, communication, agent, git-hosting — receives the same set of capabilities from Core. This is the contract a plugin author can rely on: read it once, and you know everything Core provides and everything you are expected to provide back.

Core injects these onto your plugin instance **before `initialize()` runs**. You never construct or set them.

| Field | Type | What it is |
|-------|------|------------|
| `this.manifest` | `PluginManifest` | Your identity — id, type, version, declared config. Read-only. |
| `this.context` | `PluginContext` | The capabilities Core provides you (below). |

Identity and capabilities are kept separate on purpose: `this.manifest` answers *who you are*, `this.context` answers *what Core gives you to work with*.

```typescript
export interface PluginContext {
  readonly logger: AdapterObserver;
  readonly stateStore: StateStore;
}
```

Both are guaranteed present by the time any of your `do*` methods run. You never need to null-check them.

---

## logger

A structured logger scoped to your plugin. Core stamps every line with your `plugin_id` and a `component: "plugin"` marker — you never tag your own logs, and you cannot impersonate a Core component. Filtering the logs by `plugin_id` shows everything your plugin did.

```typescript
export interface AdapterObserver {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}
```

### Levels

| Level | Use it for |
|-------|------------|
| `debug` | Developer detail when chasing a specific issue. High volume, off in production. |
| `info` | Normal lifecycle milestones — connected, polled N events. |
| `warn` | Something unexpected but survivable — malformed saved state, a retried request. |
| `error` | Something broke that a human must act on. |

### Rules

- **Pass structured data, not interpolated strings.** `logger.info("Polled issues", { count })` — not `logger.info(\`Polled ${count}\`)`. Structured fields are queryable; your `plugin_id` is already attached.
- **Log decisions, not every step.** "Skipped poll — rate limited until 12:05" is useful. "Calling the API" is noise.

```typescript
this.context.logger.warn("Persisted state is malformed — starting fresh");
this.context.logger.info("Polled source", { newEvents: events.length });
```

Lifecycle logging (init success/failure, shutdown errors) is emitted by the base adapter automatically — you don't write it.

---

## stateStore

A small, durable key-value store, private to your plugin. Use it for the cursor only your plugin understands — a watermark, an ETag, a last-seen id, a handshake mapping. Core owns *where* and *how* state is stored (a `--home`-aware database, written atomically); you decide *what* to store.

```typescript
export interface StateStore {
  get(key: string): unknown;          // returns null if the key is absent
  set(key: string, value: unknown): void;   // value must be JSON-serializable
  delete(key: string): void;          // no-op if the key is absent
}
```

### Guarantees

- **Namespaced per plugin.** You can only see your own keys. Two plugins using the key `"cursor"` never collide.
- **`--home`-aware.** State follows the `--home` the daemon was started with. You hold no file paths.
- **Atomic.** Each `set` is a single durable write — no temp-file dance, no half-written state.
- **JSON values.** Store anything JSON-serializable. `get` returns it as `unknown`; parse it at your boundary (see below).

### Discipline

The store is deliberately minimal: `get` / `set` / `delete`, nothing more. No TTL, no queries, no listing keys, no eviction. If you need structure, encode it in your value. Keep your state small — it is a cursor, not a cache.

### Reading back: parse, don't trust

`get` returns `unknown` because the store is opaque. Validate the shape when you read it, and degrade loudly if it is wrong rather than crashing:

```typescript
const stored = this.context.stateStore.get("watermarks");
if (stored === null) {
  return; // first run — nothing persisted yet
}
if (!isStringRecord(stored)) {
  this.context.logger.warn("Persisted watermarks are malformed — starting fresh");
  return;
}
// safe to use `stored` as Record<string, string>

// A small local guard — you own the shape of your own state:
function isStringRecord(value: unknown): value is Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  return Object.values(value).every((entry) => typeof entry === "string");
}
```

### Errors

A `get`/`set`/`delete` throws only if the underlying store is genuinely unavailable (e.g. the database is gone). Inside a `do*` lifecycle method you do **not** need a try/catch — the base adapter catches and reports it, failing loud. Wrap a store call yourself only when you persist outside the lifecycle (for example, on every inbound message) and a failed write should not break that path — then log a `warn` and continue.

---

## Worked example: a watermark

The pattern most trigger plugins need — persist a cursor on shutdown, restore it on init:

```typescript
const WATERMARKS_KEY = "watermarks";

protected doInitialize(config: Record<string, unknown>): Promise<InitResult> {
  // ... parse config ...
  this.loadWatermarks();
  return Promise.resolve({ success: true, message: null });
}

private loadWatermarks(): void {
  this.watermarks.clear();
  const stored = this.context.stateStore.get(WATERMARKS_KEY);
  if (stored === null) {
    return; // first run
  }
  if (!isStringRecord(stored)) {
    this.context.logger.warn("Persisted watermarks are malformed — starting fresh");
    return;
  }
  for (const [key, value] of Object.entries(stored)) {
    this.watermarks.set(key, value);
  }
}

protected doShutdown(): Promise<void> {
  this.context.stateStore.set(WATERMARKS_KEY, Object.fromEntries(this.watermarks));
  return Promise.resolve();
}
```

State is an efficiency optimization, not a correctness requirement: Core deduplicates tasks itself, so a plugin that loses its watermark simply re-fetches and the duplicates are suppressed. Persist what saves work; never depend on it for correctness.

---

## See also

- [Trigger adapter](trigger/README.md) · [Communication adapter](communication/README.md) · [Agent adapter](agent/README.md) · [Git-hosting adapter](git-hosting/README.md)
- [Three-tier model](../architecture/three-tier-model.md) — why Core never knows which plugin is behind the contract
