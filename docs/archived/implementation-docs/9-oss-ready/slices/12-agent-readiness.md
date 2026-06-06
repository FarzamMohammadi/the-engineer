# Slice 12: Agent Readiness

> **Durable design record for making The Engineer's repository agent-ready.** The premise: the
> primary actor working *on* this project is now an agent, not a human. So every place where a human
> would muddle through but an agent dead-ends — an ambiguous doc, a missing command, a secret with no
> acquisition path, a methodology that lives only in someone's head — is a defect. This was a
> **research-led, refine-heavy** slice: most agent-facing surfaces already existed (docs, `doctor`,
> adapter contracts, contract-test suites, the seed flow); the work was to make them *never-stuck* for
> a cold agent, and to BUILD only where a real gap blocked the journey. Governing rule (owner):
> **leverage-and-fill** — extend `doctor`/docs/CLI and single-source, serve humans and agents from one
> surface; agent-readiness is the lens, not a separate track.
>
> **Status: BUILT, VALIDATED, SWEPT, and MERGED to `main` (Session 66).** Built in a dedicated worktree
> as a full RRPIR (Session 65): requirements + three-stream research + a 5-panelist-reviewed plan, six
> cohesive build groups, two rounds of blind cold-agent validation (the acceptance test), and a
> 3-auditor closing standards sweep. Rebased onto the landed Slice 11 and the `0.7.0-preview` version
> bump and merged by clean fast-forward — verified to preserve all of main's intervening work (version,
> README, plugin-health-at-boot) with no overrides. Working RRP artifacts:
> `.claude/temp/{requirements-gathering,research,create-plan}/slice-12-agent-readiness.md`.

## Scope Framing — research-led refinement, not greenfield

"Agent readiness" is a *property of the whole repository*, not a module. The slice traced all five
agent journeys end-to-end in the agent's shoes — **configure & set up** (the hero), **author a plugin**
(the co-spike), onboard & ground, do real work, get unstuck — and held every one to a single bar: a
cold agent, given only the repo and a human's one-line goal, never dead-ends. BUILD was concentrated on
the two spikes; the other three journeys were closed by filling gaps and making the existing surfaces
executable. The money-shot acceptance test anchored the whole slice: *fresh machine + "set up The
Engineer for my GitHub issues, I use Telegram and Linear" → the agent grounds, installs, configures
GitHub + Telegram + Claude, builds + registers + verifies a Linear plugin on the spot, pauses exactly
twice for secrets with precise instructions, lands a green daemon, and `doctor` returns zero.*

## The Work, As Built

### Pillar A — Bundled docs generated from source (drift made impossible)

`src/cli/bundled/plugin-docs.ts` was a 2000-line hand-maintained mirror of `docs/plugins/**` — the
chronic `AGENT_README`/plugin-doc drift flagged since Slice 10 lived here. Replaced with
`scripts/gen-bundled-docs.ts`, which renders the mirror from the source markdown via `JSON.stringify`
(escaping correct by construction, not template-literal-fragile). A `docs:bundle` script regenerates it;
a CI drift-guard step regenerates and `git diff --exit-code`s so a stale mirror fails the build; a
byte-equivalence unit test pins it. The file dropped from ~2072 to ~72 generated lines. Updating a
plugin doc now *cannot* leave the bundled copy stale.

### Pillar B — `AGENTS.md` entry point, operational-first

Renamed `AGENT-README.md` → **`AGENTS.md`** (the Linux-Foundation convention auto-discovered by Claude
Code, Codex, Cursor, Aider, Windsurf) and led it with operational essentials — what this is, the
build/test/lint commands, a project map, the headless `--seed` path, and a checkpoint headless clause —
before folding into the working protocol. Single-sourced (no fork), with `README.md` and
`CONTRIBUTING.md` reconciled for accuracy (stale paths removed, the agent entry point and `--seed`
no-TTY path surfaced where a cold agent looks first).

### Pillar C — Secret-acquisition self-service, with the human pulled in only when required

A missing secret is the one moment the agent legitimately needs a human. `PluginRequirementSchema`
gained optional `{ acquire_url?, scopes?, instructions? }` — **static public pointers only**, pinned by
a Trust-Through-Restraint test asserting nothing secret-shaped ever rides these fields. `GITHUB_TOKEN`
and `TELEGRAM_BOT_TOKEN` requirements are single-sourced across their manifests; resolution
(`findSecretAcquisition`/`describeSecretAcquisition`) is **plugin-opaque** (it iterates registered
manifests, never a hardcoded list). `doctor` and the seed-incomplete setup path both enrich a missing
secret with its acquisition steps and **degrade gracefully** to the generic remedy when none exist —
never an `undefined` tail. The agent-facing `doctor --json` contract was frozen and hardened: it
serializes `{ checks, exitCode }` with a stable field shape, and now provably *still serializes valid
JSON when the system is broken* (failed config load → no bundle; missing home) — an agent runs `doctor`
precisely when something is wrong, so it must never get a crash or half a document.

### Pillar D — One plugin-authoring methodology across all four adapters (the co-spike)

Plugin authoring was the owner-named biggest friction point. `docs/contribution-docs/how-tos/plugins/
authoring.md` is now a single executable 9-step spine — idea → contract → reference → manifest →
contract-test → register → verify → **contribute back** — that works for any of the four adapter types
(Trigger, Communication, Agent, GitHosting), with each adapter README trimmed to a thin pointer into
the spine rather than a divergent copy. The contract-suite vocabulary was normalized
(`LLMContractFixtures`→`AgentContractFixtures`, `infer()`→`run()`) so the discoverable, runnable
contract test matches the adapter it proves. The flywheel is explicit: authoring ends with a real
contribute-back path, and contributed plugins are first-party in-repo for v1.

### Pillar E — Operator-setup runbook (the hero) + the setup→authoring bridge

`docs/contribution-docs/how-tos/setup/operator-setup.md` is the runbook that drives a cold daemon to
green for a single human, end to end: build/link (Step 0), the **Telegram `/start` handshake** (the
silent-failure that blind validation surfaced), `--daemon`, owner-channel cleanup, and a non-interactive
`--seed` path. The bridge from setup into authoring — when the human's tooling has no shipping plugin,
the agent authors one on the spot and continues to a green daemon — is realized as **agent-side
inference in the runbook, not Core coupling**. The seed example was hardened (no personal CLI path,
opacity-respecting placeholders), and a `start` exit-code fix makes an incomplete `--seed` fail loudly
(exit 1) instead of a false success.

## Locked Decisions

- **Hero = operator/setup; co-spike = plugin authoring.** The two journeys most likely to strand an
  agent; everything else held to the never-stuck bar by gap-closing, not new build.
- **The secret/sensitive boundary is open-ended and agent-judged.** The agent attempts everything,
  pulls the human in only when truly blocked (secrets), leads with precise "do X, tell me when done",
  and resumes. Human present, working *through* the agent — not a hard gate.
- **Self-verification is the spine, delivered by extending `doctor`, not a new command.** "Done" = a
  command that returns zero; `doctor --json` is the machine-readable readiness verdict. No live-agent CI
  harness — the money-shot is proven by blind cold-agent walkthrough + owner review.
- **`AGENTS.md` by rename-and-enrich, single source.** Complements (not replaces) README/CONTRIBUTING.
  **`llms.txt` dropped from this slice** — its value is tied to a hosted docs site (Slice 13 / VitePress)
  and is coordinated there.
- **Plugin-opaque, build-your-own.** No blessed-default stack; shipping plugins are examples only;
  detection/acquisition derive from manifests, never hardcoded names. **Contribute-back flywheel** is
  the closing move of authoring.
- **Generate, don't hand-maintain.** The bundled mirror is generated + CI-guarded; the secret metadata
  is single-sourced — both close a whole class of drift by construction.

## What the Blind Validation Proved (the acceptance test, not a checklist)

The owner's scaled-agent insight: human UX has sample size one (the developer), but agent UX scales to
as many blind agents as we want — so "never gets stuck" can be *proven* with real cold runs, not just
judged. Two rounds of fresh sub-agents, each given only the repo and a realistic goal, unaware they were
being tested:

1. **Round 1** (operator / authoring / bridge / onboarding): ~90% unaided; discoverability excellent;
   surfaced the real last-mile gaps — the **Telegram `/start` silent handshake**, a missing build step,
   the Linear-plugin `TriggerEvent` field mapping, a model pin, a missing `cancel` in the command list.
   All fixed.
2. **Round 2** (operator + author-a-Linear-plugin): **both verdicts flipped to "yes, completes unaided,
   end to end — no hard-fails."** A deeper layer surfaced (the false-success exit code, a placeholder
   detector mismatch, non-git `external_ref` mapping) and was fixed. Iteration stopped here — no
   hard-fails is the bar; a third round would be gold-plating.

The 3-auditor closing sweep then found zero real code/test defects — only a doc count error, a redundant
scope phrasing, a placeholder dual-source, and trailing `LLM`→`Agent` rename residue.

## Lens Check

- **Plugin Authoring Simplicity.** Strongly positive — the slice's reason to exist. One executable
  methodology across all four adapters; the contract test that proves a plugin is discoverable and
  runnable; an explicit contribute-back path.
- **UX Quality.** Positive. A cold agent (and a human) gets a single entry point, a runbook to green, a
  secret remedy that tells you exactly where to get the token, and a `doctor` that never lies — including
  when the system is broken.
- **Plugin Opacity.** Held. Secret-acquisition resolution iterates registered manifests; no plugin name
  or token is hardcoded in Core; the bundled mirror renders whatever docs exist.
- **Trust Through Restraint.** Held + test-locked — the new acquisition fields carry only static public
  pointers, asserted free of secret-shaped content.
- **Observability.** Neutral-to-positive — `doctor --json` is now a frozen, failure-proof agent contract.

## Build Record

Six cohesive commits on `main` (consolidated from the build sessions into clean, freshly-timestamped
groupings per the owner's request): `12865c6` RRP artifacts, `388f003` bundle generator + drift guard,
`0f6e39e` `AGENTS.md` + onboarding, `b526849` secret self-service + `doctor --json` hardening, `9f64cf9`
unified authoring, `560adb4` operator runbook + seed hardening — plus this wrap. Net ≈ −470 lines (the
bundle regeneration). Final verification on the merged tree: lint 0 (biome + `tsc` src/test + knip +
madge), **2607 unit + 64 integration + 16 e2e**, `build` + `build:dashboard` 0, bundled docs in sync.

## Cross-Slice Notes

- **Resolved the pre-existing `AGENT_README`/plugin-docs bundled-mirror drift** carried since Slice 10 —
  the generator + CI guard make it structurally impossible, closing the open item Slice 11 forwarded.
- **`llms.txt` and the docs site are deferred to Slice 13** (Dashboard Revisit + Final Polish — VitePress
  on GitHub Pages); the no-tool-specific-files invariant was reconciled (repo-onboarding `AGENTS.md` ≠
  the runtime no-`CLAUDE.md` rule).
- **Touched no Slice 11 runtime surface;** the integration was textual only (README footer, `package.json`
  version, `doctor` import block) and verified non-overriding.

## Future Considerations

- **Channel-handshake setup-completeness** — an opacity-aware detector for the Telegram `/start`-style
  "configured but not yet reachable" state (captured in `docs/future-considerations.md`).
- **A plugin scaffold generator** — research-gated and deferred; the methodology is executable by hand today.
- **An external plugin registry** — post-v1; contributed plugins are first-party in-repo for now.
