import type { KnowledgeEntry } from "../../../schemas/session-memory.js";
import type { RepoContext } from "./context.js";
import {
  buildKnowledgeSection,
  buildRRPIROverview,
  buildRepoOverview,
  buildTaskBrief,
  section,
} from "./format.js";

// ── Types ────────────────────────────────────────────────────────────────────

/** Context needed to build the planning phase prompt. */
export interface PlanningPromptContext {
  task: {
    title: string;
    description: string | null;
  };
  repoContext: RepoContext | null;
  repoKnowledge: KnowledgeEntry[];
  userKnowledge: KnowledgeEntry[];
  thoughtsDir: string;
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
  parts.push(buildPriorPhasesSection(ctx.thoughtsDir));

  // 3. What YOU Need To Do
  parts.push(buildInstructions(ctx.thoughtsDir));

  // 4. Where To Put Your Work
  parts.push(buildOutputSection(ctx.thoughtsDir));

  // 5. The Task Context
  parts.push(buildTaskContext(ctx));

  return parts.join("\n\n");
}

// ── Internal Helpers ─────────────────────────────────────────────────────────

function buildPriorPhasesSection(thoughtsDir: string): string {
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
      "1. **Read requirements.md and research.md first.** Understand the full context before planning.",
      "",
      "2. **Create a precise implementation plan.** Do NOT write implementation code. Your plan should make execution almost mechanical — every step concrete, every file path specified, every risk considered.",
      "",
      '3. **If you need more information to plan properly,** set `next_phase` to `"requirements_gathering"` in session-result.json. Specify what information you need and why in your summary.',
      "",
      `4. **Write the plan** to \`${thoughtsDir}/planning/plan.md\` using the template below. Use checkbox format so Implementation can track progress.`,
      "",
      "5. **If decomposition is needed** (3+ genuinely independent areas of change), include a `## Decomposition` section in plan.md. Each subtask runs the full RRPIR pipeline independently. Only decompose when subtasks are truly separable — do NOT decompose tightly coupled changes. Each subtask gets its own branch, worktree, and independent RRPIR pipeline. Plan accordingly — subtasks should be self-contained.",
      "",
      "6. **Verify your plan** by reading key files if research didn't cover them. The plan must be grounded in actual code, not assumptions.",
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
      "## Approach",
      "[High-level description of what we'll build and how]",
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

  // Knowledge
  const knowledge = buildKnowledgeSection(ctx.repoKnowledge, ctx.userKnowledge);
  if (knowledge) {
    parts.push(knowledge);
  }

  return parts.join("\n\n");
}
