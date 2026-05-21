# Requirements: Open-Source Preparation (Preview Release)

## Context

The Engineer is mid-development — currently at slice 5 of 16 in the Phase 9 "OSS Ready" roadmap. The original plan was to complete all 16 slices before going public. Plans have changed: the user wants to open-source **now**, as a credibility-grade preview release that can sit on their resume and be shared publicly. The remaining slice work (5–16) will continue **after** this OSS-prep tangent, on the same public repository.

This is portfolio-critical work for an AI engineer preparing for interviews. The bar is "extremely professional, follows best practices, but not overboard." Every artifact must signal craftsmanship and intent without padding.

## True Intent

Convert the repository from "actively-built private codebase that happens to be on GitHub" to **a credible, legible, honestly-framed open-source preview** that:

1. Is **legally** open-source (license file, attribution, copyright).
2. Sets correct expectations: "preview, active development, not v1" — visible immediately.
3. Removes friction for the three target audiences (recruiters skimming, engineers wanting to try it, engineers thinking about contributing).
4. Protects the user from spam, premature monetization signals, and dependence on still-uncertain decisions.
5. **Preserves the in-progress slice work** — the user resumes slice 5 in the next session with no friction from this tangent.

## Scope

### In Scope

- LICENSE file (MIT)
- `package.json` metadata for OSS (license, repository, bugs, homepage, keywords; **no** `author` email per chosen attribution pattern)
- README rewrite for OSS audience — loud preview status, balanced for all three audiences, hero-visual placeholder
- `CONTRIBUTING.md` update (already exists; correct clone URL, fix stale references, align with current state)
- `CODE_OF_CONDUCT.md` update (remove placeholder email, point to GitHub-based reporting)
- `CHANGELOG.md` rewrite — replace `[Unreleased]` with a single undated `[Preview — active development]` entry that honestly reflects current state
- `SECURITY.md` (new) — points to GitHub private vulnerability advisories
- Move `implementation-docs/` → `docs/archived/implementation-docs/` (location move only; **no file content modifications**)
- Update README's note about `implementation-docs/` to reflect new path + framing as build journal/archive
- Update `MEMORY.md` `Key Files` references to point to new archived path (so the user's next session still finds `active.md`)
- README clone URL fix (placeholder `github.com/user/the-engineer.git` → real `FarzamMohammadi/the-engineer`)
- CI badge in README (CI workflow already exists at `.github/workflows/ci.yml`)
- Maintainer attribution: `Built by [Farzam Mohammadi](https://github.com/FarzamMohammadi)` in README; full name in LICENSE copyright; `farzamm.oss@gmail.com` as author email in `package.json`
- Visual treatment (LAST in execution order): hero dashboard screenshot, end-to-end daemon GIF, architecture diagram(s)
- A **"GitHub repository settings" checklist** document (or section) covering: About description, topics, social-preview image, enabling private vulnerability reporting. User applies manually on github.com.
- Tag `v0.1.0-preview` cut against the commit that completes this OSS prep work
- Verify no sensitive material is publicly visible (`.env.test`, seed directories, hardcoded paths, hardcoded credentials)

### Out of Scope

- **All files under `implementation-docs/`** — content unchanged; only the directory's *location* moves. The slice files, session logs, active.md, approach.md, vision.md are preserved verbatim.
- npm publishing (defer to v1)
- Setting up automated versioning (Changesets, semantic-release) — defer to v1
- Logo, banner, custom branding, custom social-preview image
- `FUNDING.yml` / GitHub Sponsors / sponsorship buttons
- `CODEOWNERS` file (solo project, premature)
- Marketing website, demo deployment, "try it without installing" experiences
- Slice 5 work or any further slice work (resumed in the next session after this tangent)
- Settings on github.com itself (About description, topics, enabling private advisories) — the user applies these manually; we document what to apply
- Conventional commits or commit-message format changes
- Branch protection rules

## Requirements

### Functional

1. **LICENSE file** at repo root.
   - **Acceptance:** Standard MIT license text. Copyright line: `Copyright (c) 2026 Farzam Mohammadi` (no email in LICENSE — matches Kit Langton / Colin McDonnell pattern).

2. **`package.json` OSS metadata.**
   - **Acceptance:** Fields present: `license: "MIT"`, `repository` (with `type: "git"` and `url: "git+https://github.com/FarzamMohammadi/the-engineer.git"`), `bugs.url`, `homepage`, `keywords` (concise, ~5–8 relevant terms), `author: "Farzam Mohammadi <farzamm.oss@gmail.com>"`. Version stays at `0.0.1` for now (tag `v0.1.0-preview` is independent of `package.json` version during preview).

3. **README rewrite.**
   - **Acceptance:** Includes:
     - Title + one-line tagline
     - Loud "Preview / active development" status block immediately under title (badge or callout — both is fine)
     - Hero visual placeholder (filled in during the visual workstream)
     - One-paragraph "What is this" for skim readers
     - Get Running section (already exists, just clone URL fix + ensure accuracy)
     - Commands quick-reference (exists)
     - Architecture overview snippet + link
     - "Build Journal" pointer to `docs/archived/implementation-docs/` framing it as an asset, not a chore
     - Documentation links (exists)
     - Contributing pointer
     - License pointer
     - Built-by attribution
   - **Acceptance:** All claims are accurate against current code state (test counts, plugin counts, command counts). No stale numbers.

4. **CONTRIBUTING.md update.**
   - **Acceptance:** Existing structure preserved. Clone URL accurate (already correct). Any stale references fixed. Consistent with current project structure (e.g., test count if referenced).

5. **CODE_OF_CONDUCT.md update.**
   - **Acceptance:** Placeholder email `conduct@the-engineer.dev` replaced with a GitHub-based reporting path ("Open a private issue or contact a maintainer via GitHub"). TODO comment removed.

6. **CHANGELOG.md rewrite.**
   - **Acceptance:** Replaces `[Unreleased]` with `[Preview — active development]` (no date). Entry honestly reflects current capability set: actual adapter types, actual plugin list, actual test count, current CLI commands. Stale stats fixed.

7. **SECURITY.md (new).**
   - **Acceptance:** Short file (15–25 lines). Includes: what's in scope, what's out of scope, "report via GitHub's private security advisories on this repo" as the channel, expected response time (e.g., "best effort during preview, no guaranteed SLA"). Reads honest, not corporate. No email.

8. **Move `implementation-docs/` → `docs/archived/implementation-docs/`.**
   - **Acceptance:** `git mv` (preserves history). All files inside are byte-identical to before. A short `docs/archived/README.md` (~10 lines) frames the archive: "This is the build journal from Phases 0–9. Preserved as-is for transparency. Not authoritative — `docs/` is the authoritative documentation."
   - **Acceptance:** README's note about implementation-docs is updated to point to the new location and reframe it as an asset.
   - **Acceptance:** `MEMORY.md` references to `implementation-docs/9-oss-ready/active.md`, `approach.md`, `vision.md` are updated to the new path, so the user's next session finds them seamlessly.

9. **CI badge in README.**
   - **Acceptance:** Standard GitHub Actions badge for the existing CI workflow, near the title.

10. **GitHub repo settings checklist** (documented for user to apply manually).
    - **Acceptance:** A document or README section listing exactly: About description (succinct + enticing), topics to add (~5–8), website URL (if applicable), enable "Private vulnerability reporting" toggle. User pastes these into github.com.

11. **Visual workstream** (executed LAST).
    - **Acceptance:** At least one hero screenshot of the dashboard placed at the top of README. At least one architecture diagram (three-tier model). One animated GIF demonstrating an end-to-end task being processed. All committed to `docs/assets/` or similar.

12. **Sensitive-material audit.**
    - **Acceptance:** Verify `.env.test` is not tracked OR its contents are demonstrably safe (no real tokens, only obvious-fake values). Verify no seed directories with real credentials are tracked. Verify no hardcoded paths point to `/Users/farzammohammadi/...`. Verify no real bot tokens, API keys, or session secrets in any committed file.

13. **Tag `v0.1.0-preview`.**
    - **Acceptance:** Annotated git tag cut against the merge commit (or final commit) of the OSS-prep work, pushed to GitHub. The release on GitHub uses the tag and includes a short release note pointing to README.

### Non-Functional

- **Quality:** Every artifact reads as if written by a senior engineer who cared. No template-flavored "TODO fill this in" content. No padding.
- **Honesty:** Every claim verifiable against the current code state. No "10x faster" marketing prose. No metrics fabrication.
- **Reversibility:** All changes are file-level changes on a feature branch. No destructive operations on shared state. The slice-5 workflow continues unaffected after merge.
- **Time-boxed:** Visuals are deferred to last so that even a partial completion of this work leaves the repo substantially more OSS-ready than today.

## Edge Cases & Error Handling

- **`.env.test` is tracked with real content** → if discovered, file is either removed and re-added via `.env.test.example`, OR contents are sanitized to obvious-fakes. This is a hard blocker on going public.
- **Stale numbers in README/CHANGELOG** → run actual checks (`pnpm test`, count plugins/adapters) and replace before merging. No "approximately" or "1000+" hand-waving.
- **`MEMORY.md` references to old path** → must be updated in the same commit as the `git mv`, otherwise the next slice-5 session fails to find `active.md` and the user hits friction.
- **Tag `v0.1.0-preview` conflicts** → if a tag of that name already exists locally or remotely (unlikely, but check), use the next available preview number.
- **Email `farzamm.oss@gmail.com` not yet created** → user creates it. The address goes into `package.json` regardless. If user picks a different address before merge, one find-and-replace.
- **Visual workstream runs out of session time** → all other work is shippable without visuals. README is structured so the visual section is additive, not blocking. We can merge the textual prep, ship the preview tag, and follow up with visuals in a separate commit.

## Open Questions

None at this point. All scope decisions have been resolved with the user. The two items that require user action **outside** this session are:

- Create `farzamm.oss@gmail.com` on Gmail (60 seconds).
- Apply the GitHub repository settings checklist on github.com (About, topics, enable private advisories) after the OSS-prep work merges.

## Affected Systems

- **Repo root files:** LICENSE (new), package.json (metadata), README.md (rewrite), CONTRIBUTING.md (update), CODE_OF_CONDUCT.md (update), CHANGELOG.md (rewrite), SECURITY.md (new)
- **Directory structure:** `implementation-docs/` → `docs/archived/implementation-docs/` (move)
- **`docs/archived/README.md`** (new — short archive framing)
- **`docs/assets/`** (new — for hero screenshot, diagram, GIF)
- **`MEMORY.md`** in user's `~/.claude/projects/.../memory/` — path references updated so slice-5 session resumes cleanly. **Note:** this is an instruction to me to update, not a content change to the slice files themselves.
- **`.github/`** — no required changes for this pass (existing PR template, issue templates, CI all stay)
- **Git tags + GitHub releases** — `v0.1.0-preview` cut at end
- **External (user manual):** github.com repo settings (About, topics, private advisories toggle), creating `farzamm.oss@gmail.com`

## Acceptance Criteria

- [ ] LICENSE file at repo root, MIT, with correct copyright (`Farzam Mohammadi`, year 2026, no email).
- [ ] `package.json` has `license`, `repository`, `bugs`, `homepage`, `keywords`, `author` (with `farzamm.oss@gmail.com`).
- [ ] README.md rewritten: preview status loud and prominent, all three audiences served, accurate stats, real clone URL, CI badge, built-by attribution, build-journal pointer.
- [ ] CONTRIBUTING.md reviewed for accuracy against current state.
- [ ] CODE_OF_CONDUCT.md has no placeholder email, no TODO comment, uses GitHub-based reporting path.
- [ ] CHANGELOG.md replaced with honest `[Preview — active development]` entry reflecting current code state.
- [ ] SECURITY.md exists, points to GitHub private advisories, no email.
- [ ] `implementation-docs/` moved to `docs/archived/implementation-docs/` via `git mv`. Contents byte-identical. `docs/archived/README.md` exists and frames it as a build journal.
- [ ] `MEMORY.md` references updated to new path. Next slice-5 session can find `active.md` without manual intervention.
- [ ] No sensitive material (real tokens, real credentials, personal absolute paths) in any tracked file.
- [ ] GitHub-settings checklist document created for user to apply manually.
- [ ] Visuals: hero screenshot, architecture diagram, end-to-end GIF, all committed (deferred to last).
- [ ] `pnpm test:all && pnpm run lint && pnpm run typecheck` all pass before merge.
- [ ] Tag `v0.1.0-preview` cut after merge.
- [ ] User can complete the manual github.com settings work from the documented checklist in under 5 minutes.

## Execution Ordering Notes

The user explicitly requested that **visuals be done LAST** so that if the session runs out, the textual/structural work is already complete and shippable. Recommended execution order in the plan:

1. Sensitive-material audit (block before anything else if a leak exists)
2. LICENSE + package.json metadata + README clone-URL fix + CHANGELOG rewrite (legal & accuracy foundation)
3. SECURITY.md + CODE_OF_CONDUCT.md update + CONTRIBUTING.md review (OSS social-contract files)
4. `implementation-docs/` move + `docs/archived/README.md` + MEMORY.md path updates + README pointer update (clean root)
5. README rewrite (the big visible artifact)
6. GitHub-settings checklist document (user's manual to-do list)
7. CI badge addition (small)
8. Verification gates (`pnpm test:all`, `pnpm lint`, `pnpm typecheck`)
9. **Visuals workstream** (hero screenshot, architecture diagram, animated GIF) — last
10. Tag `v0.1.0-preview` + push tag + create GitHub release

Each step is independently shippable.
