import type { KnowledgeEntry } from "../../../schemas/session-memory.js";
import type { RepoContext } from "./context.js";
import { buildTaskBrief, formatKnowledge, section } from "./format.js";

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
  parts.push(buildRrpirOverview());

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

function buildRrpirOverview(): string {
  return section(
    "How The Engineer Works",
    [
      "You are the Planning session in a multi-phase pipeline called RRPIR:",
      "**Requirements Gathering → Research → Planning → Implementation → Review**",
      "",
      "Each phase is a separate CLI session with a fresh context window. File-based handoffs connect the phases:",
      "- Each phase reads previous phases' `.md` deliverables for context.",
      "- Each phase writes its own `.md` deliverable and updates a `session-result.json` for routing.",
      "- You have full CLI capabilities: read files, write files, search code, run commands. Use them freely.",
      "",
      "You are Planning. Requirements have been gathered. Research has been done. Your job is to create a precise, actionable implementation plan that makes execution almost mechanical.",
    ].join("\n"),
  );
}

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
      "5. **If decomposition is needed** (3+ genuinely independent areas of change), include a `## Decomposition` section in plan.md. Each subtask runs the full RRPIR pipeline independently. Only decompose when subtasks are truly separable — do NOT decompose tightly coupled changes.",
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
  const repoSection = buildRepoOverview(ctx.repoContext);
  if (repoSection) {
    parts.push(repoSection);
  }

  // Knowledge
  const knowledge = buildKnowledgeSection(ctx.repoKnowledge, ctx.userKnowledge);
  if (knowledge) {
    parts.push(knowledge);
  }

  return section("The Task Context", parts.join("\n\n"));
}

function buildRepoOverview(repoContext: RepoContext | null): string | null {
  if (!repoContext) {
    return null;
  }

  const parts: string[] = [];

  if (repoContext.gitBranch) {
    parts.push(`Branch: ${repoContext.gitBranch}`);
  }

  if (repoContext.packageInfo) {
    parts.push("", repoContext.packageInfo);
  }

  if (repoContext.directoryTree) {
    parts.push("", "### File Structure", "", repoContext.directoryTree);
  }

  return parts.length > 0 ? `### Repository\n\n${parts.join("\n")}` : null;
}

function buildKnowledgeSection(
  repoKnowledge: KnowledgeEntry[],
  userKnowledge: KnowledgeEntry[],
): string | null {
  const repoFormatted = formatKnowledge(repoKnowledge);
  const userFormatted = formatKnowledge(userKnowledge);

  if (!(repoFormatted || userFormatted)) {
    return null;
  }

  const parts: string[] = [];
  if (repoFormatted) {
    parts.push("Repository knowledge:", repoFormatted);
  }
  if (userFormatted) {
    if (parts.length > 0) {
      parts.push("");
    }
    parts.push("User knowledge:", userFormatted);
  }

  return `### Known Context\n\n${parts.join("\n")}`;
}
