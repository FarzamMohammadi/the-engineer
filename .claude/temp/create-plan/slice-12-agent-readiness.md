# Plan: Slice 12 — Agent Readiness

**Date**: 2026-06-05 | **Stakes**: Full
**Upstream**: `.claude/temp/research/slice-12-agent-readiness.md` | `.claude/temp/requirements-gathering/slice-12-agent-readiness.md`
**Status**: Panel-Reviewed (5-panelist stress-test incorporated) — awaiting owner GO-to-build
**Worktree**: `the-engineer-slice12` @ branch `slice12-agent-readiness` off `main@b7394b6`. Slice 11 runs uncommitted in the MAIN checkout — never touch it; rebase onto updated `main` after Slice 11 lands.

## Intent

Make any agent, for any human, for any tooling, land cold and reach a working, verified daemon —
configuring what ships, **authoring + registering + verifying new plugins for what doesn't**, pulling
the human in only for secrets with precise lead-the-human instructions. The acceptance test we build
*toward* (not validate at the end) is the **money-shot**: a blind agent, given only the repo and a
one-line ask, stands up GitHub+Telegram+Claude, **builds a Linear plugin on the spot**, pauses exactly
twice for secrets with precise instructions, reaches a green daemon, and a self-check returns zero.
The foundations exist; this slice is connective tissue, drift-repair, agent-parseable verification, and
discoverability — proven by a real blind-agent run, not by a document set.

## Pre-Build Gate — Unit 0 (do FIRST, ~20m)

The panel proved the research was stale on a cornerstone (`doctor --json` already exists — `index.ts:192`).
**Before any build, re-verify each gap G1–G12 against the worktree HEAD** (grep/read the actual files, not
the research snapshot). Confirmed-stale so far: **G4 (`doctor --json`) is DONE.** Re-confirm: G1 drift still
present, G3 secret metadata still absent, G11 stale `tool/` still present, the bundle ships 11/12 docs
(`plugin-context.md` absent). Record current-state deltas in the research doc before starting. (Owner rule:
`feedback_scope_from_grep_markers` — never trust a hand-list or recall.)

## Decisions

### D1: Bundle drift → generator (JSON.stringify) + CI-verify
**Choice**: `pnpm run docs:bundle` renders `src/cli/bundled/plugin-docs.ts` from an **explicit ship-list** of `docs/plugins/**/*.md`, emitting each doc's body via **`JSON.stringify`** (NOT TS template literals); the regenerated file stays committed; CI fails if regenerating yields a git diff.
**Context**: `plugin-docs.ts` is 2072 hand-maintained lines; the agent-adapter mirror has ~395 lines drifted (ships a pre-CLI-native "inference-only" architecture). No guard exists.
**Panel correction**: template-literal escaping is a landmine (source docs contain literal backticks, `${}`, 100 nested fences) and the round-trip/idempotence test cannot catch mis-escaping. `JSON.stringify` escapes correctly **by construction** — the entire escaping risk class disappears; the test becomes a **byte-equivalence** assert (`import generated → content === source bytes`).
**Ship-list**: the bundle currently ships 11 of 12 docs (`plugin-context.md` excluded). The generator uses an explicit file set — consciously decide whether `plugin-context.md` joins (it's cross-referenced by every adapter doc; including it is a reviewed improvement, not a silent change).
**`templates.ts` is NOT in scope** (panel-verified): it is the source-of-truth for shipped config defaults (all-commented), a different artifact/purpose from `seed-example/` (real values) — not a mirror pair, no drift class.
**Rejected**: CI-verify-only (still hand-maintained); generate-on-build (rewrites tsdown; file leaves source land).
**Consequence**: `docs/plugins/**` is the single source; drift is structurally impossible; the build pipeline is untouched.

### D2: Secret-acquisition metadata → trimmed, opacity-safe manifest field
**Choice**: Extend each `env` requirement in `PluginRequirementSchema` with **three optional fields**: `acquire_url?`, `scopes?` (string[]), `instructions?` (one concise line). **Drop `description`** (overlaps `instructions`/`name`). Surface them in doctor remedies + setup's "seed incomplete" message.
**Context**: Manifests declare *which* secret but not *how to obtain it*; the money-shot's "pause with precise instructions" has no source.
**Panel hardening**:
- **Trust Through Restraint guard**: these fields flow unredacted into `doctor --json` and logs (`output.ts:96` has no redaction). They MUST be static public content (URLs, scope names) — **never secrets**. Document the contract; add a test asserting no token-shaped content.
- **One-way door**: the field shape is a public plugin-API contract third parties write against — design it deliberately (it earns more than a 45m slot).
- **Many-plugins-one-secret**: `GITHUB_TOKEN` is declared by 3 manifests. **Single-source its acquisition text** (one constant referenced by github-trigger/comm/hosting) so the lookup is deterministic and can't drift; specify a deterministic resolution (first-match by `name`, identical text).
- **Graceful degradation**: when an `env` requirement has no acquisition metadata (every third-party plugin until populated), the remedy degrades to today's generic "Add VAR=… to .env" — never `undefined`, never throw.
**Rejected**: per-plugin doc only (not machine-surfaced); `description` field (redundant); free-paragraph `instructions` (rot/secret risk).
**Consequence**: doctor + setup emit a precise, plugin-opaque handoff automatically (Core reads uniformly off `requirements`). Schema growth is additive + optional.

### D3: Plugin-authoring → one unified spine + per-adapter pointers, with seam discipline
**Choice**: A single executable methodology owning the **sequence** (scaffold from reference → implement `do*` → register in `builtin.ts` → run the contract suite → configure → verify → contribute back), with **≤1 terminal pointer-jump per step** into each `docs/plugins/<adapter>/README.md`, each jump naming exactly what to extract and where to resume. **Trim the four adapter READMEs' generic content to adapter-specifics** so the spine isn't duplicated 4×. Absorb/generalize the agent-adapter prompt. **Normalize the contract-suite naming** (`runContractSuite` → `runAgentContractSuite`) so the spine's "run the contract suite" example is uniform.
**Context**: Only the agent adapter has an executable prompt; the money-shot's Linear/Discord/GitLab have none, though all four contract READMEs carry strong "Developing a New Plugin" sections.
**Panel note**: the danger is a wide interface dressed as narrow (agent bouncing across 6 files per step) and shipping the spine PLUS four full how-tos. The seam discipline + README-trim are the acceptance criteria, not nice-to-haves.
**Rejected**: four per-adapter prompt files (4× duplication, drift-prone); a stable contract-suite re-export (the deep import is convention-fixed — every test sits at the same mirror depth and the README prints the exact line; a parallel export is a new dual-source for a non-problem).
**Consequence**: single-source, DRY; adapter specifics live in the contract docs; the spine hosts contribute-back + the bridge entry.

### D4: Readiness self-check → it already exists; verify + enrich + snapshot
**Choice**: `engineer doctor --json` already emits `{checks: DoctorCategory[], exitCode}` with codes 0/1/2 (`index.ts:192-193`). **Do NOT rebuild it.** The real work: enrich the existing remedies with D2 metadata, **snapshot-test the agent-facing JSON shape** (freeze the contract), and harden its failure paths.
**Context**: The research falsely claimed doctor has no `--json`. Panel-confirmed and owner-verified.
**Rejected**: a separate `engineer ready` command (parallel surface; the principle "extend doctor, not add" stands and is already satisfied).
**Consequence**: the verification spine is mostly *there*; Slice 12 adds the secret-acquisition richness + a frozen contract, not new plumbing.

### D5: Cross-cutting invariants & principles (non-negotiable)
Plugin Opacity (registry/manifest-driven; no hardcoded plugin names — panel-verified clean), Single-user (owner-only, warn-not-fail), Trust Through Restraint (D2 guard), Universal Audience, and leverage-and-fill (extend doctor/docs/CLI; single-source; serve both human + agent).

### D6: Setup→authoring bridge → agent-side inference, not Core code
**Choice**: The bridge is **inference performed by the agent in the runbook**, not a code path in `setup.ts`. The runbook has the agent diff "the tools the human named" against "the adapter slots a discovered plugin can fill" and conclude "no plugin for Linear → author one," then return to finish setup. Optionally a doctor *hint* ("no `trigger` plugin configured" — read from manifests, opacity-safe). **Cut the hedged "if cheap CLI hint."** Setup never imports the authoring flow.
**Context**: Core is plugin-opaque — it enumerates plugins, never "tools the human wants." A runtime detector would need a desired-tool list (opacity break). Putting the inference in the agent keeps Core clean and fits the agent-is-actor thesis.
**Consequence**: the continuous-flow promise is real (the agent bridges), the boundary is honest (docs handle procedure; setup detects absence only).

## Scope Boundary

**Delivering**: G1–G12 (minus the re-scoped G4) across two build sessions; `AGENTS.md` rename-and-enrich (operational-first); `doctor --json` enrichment + snapshot; secret-acquisition manifest field; bundle generator + CI drift guard; unified authoring spine + contribute-back; operator runbook + agent-side bridge; failure-path tests; closing sweep + **early + final blind-agent validation** + blueprint reconcile.

**Deferring**: llms.txt → Slice 13; internal pipeline prompts → out; live-agent-CI harness → out (blind validation is manual); **B3 doc-link CI → Slice 13** (unrelated to agent-readiness; the VitePress migration re-breaks it); npm-install operator path → Slice 14 (today's hero assumes an editable clone — stated assumption); usage-guide "Planned" topics → out.

## Task Breakdown — Two Sessions

### SESSION 1 — the mechanical, testable spine (Units B, C, A)

**Unit B — Bundle single-source + CI drift guard**
- **B1: Generator (JSON.stringify)** [~45m] — **Where**: new `scripts/gen-bundled-docs.ts`, `package.json`, `plugin-docs.ts`. **Approach**: glob the explicit ship-list of `docs/plugins/**/*.md`; emit `ALL_PLUGIN_DOCS` with `JSON.stringify`-ed content; decide `plugin-context.md` inclusion; regenerate (fixes the drift). **Verify**: `pnpm run docs:bundle && git diff --exit-code` clean after commit; **byte-equivalence test** (import generated, assert each `content` === source bytes) including the docs with literal backticks/`${}`/nested fences; setup still writes correct `~/.engineer/docs/`.
- **B2: CI drift guard** [~25m] — **Where**: `ci.yml`. **Approach**: run `pnpm run docs:bundle` then `git diff --exit-code`; the failure message names the fix (`pnpm run docs:bundle`). **Verify**: intentional drift fails CI with the actionable message. **Depends**: B1. **Commit** B1+B2.

**Unit C — AGENTS.md + discoverability + doc accuracy**
- **C1: Rename + enrich, operational-first** [~50m] — **Where**: `git mv AGENT-README.md AGENTS.md`. **Approach**: lead with terse operational essentials in the first screen (build/test/lint — *point to* `CONTRIBUTING.md`, don't re-list; project map; the `--seed` agent path; where the blueprint lives); move persona/checkpoint discipline below a clear fold (or link `docs/the-engineer-persona.md` + a one-line pointer). Don't gate the universal entry on 45 lines of ritual. **Verify**: a cold agent gets operational essentials before any ceremony; reads correctly as entry + protocol.
- **C2: Reference sweep** [~30m] — update all live (non-archived) `AGENT-README` refs → `AGENTS.md`, including the checkpoint text agents reproduce. **Verify**: `grep -r "AGENT-README" --exclude-dir=archived` only matches archived. **Depends**: C1.
- **C3: `--seed` front-door surfacing** [~20m] — its own task (highest-value discoverability fix): README + `AGENTS.md` show the non-interactive `--seed` agent path. **Verify**: an agent reading the front door finds the `--seed` route.
- **C4: Doc-accuracy** [~25m] — remove stale `tool/` adapter (`CONTRIBUTING.md:36,114`); fix the "how-tos are agent-executable prompts" over-promise; reconcile `pnpm run setup` vs `pnpm install`+`reset.sh`. **Verify**: grep clean; paths coherent. **Commit** C1–C4.

**Unit A — Verification enrichment + secret metadata**
- **A1: Secret-acquisition manifest field** [~40m] — **Where**: `src/schemas/adapters.ts`, `src/plugins/builtin.ts`. **Approach**: add optional `acquire_url?`, `scopes?`, `instructions?` to the `env` requirement; **single-source the `GITHUB_TOKEN` text** as one constant referenced by all 3 GitHub manifests; populate `TELEGRAM_BOT_TOKEN`; document the no-secret-content contract. **Verify**: schema validates; manifests parse; a no-secret-content test passes.
- **A2: Surface in the handoff (deterministic + degrading)** [~45m] — **Where**: `doctor.ts:checkRequiredSecrets`, `setup.ts:runNonInteractiveSetup`, a shared `var-name → manifest acquisition` lookup. **Approach**: enrich the remedy/seed-incomplete message with acquisition info; deterministic many-plugins-one-secret resolution; graceful degradation when metadata absent. **Verify**: missing `GITHUB_TOKEN` prints acquisition steps; a var with no metadata prints the generic remedy (no `undefined`). **Depends**: A1.
- **A3: doctor --json enrich + snapshot (NOT rebuild)** [~25m] — confirm the existing `--json` path carries the enriched remedies; add a **snapshot test** freezing `{checks, exitCode}`; harden failure paths (config-load-fail, missing home, corrupt YAML → valid JSON on stdout, stderr noise never corrupts the JSON stream). **Verify**: snapshot stable; failure-path tests green. **Commit** A1–A3.

**End Session 1**: re-run all gates (typecheck/lint/test:all). The mechanical spine is green.

### SESSION 2 — methodology, runbook, bridge, validation (Units D, E, F)

**Unit D — Authoring spine + contribute-back**
- **D1: Unified methodology with seam discipline** [~70m] — **Where**: `docs/contribution-docs/how-tos/plugins/` (unified), cross-links from `docs/plugins/*/README.md`, `CONTRIBUTING.md`. **Approach**: write the common spine with ≤1 terminal pointer-jump per step; **trim each adapter README's generic content to specifics**; normalize `runContractSuite` → `runAgentContractSuite`; absorb the agent prompt. **Verify**: a cold agent can follow it to author a trigger plugin (early blind pass below).
- **D2: Contribute-back runbook** [~40m] — executable steps to open a contribution-ready first-party plugin PR (location, manifest+factory registration, docs, passing compliance suite, PR template, gates). **Verify**: yields a compliant PR checklist an agent can execute. **Commit** D1–D2.
- **D-blind: EARLY blind-agent dry-run of authoring** [~variable] — immediately after D1/D2, spawn a blind agent to author a real Linear (trigger) plugin from the methodology alone; record dead-ends; fix the spine while it's cheap. (Don't wait for F.)

**Unit E — Operator runbook + agent-side bridge**
- **E1: Operator-setup runbook (seed-example-anchored)** [~55m] — **Where**: `docs/contribution-docs/`, referenced from `AGENTS.md`. **Approach**: "copy `seed-example/`, edit values for your plugins, `engineer start --seed`" (template-by-example; reach for `config.ts` only for fields the example doesn't show) → handle the precise missing-secret report (A2) → verify via `doctor --json` (A3). **Verify**: a blind agent reaches a green daemon on a shipping stack.
- **E2: Agent-side bridge** [~30m] — the runbook routes "no plugin for your tool" into the authoring spine via agent inference (diff named-tools vs discoverable-plugin slots); optional opacity-safe doctor hint; NO setup→authoring code coupling. **Verify**: a blind run against an unsupported tool ends with that tool supported + green daemon. **Commit** E1–E2.

**Unit F — Sweep + final blind validation + integrate**
- **F1: Closing standards sweep** [~90m] — every changed file vs `coding-standards`/`anti-patterns`/`philosophy` + the approach.md hunt-list (dead surface, dual-source, stale residue, doc/mirror/manifest accuracy). **Verify**: sweep checklist complete.
- **F2: Final blind-agent validation (the money-shot)** [~variable — primary deliverable] — fresh blind agents, repo + realistic task only, run the full money-shot (incl. the Linear bridge); record every dead-end; fix; re-validate. **Plus a manual human check**: a human follows the printed secret-acquisition instructions cold and reaches a working token (verify the payload, not just the pipe). **Verify**: blind agents complete the flows without dead-ending.
- **F3: Rebase + reconcile** [~45m] — rebase onto Slice-11-landed `main`; reconcile `docs/`, blueprint, doctor risky-config + `docs/configuration/daemon.md` overlaps; re-run all gates. Structure Unit A's doctor edits to minimize conflict with Slice 11's `checkDataLifecycleCoherence`.
- **F4: Blueprint reconcile** [~20m] — mark Slice 12 done (one-line in `active.md`), advance Current to Slice 13; sync `approach.md`. **Commit** per logical group.

## Verification Contract

| Check | Type | Command or Observation |
|-------|------|------------------------|
| Types compile | Auto | `pnpm run typecheck` → 0 |
| Lint clean | Auto | `pnpm run lint` → 0 |
| Tests pass | Auto | `pnpm test:all` → green |
| Bundle in sync | Auto | `pnpm run docs:bundle && git diff --exit-code` |
| Bundle byte-fidelity | Auto | import generated → each `content` === source bytes (incl. backtick/`${}`/nested-fence docs) |
| Doctor JSON contract frozen | Auto | snapshot test of `{checks, exitCode}` |
| Doctor JSON failure paths | Auto | config-load-fail / missing-home / corrupt-YAML → valid JSON, stderr never corrupts stdout |
| Secret handoff precise + degrading | Auto+Manual | missing `GITHUB_TOKEN` → acquisition steps; metadata-absent var → generic remedy, no `undefined` |
| No-secret-content guard | Auto | acquisition fields contain no token-shaped content |
| Money-shot (agent) | Blind | a blind agent sets up + authors a Linear plugin + green daemon, ≤2 secret pauses |
| Money-shot (human payload) | Manual | a human follows the printed instructions cold → working token |

## Risks

| Risk | If It Happens | Mitigation |
|------|--------------|------------|
| Stale research → rebuild done work / miss twin gap | Wasted effort, false "done" | Unit 0 re-verify G1–G12 vs HEAD before building |
| Generator mis-escapes a doc, CI green | Corrupt bundled docs shipped | `JSON.stringify` content (correct by construction) + byte-equivalence test |
| Blind agent dead-ends at the bridge/spine seam | Money-shot fails late | E2 agent-side inference + D1 seam discipline + EARLY blind pass (D-blind) |
| D2 free-text leaks secret-adjacent content | Trust violation in `--json`/logs | No-secret-content contract + test; structured url+scopes over prose |
| Slice 11 rebase conflicts (doctor, docs/config) | Gate breakage | F3 reconciles by hand; structure A's doctor edits to minimize conflict |
| F2 fix loop balloons | Scope creep at the end | Two-session split; blind pass moved early; F2 framed as primary deliverable, not closing step |

## Pre-Mortem (it shipped and failed — top 3)

1. **Docs look complete; blind agent dead-ends at the bridge.** Cause: E2 stays hand-wave, D1 bounces the agent across files. Mitigation: D6 agent-side inference; D1 ≤1-jump-per-step seam discipline; D-blind early pass.
2. **Generator silently corrupts a doc, CI green.** Cause: template-literal mis-escape. Mitigation: D1 `JSON.stringify` + byte-equivalence test (not round-trip).
3. **Build re-implements done work / ships a twin gap.** Cause: stale research (G4 already done). Mitigation: Unit 0 re-verify against HEAD; templates.ts confirmed out-of-scope.

## Panel Review
**Panelists**: Linus Torvalds, D. Richard Hipp, Rob Pike, The Engineer, Technical Architect (all read the actual source).
**Incorporated**: D4 re-scoped (doctor `--json` already exists — owner-verified); D1 switched to `JSON.stringify` + byte-equivalence test + explicit ship-list; `templates.ts` confirmed not-a-mirror (dropped); D2 trimmed to 3 fields + Trust no-secret guard + single-sourced `GITHUB_TOKEN` text + graceful degradation + one-way-door scrutiny; D3 seam discipline + README-trim + contract-suite naming normalization; D6 bridge = agent-side inference, CLI-hint cut; AGENTS.md operational-first (anti-bloat); `--seed` surfacing its own task; E1 anchored on `seed-example/`; failure-path tests added; money-shot human-payload check added; two-session split + early blind pass; B3 doc-link CI deferred to Slice 13.
**Declined**: stable contract-suite re-export (deep path is convention-fixed; a parallel export is a new dual-source — single-source wins); dropping `scopes` (machine-useful, optional, Core-never-interprets); fully collapsing the unit apparatus (kept gap traceability, dropped false-precision estimates).

## References
- Requirements: `.claude/temp/requirements-gathering/slice-12-agent-readiness.md`
- Research: `.claude/temp/research/slice-12-agent-readiness.md`
- Memory: `project_slice12_agent_readiness.md`
