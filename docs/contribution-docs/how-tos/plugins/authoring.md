# Authoring a Plugin

This is the one methodology for building a plugin behind any of The Engineer's four adapter types — **trigger**, **communication**, **git-hosting**, and **agent**. Follow it top to bottom. It owns the sequence that is identical for every adapter; at each step where the adapter type matters, it sends you to that adapter's contract page for exactly one thing, then names where to come back.

You can run this yourself or hand it to a coding agent — every step is concrete and verifiable. The worked example throughout is a hypothetical **Linear** trigger plugin (Linear is an issue tracker), but every step applies unchanged to a communication, git-hosting, or agent plugin; the per-adapter contract page fills in the specifics.

**Prerequisites:** a working clone with `engineer` built and linked (the [README → Get Running](https://github.com/FarzamMohammadi/the-engineer/blob/main/README.md#get-running) section), and the [Contributing guide](https://github.com/FarzamMohammadi/the-engineer/blob/main/CONTRIBUTING.md) open for the gates and project structure.

The four adapter contract pages — each step below jumps into the one that matches your tool:

| Adapter type | When your tool… | Contract page |
|--------------|-----------------|---------------|
| `trigger` | reports new work to act on (issues, tickets, queue items) | [trigger/README.md](../../../plugins/trigger/README.md) |
| `communication` | is how The Engineer talks to a human (chat, comments) | [communication/README.md](../../../plugins/communication/README.md) |
| `git_hosting` | hosts code and pull requests | [git-hosting/README.md](../../../plugins/git-hosting/README.md) |
| `agent` | is a coding-agent CLI that does the work | [agent/README.md](../../../plugins/agent/README.md) |

---

## Step 1 — Identify the adapter type your tool needs

Decide which slot your tool fills. One tool can fill more than one slot — GitHub fills three of the four roles below as three separate plugins (a trigger, a communication channel, and a git-hosting plugin) because each is a different capability domain. Build one plugin per slot.

Pick the row in the table above that matches what your tool does. That choice fixes your contract page for the rest of this guide. For the Linear example, Linear reports new issues to act on, so the adapter type is `trigger`.

If your tool spans several roles (it tracks issues *and* hosts PRs, say), repeat this whole methodology once per role — each produces its own plugin with its own manifest entry.

## Step 2 — Read your adapter's contract

Open your adapter's contract page (the table above) and read it once, end to end. Each page opens with what the adapter is for, the **contract table** of `do*` methods you must implement, and the **Key Types** your methods receive and return. This is the boundary your plugin lives behind — Core only ever sees these types, never your tool's API.

You do not need to memorize it; you will come back to it for the skeleton in Step 3 and the methods in Step 4. Note two things now: the **list of `do*` methods** (how much surface you have to implement) and whether the adapter has **optional, capability-gated methods** (communication has the largest surface; git-hosting requires every method; trigger and agent are the smallest).

## Step 3 — Scaffold from the reference plugin

Every adapter ships a built-in reference plugin and a minimal class skeleton. Copy the skeleton, then keep the reference open beside you as a working example of every method filled in.

> **Pointer →** In your contract page, go to **Developing a New Plugin → Directory structure** and **Minimal class skeleton**. Extract: the exact directory layout (source under `src/plugins/<type>/<your-plugin>/`, tests mirrored under `tests/unit/plugins/<type>/<your-plugin>/`), and the starter class that extends the adapter base. The page's **Reference** table names the built-in plugin file to read as a complete example. Resume here.

Create the two source files the skeleton describes:

- `src/plugins/<type>/<your-plugin>/<your-plugin>.ts` — the plugin class, extending the adapter base from `../../../adapters/index.js` (the single SDK import point).
- `src/plugins/<type>/<your-plugin>/config.ts` — a Zod config schema. Use `z.output<typeof Schema>` for the inferred type (not `z.infer` — `z.output` resolves defaults and is required under `exactOptionalPropertyTypes`). See [Zod schema conventions](../zod-schemas.md) if any field is non-trivial.

For the Linear example: `src/plugins/trigger/linear-trigger/linear-trigger.ts` and `.../config.ts`, the class extending `TriggerAdapter`.

## Step 4 — Implement the `do*` methods

Fill in the `do*` methods from your contract table. Every adapter follows the same template-method shape: you implement the protected `do*` variants; the public methods (`poll()`, `sendMessage()`, `run()`, etc.) are inherited and wrap yours with uniform error handling. These rules hold for every adapter:

- **`doInitialize(config)` parses, never throws.** Run `YourConfigSchema.safeParse(config)`; on failure return `{ success: false, message }`, never throw. This is the parse-don't-validate boundary — after it, trust your typed config.
- **Use the injected `PluginContext`.** Core injects `this.context.logger` (structured logging, your `plugin_id` stamped automatically) and `this.context.stateStore` (persist a cursor/watermark across restarts) before `initialize()` runs. See [Plugin Context](../../../plugins/plugin-context.md) for the full contract.
- **Report failures as data where the contract says so.** Delivery and merge failures come back in a result field (`SendResult.error`, `MergeResult.error`), not as thrown exceptions — Core distinguishes a retryable outside-world failure from a plugin bug.
- **Stay opaque — translate at your edge.** The contract speaks in opaque strings (ids, channels) and platform-agnostic types; convert them to your platform's native shapes *inside* your `do*` methods, and never leak a platform-specific assumption upward. Core must work for any platform without knowing yours — a build guard fails the moment a platform name lands in Core. See [Plugin Opacity in practice](../../../philosophy.md#plugin-opacity--core-sees-only-adapters).

> **Pointer →** In your contract page, work through the **Contract** table and **Key Types**, and mirror the built-in reference plugin named in its **Reference** table. Extract: the signature and intent of each `do*` method, the shape of every type you return, and any adapter-unique rule called out under **Developing a New Plugin** (for example, an agent plugin MUST pipe the prompt via stdin and sanitize the subprocess environment; a git-hosting plugin must never force-merge). Resume here once your `do*` methods compile.

## Step 5 — Register in `src/plugins/builtin.ts`

A plugin is invisible until it is registered. `builtin.ts` is the single registry Core reads — it never hardcodes plugin names anywhere else. Add three things, in the same file:

1. **Import** your plugin class at the top.
2. **A manifest entry** in the `manifests` array — `id`, `type`, `version`, `name`, `description`, `critical`, `requirements`, `entry: "builtin"`, `adapter_meta`, and `contributes`. Two optional fields appear on the reference manifests: `combined_with` (declares plugins that are typically configured together — e.g. the three GitHub plugins list one another) and `startup_hints` (one-time setup notes shown to the human on daemon start — `telegram-comm` uses it to surface the `/start` handshake reminder). Your contract page's registration example shows the exact field set for your adapter type (trigger declares `poll_interval_ms`; communication declares `capabilities` in `adapter_meta`; git-hosting declares `action_classes`; agent declares `provider_type`).
3. **A factory** in the `factories` map: `"<your-plugin-id>": () => new YourPlugin()`.

**Secret-acquisition metadata (do this for every secret your plugin needs).** When a requirement is an environment secret (`{ type: "env", name: "..." }`), enrich it so the setup handoff can tell the human exactly how to get the value. Add three optional fields to that requirement:

```typescript
{
  type: "env",
  name: "LINEAR_API_KEY",
  acquire_url: "https://linear.app/settings/api",        // where to create the secret
  scopes: ["read"],                                       // any scopes/permissions it needs (omit if none)
  instructions: "Create a Linear personal API key with read access",  // one concise line
}
```

These three fields are **static public pointers only** — a URL, scope names, a one-line how-to. **Never put the secret value itself, or anything token-shaped, in them** (they flow unredacted into `engineer doctor` output and logs — this is the Trust Through Restraint invariant, and a test asserts no token-shaped content). When a requirement has no acquisition metadata, the handoff degrades to a generic "add `VAR=…` to `.env`" — so populating these fields is what turns a vague prompt into a precise one. If several plugins share one secret (the three GitHub plugins all need `GITHUB_TOKEN`), define the requirement object once as a module constant and reference it from each manifest, so the acquisition text can never diverge. See `GITHUB_TOKEN_REQUIREMENT` in `builtin.ts` for the pattern.

**Enabled vs. opt-in — by config presence, not a manifest flag.** There is no `enabled` field on the manifest. A plugin runs if and only if a config YAML for it exists at `~/.engineer/config/plugins/<your-plugin-id>.yaml` (see Step 7). Ship it as a default by adding a `<your-plugin-id>.yaml` to the seed; leave it opt-in by shipping no seed YAML — the human (or agent) adds the file when they want it. Registration in `builtin.ts` makes the plugin *available*; the config file makes it *active*.

If your plugin needs user-specific values during guided setup (a project ID, a board name), also add a `promptForConfig` entry — your contract page's trigger example shows the shape.

## Step 6 — Run the contract suite

Each adapter ships a reusable contract-compliance suite that proves your plugin honors the boundary — lifecycle, schema-valid returns, and the adapter's behavioral guarantees. Call it from your test file. The four suites are named for their adapter, so the call is `runTriggerContractSuite`, `runCommunicationContractSuite`, `runGitHostingContractSuite`, or `runAgentContractSuite` — one per adapter, no exceptions.

> **Pointer →** In your contract page, go to **Developing a New Plugin → Contract test suite** (titled "Contract tests" on the git-hosting page). Extract: the suite's import path under `tests/helpers/contract-suites/`, its exact function name, and the fixtures object it needs (a valid config, an invalid config, a manifest, and any adapter-specific fixtures — a `target`+`message` for communication, `prOptions` for git-hosting, a `request` for agent). Resume here.

Create `tests/unit/plugins/<type>/<your-plugin>/<your-plugin>.test.ts`, wire the suite with your fixtures, and run it:

```bash
pnpm test
```

The suite must be green before you go further. If it fails, it is telling you a `do*` method returns the wrong shape or violates a guarantee — fix the plugin, not the suite. (For an agent plugin that can't hit a real CLI in unit tests, the contract page shows the mock-CLI-script pattern.)

**Keep the suite offline.** Several suites exercise a method that reaches the outside world with your real `do*` code — the trigger suite calls `poll()` (your real `doPoll()`) three times against the live API. Run with a real network call and a fake config token and the suite fails or flakes. Inject a mock client by overriding the relevant `do*` method in the factory so the real init runs but the live client is swapped for a fake — the contract page's contract-suite section shows the exact pattern, and the built-in reference test (`tests/unit/plugins/<type>/<reference-plugin>/<reference-plugin>.test.ts`) is a working example.

## Step 7 — Configure

Configuration lives in one YAML file per plugin at `~/.engineer/config/plugins/<your-plugin-id>.yaml`; its keys are exactly your `config.ts` schema fields. The file's existence is also what enables the plugin (Step 5).

Create that file with your plugin's settings, using `${VAR_NAME}` syntax to pull secrets from `~/.engineer/.env` rather than writing them inline:

```yaml
# ~/.engineer/config/plugins/linear-trigger.yaml
api_key: "${LINEAR_API_KEY}"
team_id: "your-team-id"
```

For a reusable setup, add the same file under a seed directory (copy the shipped [`seed-example/`](https://github.com/FarzamMohammadi/the-engineer/tree/main/seed-example) layout, drop your YAML into `plugins/`, fill real values) so `engineer start --seed <dir>` configures it non-interactively. The [configuration guide](../../../configuration/README.md) covers `${VAR}` resolution and config-directory precedence.

## Step 8 — Verify

Run the readiness self-check — it validates config, secrets, manifests, and dependencies without needing the daemon running:

```bash
engineer doctor          # human-readable; exit 0 = pass, 2 = warnings, 1 = failures
engineer doctor --json   # machine-readable, for an agent to parse
```

If a required secret is missing, `doctor` prints the acquisition steps you populated in Step 5 — that is the metadata paying off. Fix anything it flags, then start the daemon from the seed directory you built in Step 7:

```bash
engineer start --seed <dir>
```

> **Headless agents:** always use `engineer start --seed <dir>` (or, if you only need to confirm the plugin loads and compiles, `engineer doctor` and a green contract suite are enough). Never run bare `engineer start` — on first run it prompts for interactive setup, which hangs an agent with no terminal.

Your plugin loads on startup (you'll see it in the logs and on the dashboard). For a trigger, confirm it polls; for communication, confirm a message reaches you; for git-hosting, confirm a PR action lands; for an agent, confirm a task runs. The plugin now works end to end on your machine.

---

## Step 9 — Contribute it back

A working plugin on your machine is useful to you. Contributed upstream, it's useful to everyone — the next person who uses your tool finds it already supported, no authoring needed. This is the natural close of the methodology: you built it, you verified it, now share it. Open a first-party plugin PR per the [Contributing guide](https://github.com/FarzamMohammadi/the-engineer/blob/main/CONTRIBUTING.md).

A contribution-ready plugin PR contains exactly what the steps above already produced, plus a per-plugin doc and green gates:

1. **The plugin source** — `src/plugins/<type>/<your-plugin>/<your-plugin>.ts` and `config.ts` (Steps 3–4).
2. **The registration** — the import, manifest entry (with secret-acquisition metadata on every `env` requirement), and factory in `src/plugins/builtin.ts` (Step 5). If several first-party plugins share a secret, single-source its requirement object.
3. **The passing contract suite** — `tests/unit/plugins/<type>/<your-plugin>/<your-plugin>.test.ts` wiring your adapter's contract suite, plus any unit tests for your output parsing or formatting (Step 6).
4. **A per-plugin doc** — add a page under `docs/plugins/<type>/<your-plugin>.md` modeled on the existing per-plugin pages (for example `docs/plugins/trigger/github-trigger.md`), and add your plugin to the **Built-in Plugins** table in that adapter's `README.md`. Keep both accurate to the code — they are derived from it, not from memory, and they must not duplicate the contract that already lives in the README.
5. **A seed YAML (optional)** — if your plugin should ship configured by default, add `seed-example/plugins/<your-plugin-id>.yaml`; otherwise leave it opt-in (Step 7).

Before opening the PR, run the full gates from the [Contributing guide](https://github.com/FarzamMohammadi/the-engineer/blob/main/CONTRIBUTING.md):

```bash
pnpm test:all && pnpm run lint && pnpm run typecheck
```

> **Note for agent plugins:** if you edit any `docs/plugins/**/*.md` file (the per-plugin doc and the README table in step 4), regenerate the bundled docs the CLI ships and commit the result — `pnpm run docs:bundle`. A CI guard fails the PR if the bundle is out of sync. This applies to every adapter, but you only touch it because step 4 edits a docs file.

Then open the PR and fill out the [pull-request template](https://github.com/FarzamMohammadi/the-engineer/blob/main/.github/PULL_REQUEST_TEMPLATE.md) — summary, the changes above, how you tested it (the contract suite plus your manual verification from Step 8), and the checklist (tests pass, lint clean, types check, docs updated, no secrets committed). Keep the PR to one plugin, one logical change, per the Contributing guide.

That's the whole loop: identify the slot, read the contract, scaffold, implement, register, verify against the suite, configure, confirm it runs, and share it so the next person's tooling is already supported.
