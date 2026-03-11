import type { KnowledgeEntry } from "../../../schemas/session-memory.js";
import type { RepoContext } from "./context.js";
import { formatActionReference, formatKnowledge, formatOutputSchema, section } from "./format.js";

// ── Types ────────────────────────────────────────────────────────────────────

/** Context needed to build the intake analysis prompt. */
export interface IntakePromptContext {
  task: {
    title: string;
    description: string | null;
    external_ref?: { type: string; repo: string; number: number } | null;
  };
  repoContext: RepoContext | null;
  repoKnowledge: KnowledgeEntry[];
  userKnowledge: KnowledgeEntry[];
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Build the initial prompt for the intake analysis phase.
 *
 * Pure function: context in, prompt string out.
 */
export function buildIntakePrompt(ctx: IntakePromptContext): string {
  const parts: string[] = [];

  // 1. Task Brief
  parts.push(buildTaskBrief(ctx));

  // 2. Repository Overview
  parts.push(buildRepoOverview(ctx.repoContext));

  // 3. Known Knowledge
  const knowledge = buildKnowledgeSection(ctx.repoKnowledge, ctx.userKnowledge);
  if (knowledge) {
    parts.push(knowledge);
  }

  // 4. Phase Instructions
  parts.push(buildIntakeInstructions());

  // 5. Iteration Budget
  parts.push(
    section(
      "Iteration Budget",
      "You have up to 5 iterations. Use them wisely.\n\nFor trivial tasks, you likely have enough context from the repository overview above — assess immediately and respond with done. For complex tasks, read key files to understand the scope before making your assessment.",
    ),
  );

  // 6. Output Schema
  parts.push(section("Output Requirements", formatOutputSchema("intake_analysis")));

  // 7. Action Reference
  parts.push(
    section(
      "Actions",
      formatActionReference(["read_file", "search_files", "search_content", "done"]),
    ),
  );

  return parts.join("\n\n");
}

// ── Internal Helpers ─────────────────────────────────────────────────────────

function buildTaskBrief(ctx: IntakePromptContext): string {
  const lines = [`Task: ${ctx.task.title}`];

  if (ctx.task.description) {
    lines.push("", ctx.task.description);
  }

  if (ctx.task.external_ref) {
    const ref = ctx.task.external_ref;
    lines.push("", `Source: ${ref.type} ${ref.repo}#${String(ref.number)}`);
  }

  return section("Task", lines.join("\n"));
}

function buildRepoOverview(repoContext: RepoContext | null): string {
  if (!repoContext) {
    return section(
      "Repository",
      "No repository context available. Assess complexity from the task description alone.",
    );
  }

  const parts: string[] = [];

  if (repoContext.gitBranch) {
    parts.push(`Branch: ${repoContext.gitBranch}`);
  }

  if (repoContext.packageInfo) {
    parts.push("", repoContext.packageInfo);
  }

  if (repoContext.readme) {
    parts.push("", "### README (excerpt)", "", repoContext.readme);
  }

  if (repoContext.directoryTree) {
    parts.push("", "### File Structure", "", repoContext.directoryTree);
  }

  if (repoContext.recentCommits) {
    parts.push("", "### Recent Commits", "", repoContext.recentCommits);
  }

  return section("Repository", parts.join("\n"));
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

  return section("Known Context", parts.join("\n"));
}

function buildIntakeInstructions(): string {
  return section(
    "Instructions",
    [
      "Analyze this task with the eye of a senior engineer taking on a new assignment.",
      "",
      "1. Read the task requirements carefully. Identify any ambiguities — requirements that are unclear, missing acceptance criteria, unstated assumptions, or conflicting constraints.",
      "",
      "2. If repository context is available, explore the relevant area to understand the scope of changes needed. Read key files if the task references specific components.",
      "",
      "3. Assess complexity by considering:",
      "   - Number of files likely to change",
      "   - Whether new tests are needed",
      "   - Architectural impact (new components, modified interfaces, cross-cutting concerns)",
      "   - New dependencies or integrations",
      "   - Risk of breaking existing functionality",
      "",
      "4. Determine if this is a trivial task (fast path). A task is trivial ONLY if: it affects a single file, has no ambiguity, needs no new dependencies, has no architectural impact, and needs no new tests.",
      "",
      "5. Determine if decomposition is needed. A task should be decomposed when it involves multiple independent components, has clearly separable concerns, or would benefit from parallel execution.",
    ].join("\n"),
  );
}
