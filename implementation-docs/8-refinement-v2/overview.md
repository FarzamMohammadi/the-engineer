# Layer 8 — Refinement v2

Two co-founders. One product. Every edge sharpened together.

---

## What This Is

This is where The Engineer goes from "architecturally sound" to "something we absolutely love and use daily." Layers 0-7 built the foundation — correct architecture, clean structure, comprehensive tests. Layer 8 is where we drive it, feel every rough edge, and refine until it's beautiful.

This phase absorbs and supersedes Phase 6.8 (Hardening & OSS Prep) and Phase 6.10 (War Room v2 Dashboard). Whatever those phases would have delivered gets folded into this flow naturally, at the right time.

## Who We Are Here

Farzam and the agent work as co-founders — two elite software engineers and architects bringing a piece of OSS software to life together.

- Farzam provides taste, compass, and final decision authority on product direction
- The agent provides depth, pattern recognition, and tireless execution
- Both take ownership. Both watch each other's back. Both are unbiased.

This isn't a "user gives instructions, agent executes" dynamic. It's a partnership where each complements the other's strengths.

## Working Principles

- **Never assume.** If uncertain, ask. Use the Q&A tool liberally.
- **Always collaborate.** Every non-trivial decision is made together.
- **Unbiased.** No attachment to prior work. If something needs to change, it changes.
- **Co-ownership.** Both of us take responsibility for the outcome.
- **Taste matters.** We're not just making it work — we're making it right.
- **Adapt for the future.** Everything we refine should work for current plugins AND be adaptable for future ones (Jira, Azure DevOps, etc.).
- **Don't repeat yourself.** Document once, reference always. Session continuity is non-negotiable.

## How Sessions Work

Every session follows this flow:

1. **Start** — Read `implementation-docs/active.md` to see current focus
2. **Orient** — Read `8-refinement-v2/status.md` for where we left off and `roadmap.md` for where we're headed
3. **Continue** — Pick up exactly where the last session ended. No re-explaining.
4. **Work** — Investigate, refine, test, discuss. Farzam guides taste and direction. The agent provides depth and execution.
5. **Wrap** — Run `/wrap-session` to log the session, update status, and generate a starter prompt for next time

## How We Approach Each Phase

For each phase in the roadmap:

1. **Investigate** — Read the relevant code. Understand what exists, what it does, what it should do.
2. **Evaluate** — Does it align with our architecture decisions? Does it work correctly? Are there gaps?
3. **Discuss** — Surface findings. Farzam and agent decide together what to refine and how.
4. **Refine** — Make the changes. Test them.
5. **Verify** — Farzam manually tests where needed. Agent runs automated checks.
6. **Move on** — Update status, mark phase done in roadmap, proceed to next.

## Strategic Decisions

Three load-bearing decisions shape everything in this phase:

1. **CLI-only LLM integration.** Remove API-based LLM adapter entirely. The Engineer integrates exclusively with CLI tools (Claude CLI, Codex, Gemini CLI, OpenCode). Permanent simplification — CLI tools are the right abstraction for agentic work.

2. **RPI methodology (Research → Plan → Implement).** Research and planning phases produce real files in the workspace, not in-memory objects. These files serve as context for execution, appear in PRs for reviewer visibility, and act as crash-safe checkpoints. Configurable cleanup before merge. Inspired by [HumanLayer's RPI pattern](https://github.com/humanlayer/advanced-context-engineering-for-coding-agents/blob/main/ace-fca.md).

3. **Dashboard-first.** Rebuild the simple dashboard before refining anything else. Maximum data visibility gives us (and future users) the instrument panel needed to guide every refinement that follows. Full React rebuild comes at the end, once we know exactly what we want.

**Resilience is a lens, not a phase.** Every phase we touch, we ask: what happens when this breaks? Can the engineer explain what happened? Can it recover? Can the user unstick it? Woven into every refinement.

## What "Done" Looks Like

Layer 8 is done when:

- Every runtime phase has been manually tested and refined
- The happy path works flawlessly end-to-end
- Error paths are graceful and recoverable — the engineer explains what went wrong and can be unstuck
- LLM integration is CLI-only, supporting multiple CLI tools as plugins
- RPI methodology produces real research/plan files that appear in PRs
- The engineer is something we use daily with confidence
- Communication (notifications, feedback) is polished
- The War Room dashboard provides full real-time visibility into everything the engineer does
- The project is ready for the open source community
- We love using it
