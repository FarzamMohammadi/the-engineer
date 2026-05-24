import type { RepoContext } from "./context.js";
import { buildRRPIROverview, buildRepoOverview, buildTaskBrief, section } from "./format.js";

// ── Types ────────────────────────────────────────────────────────────────────

/** Context needed to build the planning phase prompt. */
export interface PlanningPromptContext {
  task: {
    title: string;
    description: string | null;
  };
  repoContext: RepoContext | null;
  thoughtsDir: string;
  /** True when research was skipped for a trivial task. */
  skipResearch?: boolean;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Build the prompt for the planning phase (CLI-native RRPIR).
 *
 * Pure function: context in, prompt string out.
 */
export function buildPlanningPrompt(ctx: PlanningPromptContext): string {
  const parts: string[] = [];

  // 1. How The Engineer Works
  parts.push(buildRRPIROverview("Planning", ctx.thoughtsDir));

  // 2. What Happened Before You
  parts.push(buildPriorPhasesSection(ctx.thoughtsDir, ctx.skipResearch));

  // 3. What YOU Need To Do
  parts.push(buildInstructions(ctx.thoughtsDir));

  // 4. Where To Put Your Work
  parts.push(buildOutputSection(ctx.thoughtsDir));

  // 5. The Task Context
  parts.push(buildTaskContext(ctx));

  return parts.join("\n\n");
}

// ── Internal Helpers ─────────────────────────────────────────────────────────

function buildPriorPhasesSection(thoughtsDir: string, skipResearch?: boolean): string {
  if (skipResearch) {
    return section(
      "What Happened Before You",
      [
        "Requirements were gathered. Research was skipped for this trivial task.",
        "",
        `1. **Requirements:** \`${thoughtsDir}/requirements/requirements.md\` — task context, gathered requirements, assessment.`,
        "",
        "Read requirements.md for full context. Do brief targeted codebase exploration during planning to identify relevant files and conventions before creating your plan.",
      ].join("\n"),
    );
  }

  return section(
    "What Happened Before You",
    [
      "Two phases have already completed. Read their deliverables:",
      "",
      `1. **Requirements:** \`${thoughtsDir}/requirements/requirements.md\` — task context, gathered requirements, assessment.`,
      `2. **Research:** \`${thoughtsDir}/research/research.md\` — codebase analysis, relevant files, patterns, conventions.`,
      "",
      "Read both files before you start planning. They contain everything previous sessions discovered.",
    ].join("\n"),
  );
}

function buildInstructions(thoughtsDir: string): string {
  return section(
    "What YOU Need To Do",
    [
      '1. **Read requirements.md and research.md first.** Understand the full context — including the "Simplest Viable Approach" and "Assumptions Made" sections from research. These are your starting inputs, not conclusions.',
      "",
      "2. **Evaluate multiple approaches before committing.** Consider at least two paths:",
      "   - **Simplest:** The minimum viable change that fully meets requirements. Fewest new files, fewest new abstractions, smallest diff. Start here — this is your baseline.",
      "   - **Alternative:** A different approach (more robust, more extensible, different pattern). Only worth considering if it provides concrete value the simplest path lacks.",
      "   Choose one and justify: why this approach over the other? If the simplest path works, choose it. Complexity must earn its place with a specific, articulable benefit.",
      "",
      "3. **Apply architectural filters to your chosen approach.** Before detailing the plan, pressure-test it against these principles:",
      "   - **Plugin Blindness:** Does your design keep Core unaware of specific plugins? If your change touches Core or adapter boundaries, would Core still compile if every plugin were deleted?",
      "   - **Isolation:** Does your design introduce shared mutable state or bleed across task boundaries?",
      "   - **Boundaries:** Are you reaching into module internals, or working through defined contracts? If you need something a module does not expose, the answer is to extend the contract.",
      "   - **Reversibility:** Which decisions in your plan are hard to undo (new interfaces, schema changes, event types)? Call them out explicitly.",
      "   If a filter fails, redesign before detailing the plan — not after.",
      "",
      "4. **Create a precise implementation plan.** Do NOT write code. Every step concrete, every file path specified, every risk considered. Align with architectural patterns documented in research.md — new code that ignores the architecture around it is a regression, even if it works.",
      "",
      `5. **Write the plan** to \`${thoughtsDir}/planning/plan.md\` using the template below. Use checkbox format so execution can track progress.`,
      "",
      "6. **If decomposition is needed** (3+ genuinely independent areas of change), include a `## Decomposition` section. Each subtask runs the full RRPIR pipeline independently. Only decompose when subtasks are truly separable.",
      "",
      '7. **If you need more information,** set `next_phase` to `"requirements_gathering"` in session-result.json.',
    ].join("\n"),
  );
}

function buildOutputSection(thoughtsDir: string): string {
  return section(
    "Where To Put Your Work",
    [
      "```",
      `Deliverable: ${thoughtsDir}/planning/plan.md`,
      `Session result: ${thoughtsDir}/planning/session-result.json`,
      "```",
      "",
      "Update session-result.json with:",
      "```json",
      "{",
      '  "status": "ready" or "need_more_info",',
      '  "next_phase": "execution" (if ready) or "requirements_gathering" (if need more info),',
      '  "summary": "<one-line plan summary>"',
      "}",
      "```",
      "",
      "### plan.md Template",
      "",
      "```markdown",
      "# Plan: [Task Title]",
      "",
      "## Approach Evaluation",
      "",
      "### Simplest Path",
      "[Minimum viable change — what it looks like, why it works or falls short]",
      "",
      "### Alternative Path",
      "[Different approach — what it adds, what it costs]",
      "",
      "### Chosen Approach",
      "[Which path and why. If simplest: say so. If alternative: justify the added complexity.]",
      "",
      "## Phases",
      "",
      "### Phase 1: [Name]",
      "- [ ] [Specific action with file path]",
      "- [ ] [Specific action with file path]",
      "- **Verify:** [How to confirm this phase works]",
      "",
      "### Phase 2: [Name]",
      "- [ ] [Specific action with file path]",
      "- [ ] [Specific action with file path]",
      "- **Verify:** [How to confirm this phase works]",
      "",
      "## Risks & Mitigations",
      "- **Risk:** [What could go wrong] → **Mitigation:** [How to handle it]",
      "",
      "## Pre-mortem",
      "[Assume the implementation ships with a subtle bug or design flaw. What are the three most likely failure modes? Think about: concurrency (two code paths touching the same state), crash recovery (what state is lost on restart), unbounded growth (what grows without a cap), stale state (what's cached that could change), race conditions between async operations. For each: mitigate in the plan, or explain why it's acceptable.]",
      "",
      "## Test Strategy",
      "[What tests to write, what to verify, edge cases]",
      "",
      "## Success Criteria",
      "- [ ] [Measurable criterion]",
      "- [ ] [Measurable criterion]",
      "```",
    ].join("\n"),
  );
}

function buildTaskContext(ctx: PlanningPromptContext): string {
  const parts: string[] = [];

  // Task brief
  parts.push(buildTaskBrief(ctx.task));

  // Repo context
  parts.push(buildRepoOverview(ctx.repoContext));

  return parts.join("\n\n");
}
