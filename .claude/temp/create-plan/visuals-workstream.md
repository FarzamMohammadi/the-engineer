# Plan: Visuals Workstream — README assets for v0.2.0-preview

**Date**: 2026-05-20 | **Stakes**: Low
**Upstream**: [`.claude/temp/requirements-gathering/oss-prep.md`](../requirements-gathering/oss-prep.md)
**Status**: Draft (calibrated light per user instruction — no panel review or pre-mortem; this is asset production, not architectural work)

## Intent

Produce the three visual assets that the v0.1.0-preview README explicitly defers: an architecture diagram, a hero dashboard screenshot, and an end-to-end animated GIF. The goal is a README that *looks* like the project it actually is — portfolio-quality first impression for the three audiences (recruiters skimming, engineers trying it, contributors deciding whether to invest).

The v0.1.0-preview ships text-only with `<!-- TODO(visuals): ... -->` markers showing exactly where each asset goes. This workstream fills those markers and (optionally) cuts a v0.2.0-preview tag whose headline value-add is "the project now looks real on the README."

## Context to load before starting

Future session should read these in order before writing or committing anything:

1. This plan in full.
2. [`docs/the-engineer-persona.md`](../../../docs/the-engineer-persona.md) — to embody the project's voice.
3. [`README.md`](../../../README.md) — current state, including the two `<!-- TODO(visuals): -->` markers and the orchestra metaphor that runs through it.
4. [`docs/architecture/overview.md`](../../../docs/architecture/overview.md) and [`docs/architecture/three-tier-model.md`](../../../docs/architecture/three-tier-model.md) — source of truth for the architecture diagram.
5. [`docs/philosophy.md`](../../../docs/philosophy.md) § "Orchestrate, Don't Build" and § "Plugin Opacity" — the conceptual model the diagram has to honor.
6. The [requirements doc](../requirements-gathering/oss-prep.md) — for acceptance criteria (line 105) and the visuals deferral framing (lines 127, 167–178).

## Decisions

### D1: Architecture diagram format → **Mermaid (pure text)**

**Choice**: Embed a Mermaid diagram inline in the README at the existing TODO marker. No external image file.

**Context**: GitHub renders Mermaid natively in markdown. The diagram lives in the same file it documents, edits cleanly via git diff, never goes out of sync with code changes the way an exported PNG would.

**Rejected**:
- **SVG / exported PNG (Figma, Excalidraw, draw.io)**: requires an external tool, an exported file under `docs/assets/`, and re-export every time the architecture changes. Higher fidelity for complex diagrams, but the three-tier model is simple enough that Mermaid is more than sufficient.
- **ASCII art**: works without rendering but looks amateurish for a portfolio piece.

**Consequence**: All architecture-diagram edits happen by editing the README itself. No `docs/assets/architecture.png` file. Diagram improvements are one-line commits.

### D2: Hero dashboard screenshot → **User-captured, agent integrates**

**Choice**: User runs the daemon + dashboard locally on their machine, captures a real Chrome screenshot, drops the file at `docs/assets/dashboard-hero.png`, and tells the agent. Agent integrates into the README.

**Context**: A screenshot taken from real Chrome on a real screen looks authentic. Same screenshot rendered via headless Playwright in a sandboxed env tends to look "off" — fonts antialias differently, scrollbars show, hover states are missing. For a portfolio asset, authenticity matters more than automation.

**Rejected**:
- **Headless Playwright capture in this session**: requires installing playwright (~100MB dev dep), spinning up the full daemon with seeded data, and yak-shaving for visual parity with real Chrome. Net cost: 1–2 hours for a worse result.
- **Stock UI mockup**: dishonest. The dashboard is real; the screenshot should be of the real dashboard.

**Consequence**: This task is gated on the user finding ~30 minutes when the dashboard is running with realistic data. Agent cannot produce this asset solo.

### D3: GIF tool → **Recommend Kap (macOS); fall back to LICEcap (cross-platform)**

**Choice**: User records the GIF using Kap (free, native macOS, exports GIF directly), or LICEcap if not on Mac. Agent does not record screens.

**Context**: Kap is the standard for short, clean macOS screen-recordings-to-GIF. LICEcap is older but works everywhere. Both keep the workflow under five minutes once the demo content is set up.

**Rejected**:
- **OBS + ffmpeg + gifski pipeline**: most control, but multi-step and easy to get stuck on color palette / size tradeoffs.
- **Asciinema (terminal-only)**: doesn't show the dashboard, which is the visually compelling part.

**Consequence**: The user is responsible for recording. Agent advises on duration/content and integrates the final asset.

### D4: GIF placement in README → **Within "What it is" section, just before the conductor closer**

**Choice**: Insert the GIF in the `## What it is` section, after the closing prose paragraph but before the "Think of it as **the conductor**" closing line.

**Context**: The "What it is" section's job is to land what the project *does*. Prose tells; a GIF shows. Placing it there pays off the section's thesis with a visual demonstration. The hero screenshot at the top sets the visual tone; the GIF in "What it is" delivers the operational story.

**Rejected**:
- **Top of README, under the hero screenshot**: too much visual weight at the top. Reader gets overwhelmed before reading any prose.
- **Inside "How it works"**: an option, but "How it works" is architecture-focused; the GIF is behavior-focused. They tell different stories.

**Consequence**: A new `<!-- TODO(visuals): end-to-end GIF here -->` marker should be added during this workstream (or the placement decided at integration time). The current README doesn't have a marker for the GIF specifically — only for the hero screenshot and architecture diagram.

### D5: Release packaging → **One commit per asset; tag v0.2.0-preview once all three land**

**Choice**: Each asset ships in its own commit as soon as it's ready (architecture diagram first, screenshot second, GIF third). When all three are in, cut `v0.2.0-preview` with a CHANGELOG note pointing at the visual upgrade. If only one or two land before time runs out, ship those — no need to hold them hostage to the GIF.

**Context**: The visuals workstream is genuinely independent of v0.1.0-preview shipping. Each asset is independently shippable. Coupling the tag to all-three landing risks the tag never happening.

**Rejected**:
- **One big commit + tag at the end**: defers value, larger blast radius if any asset has issues.
- **No tag, just commits**: loses the "the project now looks real" milestone signal that recruiters and engineers notice in the GitHub releases sidebar.

**Consequence**: Don't be precious about the tag. If the GIF takes weeks, ship the architecture diagram + screenshot as v0.2.0-preview when both land, and add the GIF later in v0.3.0-preview.

## Scope Boundary

**Delivering**:

- A Mermaid architecture diagram embedded in the README's `## How it works` section
- A real dashboard screenshot at `docs/assets/dashboard-hero.png`, integrated at the top of the README
- An animated GIF demonstrating an end-to-end task, integrated into `## What it is`
- A `docs/assets/` directory (created with the screenshot or earlier if needed) with a tiny `docs/assets/README.md` explaining what lives there
- A v0.2.0-preview tag and short CHANGELOG entry once all three (or any subset) ship

**Deferring**:

- Animated SVG, Lottie, or video formats — GIF is sufficient for a preview
- Custom branding (logo, banner, social-preview image) — separate concern, explicitly out of scope per the OSS-prep requirements doc
- Multiple architecture diagrams (e.g. a separate one for the tick loop) — start with one three-tier diagram; add more only if a real reader signals confusion
- Tutorial-length screencast — the GIF is a *demonstration*, not a documentation video. Long tutorials belong in `docs/usage-guide/`, not on the README.

## Task Breakdown

### Task 1: Architecture diagram (Mermaid) [estimated: 15–30 min, agent solo]

**Goal**: The README's `## How it works` section renders a Mermaid diagram showing the three-tier model with example plugins, and the diagram renders correctly on github.com.

**Where**: `README.md` — replace the `<!-- TODO(visuals): architecture diagram here (three-tier model: Core → Adapters → Plugins) -->` marker with a Mermaid code block.

**Approach**:
1. Draft the Mermaid diagram showing: triggers (top) → Core (center, with key components named: TaskEngine, Orchestrator, SafetyLayer, EventBus, Daemon) → coding CLIs (LLM plugins on one side, communication on the other side) → git hosting (bottom). Use Mermaid's `graph TB` (top-to-bottom) with subgraphs grouping the four adapter categories.
2. Honor the orchestra metaphor lightly — Core could be labeled "Core — The conductor" so the diagram and the bullets match.
3. Prefer clean Mermaid output over exhaustive completeness. The diagram should be readable at a glance; if it needs explaining beyond what the surrounding prose covers, it's too complex.
4. Optional: a second smaller Mermaid diagram for the tick loop later. Don't include it in this task — only if the three-tier diagram lands well and there's room for more.

**Depends on**: Nothing.

**Verify**:
- Open the README's GitHub preview (push to a branch and view on github.com) and confirm the diagram renders as an SVG, not as raw code.
- Read the diagram fresh, after a 5-minute break — can a reader who has *only* read this paragraph understand the three tiers from it?

**Commit**: `Add three-tier architecture Mermaid diagram to README`

### Task 2: Hero dashboard screenshot [estimated: 30–60 min, user-led]

**Goal**: The top of the README renders a real dashboard screenshot that immediately conveys "this is a real working system."

**Where**:
- New file: `docs/assets/dashboard-hero.png` (ideally 1600–2000 px wide, PNG, under 1 MB after optimization)
- `README.md` — replace the `<!-- TODO(visuals): hero dashboard screenshot here -->` marker with `![The Engineer dashboard](docs/assets/dashboard-hero.png)` (or with HTML if width control is needed)

**Approach** (split between user and agent):
1. **User**: ensure `docs/assets/` exists in the repo (agent can create with a brief README explaining its purpose).
2. **User**: start the daemon (`engineer start`) and dashboard locally. Use a seed directory with realistic non-personal data (`./scripts/reset.sh seed-example` if needed).
3. **User**: wait until the dashboard has populated data — visible tasks, real status indicators, no empty states.
4. **User**: capture at a high-DPI resolution (Cmd+Shift+4 on Mac for window-level capture). Aim for the Overview page; it's the most visually rich.
5. **User**: scan the frame for anything personal or sensitive (real repo names, real GitHub handles, real tokens visible in any tooltip). If found, retake or crop.
6. **User**: optimize the PNG (TinyPNG, ImageOptim, or `pngquant`) to keep it under 1 MB without visible quality loss.
7. **User**: drop the file at `docs/assets/dashboard-hero.png`, tell the agent it's ready.
8. **Agent**: replace the README TODO marker with the image syntax, choose an alt text that's accurate and accessible, commit.

**Depends on**: Task 1 (so the README has a coherent visual identity by this point), and on user availability with the dashboard running.

**Verify**:
- Open the README's GitHub preview; image loads at a readable size, not too cramped or stretched.
- Verify no personal data visible: no real repo URLs, no real tokens, no `/Users/farzammohammadi/` paths in any visible tooltip, no real Telegram handles.
- File size under 1 MB.

**Commit**: `Add hero dashboard screenshot to README`

### Task 3: End-to-end GIF [estimated: 1–3 hours, user-led]

**Goal**: The README's `## What it is` section renders a short looping GIF that visually demonstrates a task moving through the daemon — trigger arrives, orchestration phases run, PR opens.

**Where**:
- New file: `docs/assets/end-to-end.gif` (ideally under 5 MB; GitHub's hard limit is 10 MB for inline rendering)
- `README.md` — insert at the end of `## What it is`, just before the "Think of it as **the conductor**" closer. Add a new `<!-- TODO(visuals): -->` marker first if helpful for scoping.

**Approach** (split between user and agent):
1. **User**: plan the demo content — pick a simple synthetic trigger (e.g., a GitHub Issue titled "Bug: README typo") that the engineer can plausibly process in ~5–10 minutes of real time.
2. **User**: install Kap (https://getkap.co) if not already installed. Alternative: LICEcap.
3. **User**: start the daemon and dashboard, position the dashboard window and any relevant terminal/log views.
4. **User**: record the run end-to-end at real time (~5–15 minutes). Kap can output GIF directly, but for long content use Kap's MP4 output and convert later.
5. **User**: edit ruthlessly. The final GIF should be **30–60 seconds**. Speed up boring stretches (waiting, log scrolls), cut to key moments: trigger picked up → phase advances visible on dashboard → PR creation moment. Use a video editor (iMovie, ffmpeg + filters, or Kap's built-in trim) and then convert to GIF with `gifski` (best quality) or ffmpeg.
6. **User**: optimize the GIF. Target < 5 MB. If it's larger, reduce frame rate (15 fps is usually enough), reduce dimensions (800px wide is plenty for a README), or shorten further.
7. **User**: drop the file at `docs/assets/end-to-end.gif`, tell the agent it's ready.
8. **Agent**: integrate into the README at the chosen placement, write a one-line caption explaining what's happening, commit.

**Depends on**: Task 1 and Task 2 (the README already has its visual identity by this point; the GIF is the final polish).

**Verify**:
- GIF loops cleanly (last frame transitions back to first without a jarring cut).
- GIF is under GitHub's 10 MB inline limit; ideally under 5 MB for fast page load.
- Render the README on github.com and confirm the GIF plays in a normal browser without download prompts.
- Read the README fresh: does the GIF earn its space, or does it slow you down? If it doesn't add to comprehension, retake.

**Commit**: `Add end-to-end animated GIF to README`

### Task 4: Cut v0.2.0-preview tag [estimated: 15 min, agent + user]

**Goal**: A v0.2.0-preview annotated tag exists, the GitHub release page is updated, and the CHANGELOG documents what's new in this preview.

**Where**:
- `CHANGELOG.md` — add a new `[Preview — v0.2.0]` block above the current `[Preview — active development]` block (or restructure so the current block represents v0.2.0)
- `package.json` — bump version `0.1.0-preview` → `0.2.0-preview`
- Git tag `v0.2.0-preview`
- GitHub release page

**Approach**:
1. Bump `package.json` version.
2. Update `CHANGELOG.md` to document the visual additions concretely without overclaiming. Frame it as "the README now looks like the project it actually is."
3. Commit the version bump + CHANGELOG entry.
4. Cut annotated tag: `git tag -a v0.2.0-preview -m "Preview release with README visuals (architecture diagram, hero screenshot, end-to-end GIF)"`
5. Push tag: `git push origin v0.2.0-preview`
6. Create the GitHub release with a short note pointing to the README.

**Depends on**: Tasks 1, 2, 3 — or any subset if shipping incrementally (see decision D5).

**Verify**:
- `git tag --list | grep v0.2.0-preview` returns the tag.
- GitHub releases sidebar shows v0.2.0-preview as latest.
- `package.json` version matches the tag.

**Commit**: `Cut v0.2.0-preview` (then push tag separately).

## Verification Contract

| Check | Type | Command or Observation |
|-------|------|----------------------|
| Architecture diagram renders | Manual | Open README on github.com (after push); confirm diagram appears as SVG, not raw text |
| Hero screenshot loads | Manual | Open README on github.com; image renders at readable size, no missing-image icon |
| Screenshot privacy | Manual | Visual scan of frame for personal data, real tokens, personal paths |
| GIF plays in-browser | Manual | Open README in a fresh Chrome window; GIF animates without click-to-play |
| GIF file size | Auto | `du -h docs/assets/end-to-end.gif` shows < 10 MB |
| All assets committed | Auto | `git ls-files docs/assets/` lists hero PNG and end-to-end GIF |
| Lint / typecheck unchanged | Auto | `pnpm run lint && pnpm run typecheck` — no new failures (only docs touched, should be clean) |
| README parses | Manual | GitHub markdown rendering shows no broken syntax (e.g., a stray `<!--` left in) |

## Risks

| Risk | If It Happens | Mitigation |
|------|--------------|------------|
| User never has time for the screenshot/GIF | Visuals workstream stalls indefinitely | Ship just Task 1 (architecture diagram) as a tiny commit. The README still looks better than text-only. Don't block on the larger assets. |
| Screenshot leaks personal data | Embarrassment, partial information disclosure (low severity but visible) | Hard verification step in Task 2 before committing. If found post-commit, force-remove + re-commit; if pre-push, just amend. |
| GIF file too large for GitHub inline rendering | Image shows as link / placeholder instead of animating | Optimize aggressively: 15 fps, 800px width, gifski. If still over 10 MB, host externally (GitHub release attachment) and link. |
| Mermaid renders inconsistently between editors | Diagram looks broken in some environments | GitHub is the source of truth. Verify on github.com after push; if local IDE shows it differently, that's an IDE issue, not a content issue. |
| User chooses to add a logo / branding later | Conflicts with this plan's "no custom branding" scope | Acceptable — logo lives in `docs/assets/` alongside these files, doesn't conflict with anything here. Reopen the scope conversation when it's time. |

## Skipped Phases (calibrated to low stakes)

The create-plan skill normally runs an `/expert-panel-review` and an optional pre-mortem. For this work, both are explicitly skipped — the rationale:

- **No architectural choices.** Every decision in this plan is a tool/asset choice, not a system design.
- **No production code changes.** Asset files and markdown integration; the running daemon, the test suite, the lint config are all untouched.
- **Fully reversible.** Every commit can be reverted with no impact on functionality or state.
- **User explicitly requested calibration.** "Light plan, not heavy" was the brief.

If a future session decides this workstream actually has more risk than expected (e.g., needs to involve a real headless capture pipeline, or branding decisions, or a build-time asset pipeline), restart with `/create-plan` and don't skip the panel.

## References

- Requirements: [`.claude/temp/requirements-gathering/oss-prep.md`](../requirements-gathering/oss-prep.md) — acceptance criteria (line 105), visuals deferral framing (lines 127, 167–178), affected systems list including `docs/assets/` (line 141)
- README markers to fill: line ~10 (hero screenshot), line ~72 (architecture diagram); GIF marker to be added in this workstream
- Build journal entry once shipped: not required (the build journal is the implementation-docs archive, not this OSS-prep tangent)

## How a future session should pick this up

1. Open this file. Read Intent + Decisions + Tasks.
2. Confirm with the user which task to tackle today (Task 1 can be done solo; Tasks 2 and 3 need user availability).
3. For Task 1: just write the Mermaid, push, verify on github.com, commit.
4. For Tasks 2 and 3: confirm the user has time and the dashboard environment set up before starting; they're not zero-effort tasks for the user side.
5. Don't try to do all three tasks in one session unless the user has explicitly blocked off the time.
