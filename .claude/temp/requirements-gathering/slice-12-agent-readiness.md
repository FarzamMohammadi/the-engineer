# Requirements: Slice 12 — Agent Readiness

> **Status:** Requirements gathered via co-owner Q&A (Session 65). Grounded against the real
> agent-facing surfaces (no sub-agents, read directly). Awaiting owner confirmation of this doc
> before Research (R2). Working artifact — the durable record will be `slices/12-agent-readiness.md`.
>
> **Parallel-work note:** Built in worktree `the-engineer-slice12` on branch
> `slice12-agent-readiness`, cut from `main@b7394b6`. Slice 11 (Background Services) is running in
> the **main checkout** and will land on `main` first; integrate by rebasing onto the updated `main`
> after Slice 11 lands, reconciling `docs/`, the blueprint (`active.md`/`approach.md`), and the
> bundled mirrors by hand. Never touch Slice 11's line.

## Context

Slice 12 is **Agent Readiness**: all docs work as agent prompts, contribution guides are executable,
and an agent can hop into this project and never get stuck. It is **research-led and agent-first** —
NOT a hardening slice (that was Slice 11). The thesis: **the primary actor is now an agent, not a
human.** Where a human would muddle through a gap, an agent dead-ends — so every ambiguity, missing
pointer, stale mirror, or unexecutable instruction is a defect. Net-new is welcome here, judged on
"does this help the agent," not on novelty.

## True Intent

**Any agent, working for any human, for any tooling, lands cold and reaches a working, verified
daemon — pulling the human in only for the irreducibly-human moments.** Concretely this resolves to
one continuous flow with two build spikes:

1. **Spike 1 — Operator setup (THE HERO).** The agent grounds itself, installs/builds, and configures
   The Engineer (plugins + daemon/safety/workspace/people) with no human reading a line of source.
2. **Spike 2 — Plugin authoring (co-critical, the other biggest friction point).** When the human's
   tooling has no shipping plugin, the same agent **develops, registers, and verifies a brand-new
   plugin** for that tool and integrates it into The Engineer. Not just *configuring* shipped plugins
   — *creating* new ones. This is the project's stated moat ("Plugin Authoring Simplicity" lens;
   "zero-pain plugin development" philosophy) and today that aspiration has no executable path.

The two spikes are **one continuous story**, not two journeys: setup detects a missing plugin and
**bridges** straight into authoring, finishing with a working daemon.

**The contribute-back flywheel.** Plugin authoring doesn't end at the human's working daemon — the
authoring methodology's final step encourages and enables **contributing the new plugin back** to the
project so the next person's tooling is already supported. Plugin-opaque + build-your-own is the
model; the shipping plugins exist as ready-made options *if your tooling matches*; and every agent-
authored plugin that gets contributed back compounds the moat. This is the ecosystem growing itself.

The human is **present and available**, working *through* the agent. The agent attempts everything
autonomously and uses its own judgment to decide when it genuinely cannot proceed alone (no access to
a secret or a sensitive action). Only then does it pull the human in — and even then it **leads**,
handing the human precise "do exactly this, then tell me when it's done" instructions and resuming on
completion. Human-in-the-loop only when truly necessary; agent-driven and maximally helpful
throughout.

## Scope

### In Scope

- **Spike 1 — Operator setup made agent-executable end to end.** From the front door (entry contract)
  through install/build, plugin selection (registry-driven, plugin-opaque), config generation
  (daemon/safety/workspace/people) with **no blind interactive prompt the agent can't answer**, the
  secret/sensitive handoff, `engineer start`, and self-validation. **Setup mechanism is fair game** —
  refining or adding setup machinery (e.g. promoting the seed/non-interactive path to a first-class
  documented agent-setup flow, or an agent-friendly mode/command) is permitted and expected.
- **Spike 2 — Plugin-authoring methodology + agent-ready surfaces.** A full, executable,
  agent-drivable plugin-development methodology per adapter type — read the contract → scaffold from
  the reference → implement → register → run the compliance/contract suite → verify — AND making the
  adapter contracts, reference plugins, manifest format, and contract-test suite all **discoverable
  and executable** so none of those steps dead-ends.
- **The setup→authoring bridge** — missing-plugin detection during setup flows into the authoring
  methodology as one continuous path.
- **The contribute-back loop** — the authoring methodology ends with an executable path to contribute
  the newly authored plugin back to the project (for v1: a contribution-ready, contract-compliant,
  documented PR adding it as a first-party in-repo plugin). The agent can open that PR; it isn't a
  "you should share this" footnote. *(Shape confirmed below — in-repo first-party for v1; an external
  plugin registry/marketplace is post-v1.)*
- **Self-verification machinery as the spine of "done."** Build the machinery an agent runs to know
  it's ready / unstuck: an "am I ready?" readiness self-check, `engineer doctor` extensions, and a
  docs-link + bundled-mirror-sync check wired into CI. "Done" reduces to commands that return zero.
- **Adopt `AGENTS.md` via rename-and-enrich** (research-resolved): rename `AGENT-README.md` → `AGENTS.md`
  and enrich it with the operational essentials the standard expects (build/test/lint commands, project
  map, the `--seed` agent path) while keeping the persona/checkpoint/context-loading discipline — single
  source, no fork. Update every reference (README pointer, bundled docs, the checkpoint text, live
  blueprint mentions). Reconcile the no-tool-specific-files invariant in the docs (repo-onboarding is a
  different concern from the runtime no-CLAUDE.md rule). **`llms.txt` is DROPPED from this slice** — a
  docs-site/crawler convention whose value is tied to a hosted docs site (Slice 13, VitePress); an optional
  tiny in-repo machine-readable doc index is allowed but not required.
- **The bundled-mirror sync.** Fix the known `AGENT_README` drift in `src/cli/bundled/plugin-docs.ts`
  and put a guard in place so mirrors can't silently drift from source again.
- **The other three flows held to the "never-stuck" bar (gaps-closed + made executable):**
  - **Onboard & ground** — land cold, read the entry contract, take the persona, load the right
    context, pass the checkpoints, orient correctly.
  - **Do real work** — a contributor agent picks up engineering work on the codebase and runs the
    RRPIR pipeline + coding standards, with everything it needs discoverable from docs (no tribal
    knowledge).
  - **Get unstuck** — hit an error/ambiguity and be handed a clear, self-serve recovery path
    (mirroring the secret model: self-correct where possible, escalate to the human with precise
    instructions where not).
- **Standards/competitive research findings** folded into the plan (AGENTS.md, llms.txt, docs-as-
  prompts, executable runbooks, machine-readable indexes, what strong agentic OSS projects do).

### Out of Scope

- **The Engineer's internal RRPIR pipeline phase-prompts** (the prompts in `src/` it feeds the CLI
  agents it orchestrates). Explicitly out — they're preview-grade product code ("prompts are preview,
  not perfected"), and they serve the runtime, not repo onboarding. (They MAY be consulted read-only
  as a source of truth to ensure pipeline docs don't mislead, but they are not a refinement target.)
- **A live-agent-in-CI test harness** (spawning a real agent in CI to prove setup). The verification
  spine is deterministic/static checks + a readiness command + doctor; the money-shot demo is
  validated by an actual cold-agent walkthrough + owner review, not automated in CI. *(Assumption —
  confirm.)*
- **Slice 13 work** — docs site (VitePress), demo mode, license, design-history archive — except
  where a no-secret/mock path would otherwise be needed (we are NOT taking the "fully zero-human,
  no-secret path" option; secrets are an accepted human touch).
- **Multi-human / team features** — the single-user constraint holds; the human side is one owner.
- **New end-user runtime features** unrelated to agent-readiness.

## Requirements

### Functional

1. **Front door & onboarding (never-stuck bar).** A cold agent finds the entry point via the
   standard-discovered files (`AGENTS.md` / `llms.txt`) and/or `AGENT-README.md`, grounds itself,
   takes the persona, loads the right context, and passes the checkpoints. *Acceptance:* a cold agent,
   given only the repo, can state what the project is, how it's built, and what to read next — without
   reading source.

2. **Operator setup, agent-executable (Spike 1).** An executable path drives the agent from clone →
   working daemon: install/build, registry-driven plugin selection mapped to the human's stated tools,
   valid config generation with no unanswerable interactive prompt, and self-validation. *Acceptance:*
   a cold agent stands up and verifies a working daemon on a shipping stack (e.g. GitHub + Telegram +
   Claude Code) with the human only answering a stack question and providing secrets.

3. **Secret/sensitive handoff (open-ended, agent-judged).** The agent attempts everything; when it
   genuinely can't proceed (secret/sensitive action it has no access to), it pulls the human in with a
   precise, minimal, copy-pasteable "do exactly this, then tell me when done" request, then resumes and
   re-validates. The per-plugin secret requirements + acquisition instructions are **discoverable**
   (from manifests / per-plugin docs — under Plugin Opacity, NOT hardcoded in Core). *Acceptance:* for
   the chosen plugin set, the agent emits exactly the secrets needed and how to obtain each, and resumes
   cleanly once provided.

4. **Plugin authoring, agent-executable (Spike 2).** An executable methodology per adapter type takes
   the agent from "human uses tool X, no shipping plugin" to a working, contract-compliant, registered,
   verified plugin. The adapter contracts, reference plugins, manifest format, and contract-test suite
   are all discoverable and executable. *Acceptance:* a cold agent produces a working, contract-
   compliant plugin for a new tool from the contract + reference + test suite alone, registers it, and
   the compliance suite passes — pulling the human in only for that tool's secrets.

5. **Setup→authoring bridge.** Setup detects a tool with no shipping plugin and bridges into the
   authoring methodology in one continuous flow, ending with a working daemon. *Acceptance:* a setup run
   against a stack containing an unsupported tool (e.g. Linear) ends with that tool supported by a newly
   authored plugin and a green daemon.

6. **Self-verification spine (extend, don't duplicate).** Ship: (a) an agent-runnable readiness
   self-check ("am I ready?") delivered by **extending `engineer doctor`** (a readiness verdict +
   agent-actionable, parseable diagnostics with next steps) rather than a parallel new command, unless
   research shows a strong reason otherwise; (b) a CI check that fails on broken doc links and on
   bundled-mirror ↔ source drift. *Acceptance:* each is a command that returns zero on a healthy setup
   and non-zero with an actionable message otherwise.

7. **Standard discoverability.** `AGENTS.md` exists at root as the single-source, standard-named entry
   (renamed-and-enriched from `AGENT-README.md`), with the invariant reconciliation documented.
   *Acceptance:* an agent whose tool auto-scans for `AGENTS.md` finds a correct, non-duplicated entry that routes it
   into the right context.

8. **Recovery path (get-unstuck bar).** Errors and failed checks across setup, authoring, and runtime
   carry an actionable, agent-parseable recovery path inline; there is a discoverable universal fallback
   the agent can always reach when stuck. *Acceptance:* for each known failure mode (bad/expired secret,
   failed compliance check, missing config), the surfaced message names what failed, why, and the exact
   next action.

9. **Contribution guides are executable, not narrative.** `docs/contribution-docs/` how-tos read as
   agent-executable runbooks (step → command → verify), not human prose to puzzle through.

10. **Contribute-back loop (the flywheel).** The authoring methodology's final step is an executable
    path for the agent to contribute the newly authored plugin back: a contract-compliant, documented,
    tested, first-party in-repo plugin opened as a PR per `CONTRIBUTING.md`. *Acceptance:* after
    authoring a working plugin, the agent can produce a contribution-ready PR (correct location, manifest,
    docs, passing compliance suite) without tribal knowledge.

### Non-Functional

- **Leverage-and-fill, serve both audiences (governing principle).** Extend what exists — `engineer
  doctor`, the docs, the contribution guides, the CLI — and fill the gaps in those surfaces rather than
  building an agent-only parallel universe. Every artifact stays **single-source and serves both humans
  and agents**; agent-readiness is the lens applied right now, not a separate track. Refine-over-build,
  ecosystem-leverage, single-source-of-truth. (E.g. the readiness self-check is a `doctor` capability,
  not a new command, unless research shows a strong reason otherwise.)
- **Plugin Opacity preserved (invariant).** All setup/authoring guidance is registry-/manifest-driven;
  no hardcoded plugin names, tokens, or platform checks enter Core. Docs may *name shipping plugins as
  concrete examples*, but the mechanism never blesses a default that makes others second-class.
- **Single-user preserved.** Every human-targeted moment resolves to the one owner; missing owner
  warns, never hard-fails.
- **Universal Audience.** All new docs/output understandable by an outsider with intermediate English
  on first read, and parseable by an agent (structure is the interface).
- **Cost-conscious / local-first / ecosystem-leverage.** Net-new tooling favors existing libraries and
  free/local paths; no new heavyweight dependency without justification.
- **Lenses:** Plugin Authoring Simplicity and UX Quality are primary; Resilience and Plugin Integrity
  still apply.
- **Forward-only, docs-from-source, no-stale-counts** discipline on all docs.

## Edge Cases & Error Handling

- **Tool with no shipping plugin** → bridge into authoring (req 5), not a dead-end.
- **Wrong/expired secret** → doctor/readiness catches it with an actionable message; agent re-requests
  precisely.
- **Unusual auth model** (OAuth dance, not a static token) → agent self-assesses, pulls the human in for
  the interactive part with precise steps.
- **New plugin fails the compliance suite** → suite output is agent-parseable and points at the failing
  contract requirement so the agent can iterate.
- **Interactive `engineer start` prompt the agent can't answer** → resolved by the non-interactive /
  agent-drivable setup path (mechanism is fair game).
- **Context-budget blowout during onboarding** → entry contract's deliberate, load-on-demand context
  discipline holds.
- **Bundled mirror drifts from source** → CI mirror-sync check fails the build.

## Open Questions

- **[Resolve in research]** Exact shape of the `AGENTS.md` adoption — rename `AGENT-README.md` to
  `AGENTS.md`, or make `AGENTS.md` canonical with the detailed contract beneath it? (Owner lean:
  embrace standard names, single source.)
- **[Resolve in research]** Setup mechanism: promote the seed/non-interactive path to first-class
  agent-setup vs. add a new agent-friendly mode/command vs. make `engineer start` agent-drivable —
  decide from where the friction actually concentrates.
- **[Resolve in research]** Whether a scaffold/generator command (`engineer plugin new <type>`) is
  warranted — research-gated; methodology + agent-ready surfaces is the committed core.
- **[RESOLVED — dropped]** `llms.txt` is out of this slice (docs-site convention → Slice 13 VitePress).
- **[RESOLVED — owner confirmed]** Verification boundary: deterministic checks + readiness command +
  doctor, with the money-shot validated by cold-agent walkthrough + owner review. NO live-agent CI
  harness.
- **[RESOLVED — owner confirmed]** No "blessed default" stack. Setup stays registry-driven/plugin-
  opaque: the agent maps the human's *actual* tools to discovered plugins; shipping plugins "exist if
  you need them" (named only as examples), and anything unsupported is built (and contributed back).
  Most setups vary — build-your-own is the model, not a default stack.
- **[Shape confirmed — see contribute-back loop]** Contributed plugins are first-party in-repo for v1
  (PR adds to `src/plugins/` + docs + manifest + passing compliance suite). An external plugin
  registry/marketplace is post-v1, not this slice.

## Affected Systems

- **Root agent-entry files** — `AGENT-README.md` → `AGENTS.md` (rename-and-enrich), `README.md`,
  `CONTRIBUTING.md`.
- **`docs/contribution-docs/`** — operator-setup runbook (new), plugin-authoring methodology
  (new/expanded), made executable.
- **`docs/plugins/`** — adapter contracts, reference-plugin docs, manifest format, contract-test
  discoverability.
- **`docs/configuration/`, `docs/cli.md`** — agent-executable config + command references.
- **`src/cli/bundled/plugin-docs.ts`** (and `templates.ts`) — mirror sync + drift guard.
- **CLI / setup code** — agent-friendly setup path + readiness self-check + `engineer doctor`
  extensions (BUILD, concentrated here and on the plugin-authoring path).
- **CI (`.github/workflows/`)** — doc-link + mirror-sync checks.
- **Blueprint** — `active.md`, `approach.md` (reconciled with Slice 11 at integration).

## Acceptance Criteria (phrased as agent outcomes)

**Headline (the money-shot):** On a fresh machine, a human points their coding agent at the repo with
one line — *"set up The Engineer to handle my GitHub issues, I use Telegram and Linear."* With no human
reading a line of source, the agent grounds itself from the front door, installs and builds, configures
the GitHub + Telegram + Claude stack, hits Linear with no shipping plugin and **builds + registers +
verifies a working Linear-trigger plugin on the spot**, pauses exactly twice with precise instructions
to collect a GitHub PAT and a Linear API key, then starts a green daemon and confirms it via a
self-check that returns zero. Total human effort: answer one stack question, paste two secrets.

Decomposed, each independently checkable:

- [ ] A cold agent can state what the project is / how it's built / what to read next, from the docs
      alone.
- [ ] A cold agent stands up + verifies a working daemon on a shipping stack, human only answering a
      stack question + providing secrets.
- [ ] The agent emits exactly the secrets the chosen plugin set needs and how to obtain each, then
      resumes cleanly once provided.
- [ ] A cold agent authors a working, contract-compliant, registered plugin for a new tool from the
      contract + reference + tests alone; the compliance suite passes.
- [ ] A setup run against an unsupported tool ends with that tool supported (newly authored plugin) and
      a green daemon — one continuous flow.
- [ ] After authoring a plugin, the agent can produce a contribution-ready PR (correct location,
      manifest, docs, passing compliance suite) per `CONTRIBUTING.md` — the contribute-back flywheel.
- [ ] The readiness self-check, doctor, and CI doc-link + mirror-sync checks each return zero on a
      healthy state and non-zero with an actionable message otherwise.
- [ ] `AGENTS.md` exists (renamed-and-enriched from `AGENT-README.md`), single-source, standard-named,
      auto-discoverable, with the invariant reconciled. (llms.txt deferred to Slice 13.)
- [ ] Every known failure mode surfaces what failed, why, and the exact next action.
- [ ] Contribution how-tos read as executable runbooks (step → command → verify).
- [ ] Plugin Opacity, single-user, and Universal Audience invariants hold across all changes.

## Locked Decisions (Session 65 Q&A)

1. **Hero = operator/setup agent** (not contributor). Two build spikes total.
2. **Spike 2 = plugin authoring** is co-critical (owner-volunteered as the other biggest friction
   point); deliverable = executable methodology + agent-ready surfaces; generator research-gated.
3. **Secret/sensitive = open-ended, agent-judged**; human pulled in only when truly necessary, agent
   leads with precise instructions and resumes.
4. **Setup mechanism = fair game** (BUILD permitted).
5. **Verification = build self-verification as the spine** (readiness command, doctor extensions,
   mirror-sync + doc-link CI).
6. **Adopt `AGENTS.md` via rename-and-enrich** (`AGENT-README.md` → `AGENTS.md`, single source; reconcile
   invariant). **llms.txt dropped** (→ Slice 13 docs site).
7. **Internal pipeline prompts = strictly out.**
8. **All five flows to the never-stuck bar**, BUILD concentrated on the two spikes; other three =
   gaps-closed + executable.
9. **Setup→authoring bridge = one continuous flow.**
10. **Headline acceptance = the money-shot above** (owner-approved).
11. **Contribute-back flywheel** (owner-volunteered): authoring ends with an executable contribute-back
    path; plugin-opaque/build-your-own model, shipping plugins "exist if you need them," contributed
    plugins are first-party in-repo for v1.
12. **Verification boundary confirmed:** deterministic checks + cold-agent walkthrough + owner review;
    no live-agent CI harness.
13. **No blessed default stack confirmed:** registry-driven/plugin-opaque; shipping plugins are
    examples, not a default.
