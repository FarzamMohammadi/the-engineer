# Research: Slice 12 — Agent Readiness

**Date**: 2026-06-05 | **Repo**: the-engineer | **Branch**: slice12-agent-readiness | **Commit**: b7394b6 (worktree off main; Slice 11 runs uncommitted in the main checkout)

> Three streams, observations separated from implications. **Headline reframe:** the hero (operator
> setup) and co-spike (plugin authoring) are *more built than the brief assumed* — the work is
> connective tissue, discoverability, drift-repair, and agent-parseable verification, NOT greenfield.
> Requirements doc: `.claude/temp/requirements-gathering/slice-12-agent-readiness.md`.
>
> **⚠ CORRECTION (panel-verified, owner-confirmed):** the Stream-A / G4 claim below that "doctor has no
> `--json`" is **FALSE for this worktree**. `engineer doctor --json` already exists — `src/cli/index.ts:192-193`
> emits `{checks: DoctorCategory[], exitCode}` with codes 0/1/2. So **G4 is largely DONE**; the real work is
> enriching the existing remedies (G3) + snapshot-freezing the JSON contract, NOT building `--json`. The plan
> mandates a Unit 0 re-verify of every "X doesn't exist" claim against HEAD before building. (`templates.ts`,
> a separate Stream-A item, was also panel-checked: it is the source-of-truth for config defaults, NOT a bundle
> mirror — out of scope.)

---

## What I Found

### Stream A — the project through the agent's eye (facts)

#### Entry & onboarding
- `AGENT-README.md` (164 lines) is a strong agent entry contract: identity→persona, Always/Conditional
  context-loading tables, a mandatory two-stage visible-text checkpoint, co-ownership/never-assume rules.
- **No `AGENTS.md` and no `llms.txt` at root.** The only `AGENTS.md` on disk is inside a dependency's
  `node_modules` (recharts). `AGENT-README.md` is referenced only from `README.md` (the "AI agents:
  AGENT-README is your entry point" pointer) and archived session docs — **nothing auto-discovers it.**
- `README.md` getting-started leads with `pnpm run setup` then **interactive** `engineer start`. The
  agent-critical non-interactive `--seed` path is not surfaced here.
- `docs/` top level: `philosophy.md`, `the-engineer-persona.md`, `constraints.md`, `coding-standards.md`,
  `anti-patterns.md`, `assumptions.md`, `cli.md`, `future-considerations.md`; subdirs `architecture/`,
  `configuration/`, `contribution-docs/`, `plugins/`, `usage-guide/`, `user-flows/`, `archived/`.

#### Operator setup (HERO) — `src/cli/setup/setup.ts`, `src/cli/commands/start/start.ts`
- `engineer start` flow (`runStart`): first-run detection → load `.env` → scan configs for resolvable
  `${VAR}` → persist to `.env` → register secrets → ensure dirs → load config → **pre-flight checks
  (`runPreFlightChecks` = a doctor subset)** → dry-run/background/foreground.
- **Non-interactive agent path exists:** `engineer start --seed <dir>` (CLI option at `index.ts:90`).
  `start.ts:328` forces it: when there's no TTY and no `--seed`, it errors "First-run setup requires an
  interactive terminal. Run 'engineer start' in a terminal first, or provide --seed <path>." — i.e. an
  agent's exact situation routes to `--seed`.
- Seed setup (`runNonInteractiveSetup`): validates `<seed>/plugins/*.yaml` (+ optional `configs/`),
  copies plugin configs, writes core configs (seed-override or template default), example templates,
  plugin docs. **Post-setup it runs `findUnresolvedEnvVars` and errors "Seed incomplete — missing
  required environment variables: …"** naming each missing secret. → the secret-detection seam already exists.
- Detection (`runDetection`) is **fully plugin-opaque**: it derives the binary/env checks from
  `plugin.manifest.requirements` (`type: "binary"|"env"`) — no hardcoded lists. Same for `git remote`
  parsing to pre-fill repo owner/name.
- Interactive path uses `@inquirer/prompts` (lazy-loaded `runGuidedSetup`) + per-plugin
  `promptForConfig` (e.g. github-trigger asks `owner/name`). **Agents cannot drive these prompts** — in
  seed mode they're bypassed (the agent supplies the YAML directly).
- `start --dry-run` has a **structured JSON branch** (`out.mode === "json"` → `out.data({config, database,
  plugins, preflight})`). So `engineer start --dry-run --json` is an agent-parseable validation path.
- Recovery pointers on failure are human prose: "Run 'engineer doctor' to diagnose", "Use 'engineer stop'…".
- `seed-example/` is a clean, well-commented template (`plugins/*.yaml` + `configs/*.yaml`); e.g.
  `github-trigger.yaml` shows `repos:[{owner,name}]`, `github_token:"${GITHUB_TOKEN}"`, `labels:["engineer"]`.
- Two non-interactive entry points: `engineer start --seed <dir>` and `./scripts/reset.sh <seed-dir>`
  (documented in `docs/cli.md` and `CONTRIBUTING.md`).

#### Verification — `src/cli/commands/doctor.ts` (789 lines)
- Mature structured-check system: `DoctorCheck {label,status:"pass"|"fail"|"warn",message,remedy?}` →
  `DoctorCategory` → `runAllChecks` / `runPreFlightChecks` / `computeExitCode` (0 pass / 1 fail / 2 warn).
- Categories: Node runtime, data dir, **config files** (each YAML parsed+schema-validated), **required
  secrets** (scans `${VAR}` in configs vs env; remedy "Add VAR=<value> to ~/.engineer/.env"), database,
  **plugin manifests** (enabled-by-config-file), workspace+git, **external deps** (binaries from
  manifests), people directory (single-user/owner-reachability), risky config, telemetry (async probe).
- **No `--json` / structured output for `doctor`** — `formatDoctorResults` produces a terminal string only.
  The `doctor` action (`index.ts:159`) takes no options and never branches on `--json`.

#### Plugin authoring (CO-SPIKE) — `docs/plugins/*/README.md`, `src/plugins/builtin.ts`, contract suites
- **All four adapter contract docs carry a "Developing a New Plugin" section** (trigger/comm/git-hosting/
  agent). The trigger README is exemplary: directory layout, minimal class skeleton (`do*` methods),
  `PluginContext` logging/state, Zod `z.output` config pattern, **`builtin.ts` registration** (import +
  manifest + factory + optional `promptForConfig`), the **contract suite** call with what it validates,
  built-in table, and a reference-file table.
- `src/plugins/builtin.ts` is the plugin-opaque registry: a `manifests` array (id, type, version, name,
  description, critical, `requirements:[{type,name}]`, `combined_with`, `entry`, `adapter_meta`
  {capabilities, channel, provider_type, action_classes}, `contributes.events`, `startup_hints`,
  `poll_interval_ms`), validated at import via `PluginManifestSchema`; a `promptFunctions` map (interactive);
  a `factories` map. Adding a plugin = 3 edits here.
- **Contract suites exist for all four adapters**: `tests/helpers/contract-suites/{trigger,communication,
  git-hosting,agent}-contract.ts`, each `run*ContractSuite(factory, fixtures)`. Real plugins and the
  fake plugins call them. **Import path is a fragile deep relative:**
  `../../../../helpers/contract-suites/<adapter>-contract.js` (test-internal location).
- **The only executable authoring *prompt* is `docs/contribution-docs/how-tos/plugins/agent-adapter/
  prompt.md`** (55 lines, agent-adapter only). It's good (research output format, read references, build
  config.ts+plugin.ts, register, run contract suite, configure, quota) — but there is **no equivalent for
  trigger / communication / git-hosting**. The path structure `how-tos/plugins/<adapter>/prompt.md` implies
  per-adapter prompts were envisioned; only one exists.
- `docs/contribution-docs/README.md` (8 lines) is a thin philosophy statement — no operator-setup guide,
  no plugin-authoring index.
- `docs/plugins/` has per-adapter READMEs + `plugin-context.md` but **no top-level plugins index README**.

#### Bundled mirror — `src/cli/bundled/plugin-docs.ts` (2072 lines), `templates.ts` (697)
- Hand-duplicated TS string constants mirroring `docs/plugins/*.md` (TRIGGER_README, AGENT_README,
  AGENT_CLAUDE_CODE/OPENCODE/GEMINI_CLI, COMMUNICATION_README + per-plugin, GIT_HOSTING_README + per-plugin,
  TRIGGER_GITHUB_TRIGGER), written to `~/.engineer/docs/` during setup.
- **`AGENT_README` const (the agent-*adapter* doc, NOT the root file) has 395 of ~481 lines drifted** from
  `docs/plugins/agent/README.md`. The bundle describes agent adapters as "inference-only providers; The
  Engineer is the agent" — a *pre-CLI-native architecture*; the source says they "wrap autonomous coding
  agent CLIs." The bundle teaches a wrong model with authority.
- **No generation script** (scripts/: e2e-run, lib.sh, reset.sh, setup.sh; package.json has no doc-gen).
  The mirror is 100% hand-maintained.

#### CI — `.github/workflows/ci.yml`
- Three jobs: `pnpm lint` / `pnpm test` / `pnpm build`. **No doc-link check, no mirror-sync check.** Drift
  and broken doc links are unguarded.

#### Doc-accuracy defects found
- `CONTRIBUTING.md:36` lists a **`tool/` adapter** ("trigger/, communication/, agent/, tool/, git-hosting/")
  and ":114" says "agent plugins, tools" — **no `tool` adapter type exists** (`AdapterTypes` = agent,
  trigger, git_hosting, communication). Stale.
- `CONTRIBUTING.md:116` claims the contribution how-tos "are agent-executable prompts that walk you through
  the process interactively" — **only one (agent-adapter) exists.** Over-promise.
- Onboarding path divergence: `README.md` → `pnpm run setup` (= `scripts/setup.sh`); `CONTRIBUTING.md` →
  `pnpm install` + `./scripts/reset.sh`. Two different first steps.
- `docs/usage-guide/README.md` lists 5 "Planned" guides (Setting Up Repos, Reading Output, Scoping Work,
  Cost Awareness, When to Intervene) — unwritten (user-facing, lower priority).

### Stream B — the world (standards research, live, not memory)

- **AGENTS.md** — Linux-Foundation-stewarded open standard (originated at Anthropic, released late 2025),
  **60,000+ repos**; auto-discovered by **Claude Code, OpenAI Codex, Cursor, VS Code, Aider, OpenHands,
  Continue.dev, Windsurf + 30 more** (many default to it; others fall back when their proprietary file is
  absent). It is **standard Markdown, no required fields**; recommended content = project overview, setup/
  build/test commands, code style, testing instructions, security gotchas, PR instructions — "what you'd
  tell a new teammate." It **complements, never replaces, README/CONTRIBUTING** (README for humans;
  AGENTS.md holds agent-facing detail that would clutter a README) — the split *prevents duplication*.
  Nestable in monorepos (nearest file wins; root sets defaults, subdirs override). Keep terse (chars =
  context). Detailed AGENTS.md correlates with materially fewer agent bugs in community leaderboards.
- **llms.txt** — a **docs-site / crawler** convention: a Markdown index at a domain root linking key pages
  with one-line descriptions (`llms-full.txt` = the full single-file dump). Anthropic publishes one;
  Mintlify auto-generates. **No major LLM provider formally adopted it as a crawler protocol.** Its value
  is tied to a **hosted docs site** — marginal for a repo without one.
- **Executable runbooks / docs-as-prompts** — the agent-ready pattern is "documentation that doesn't rot":
  setup scripts embedded in onboarding runbooks (clone → run → installs deps, configures env, launches +
  **verifies**). Agent-ready-repo checklists center on AGENTS.md + deterministic executable commands +
  boundary rules + safe-action gates + self-verification.

### Stream C — flow walkthroughs (where each breaks, in the agent's shoes)

1. **Configure & set up (HERO):** Front door (README) shows interactive `engineer start` → an agent has no
   TTY and would dead-end UNLESS it discovers `--seed` (buried in `cli.md`). With `--seed`: it must
   assemble a seed dir, which needs each plugin's config schema (in `config.ts` Zod + bundled plugin docs —
   discoverable but not pointed to from a single runbook). Run → seed setup names missing secrets → agent
   must obtain them, but **how to get each secret isn't anywhere** → it can't write the "precise
   instructions" the money-shot needs. Verify → `doctor` works but isn't agent-parseable; `start --dry-run
   --json` is. **Break points: front-door discoverability, no executable runbook, no secret-acquisition
   metadata, no agent-parseable readiness verdict.**
2. **Plugin authoring (CO-SPIKE):** For an agent adapter, `agent-adapter/prompt.md` carries it well. For a
   **trigger/comm/hosting** plugin (the money-shot's Linear), there's no executable prompt — the agent must
   find `docs/plugins/<adapter>/README.md` itself (good content, but framed as a contract doc, not a runbook)
   and wire the contract suite via a fragile deep path. **Break points: no executable authoring methodology
   beyond agent-adapter, fragile contract-suite wiring, no contribute-back path.**
3. **Onboard & ground:** AGENT-README works well *if found* — but nothing auto-discovers it. **Break point:
   discoverability (no AGENTS.md).**
4. **Do real work:** RRPIR + coding-standards + the blueprint are documented; an agent doing repo dev work
   has the material. Lower-risk; main gap is that the blueprint lives under `docs/archived/` and the path to
   it isn't surfaced from an agent front door.
5. **Get unstuck:** errors point at `doctor`, but doctor output isn't agent-parseable and there's no single
   discoverable "stuck → recovery" entry. **Break point: recovery isn't machine-actionable / centralized.**

### Cross-cutting concerns
- **Plugin Opacity is healthy** and must stay so: detection, doctor external-deps, and people-channel
  checks all derive from manifests, never hardcoded plugin names. Any new setup/authoring tooling must keep
  reading from the registry/manifests.
- **`secret-registry.ts`** is a runtime *sanitization* registry (redaction), populated from `${VAR}` scans +
  manifest requirements — NOT a source of "how to obtain" secret metadata.
- **Slice 11 overlap risk:** background-services touches `docs/configuration/daemon.md` (data_lifecycle),
  doctor's risky-config checks, and possibly bundled config templates — reconcile at rebase.

---

## What It Means

### Patterns to follow
- **Extend `doctor`, don't add a parallel command** (owner principle): add `--json`/structured output and a
  readiness verdict to the existing `DoctorCheck`/`DoctorCategory`/`computeExitCode` machinery — it already
  has labels, statuses, remedies, and an exit-code contract.
- **Drive setup through `--seed`** (already the agent path) + the existing missing-secret detection; build
  the executable runbook *around* what exists rather than new setup machinery where avoidable.
- **Mirror the trigger README's authoring shape** across a unified methodology; reuse the existing four
  contract suites as the verification backbone.
- **Single-source the bundle:** generate `plugin-docs.ts` (and verify in CI) from `docs/` — kills the entire
  drift class instead of re-syncing by hand.
- **Keep everything plugin-opaque and dual-audience** (human + agent), per the governing principle.

### Gap inventory (prioritized — fix targets for the plan)
| # | Gap | Flow broken | Severity | Fix direction |
|---|-----|-------------|----------|---------------|
| G1 | Bundled mirror 395/481 drift; no sync guard | all (correctness) | 🔴 | Generate-or-verify bundle from `docs/` + CI check |
| G2 | Executable authoring path is agent-adapter-only | co-spike | 🔴 | Unified executable plugin-authoring methodology, all 4 adapters |
| G3 | Secret *acquisition* metadata missing (only names declared) | hero (money-shot) | 🟠 | Add acquisition info to manifests or per-plugin docs the agent surfaces |
| G4 | `doctor` not agent-parseable; no readiness verdict | hero, get-unstuck | 🟠 | Extend doctor: `--json` + "am I ready?" verdict |
| G5 | No executable operator-setup runbook | hero | 🟠 | Build discover→seed→start→secret-loop→verify runbook |
| G6 | No setup→authoring bridge | hero↔co-spike (continuous flow) | 🟠 | Detect missing-plugin → route into authoring methodology |
| G7 | No `AGENTS.md`; AGENT-README not auto-discoverable | onboard/all | 🟡 | **Rename AGENT-README.md → AGENTS.md, enrich, fix refs/checkpoints** |
| G8 | `--seed` path not surfaced at the front door | hero | 🟡 | Surface in AGENTS.md/README agent path |
| G9 | No contribute-back runbook | flywheel | 🟡 | Executable contribute-back path (compliant first-party PR) |
| G10 | Contract-suite wiring is a fragile deep test-path | co-spike | 🟡 | Document clearly / consider a stable export |
| G11 | Stale `tool/` adapter + over-promise in CONTRIBUTING; setup-path divergence | onboard/contribute | 🟡 | Fix doc-accuracy; reconcile onboarding path |
| G12 | No doc-link CI check | all (rot) | 🟡 | Add doc-link check to CI |

### Resolved decisions (owner-confirmed this session)
- **llms.txt: DROPPED from Slice 12.** It's a docs-site/crawler convention with value tied to a hosted docs
  site = **Slice 13 (VitePress)**. Coordinate the real llms.txt there. (Optional tiny in-repo machine-readable
  doc index is allowed but not required.) **Keep AGENTS.md** — unambiguously high-value now.
- **AGENTS.md shape: RENAME-AND-ENRICH, all the way.** Rename `AGENT-README.md` → `AGENTS.md`, enrich with
  the operational essentials the standard expects (build/test/lint commands, project map, the `--seed` agent
  path) while keeping the persona/checkpoint/context-loading discipline; update every reference (README
  pointer, bundled docs, the checkpoint text that says "I have read AGENT-README", session/blueprint mentions).
  Single source, no fork.

### Risks
- **Rename ripple:** "AGENT-README" is referenced in README, the checkpoint text agents must reproduce, and
  archived docs. Renaming must update live references (not archived) and the bundled mirror — a grep-driven sweep.
- **Bundle generation vs build:** generating `plugin-docs.ts` at build time changes the build pipeline
  (`tsdown`); a CI *verify* (assert bundle == rendered-from-source) may be lower-risk than generate-on-build.
  Decide in planning.
- **Secret-acquisition metadata location:** adding it to manifests grows `PluginManifestSchema` (Core-read,
  plugin-opaque — fine) vs. per-plugin docs (looser). Pick one canonical home in planning.
- **Slice 11 rebase:** docs/config + doctor risky-config overlaps; verify after rebase.

### Open questions (for planning)
- Bundle: **generate-on-build** vs **CI-verify-only**? (Leaning verify-only first — lower blast radius.)
- Secret-acquisition metadata: **manifest field** vs **per-plugin doc convention**? (Leaning a structured
  manifest field so doctor/setup can surface it uniformly and plugin-opaquely.)
- Authoring methodology: **one unified runbook** covering all adapters vs **per-adapter prompt files** (like
  the existing agent one)? (Leaning one unified + thin per-adapter specifics.)
- Readiness verdict: a `doctor --json` consumed by agents, or a dedicated `doctor` subcommand/flag framing
  ("am I ready?")? (Leaning `--json` + a readiness summary in the same command.)
