import type { KnowledgeEntry } from "../../../schemas/session-memory.js";
import type { RepoContext } from "./context.js";
import {
  formatActionReference,
  formatKnowledge,
  formatOutputSchema,
  formatPriorPhaseOutput,
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
  intakeOutput: Record<string, unknown> | null;
  researchOutput: Record<string, unknown> | null;
  repoKnowledge: KnowledgeEntry[];
  userKnowledge: KnowledgeEntry[];
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Build the initial prompt for the planning phase.
 *
 * Pure function: context in, prompt string out.
 */
export function buildPlanningPrompt(ctx: PlanningPromptContext): string {
  const parts: string[] = [];

  // 1. Task Brief
  parts.push(buildTaskBrief(ctx));

  // 2. Intake Analysis
  parts.push(buildIntakeSection(ctx.intakeOutput));

  // 3. Research Findings
  parts.push(buildResearchSection(ctx.researchOutput));

  // 4. Repository Overview
  parts.push(buildRepoOverview(ctx.repoContext));

  // 5. Known Knowledge
  const knowledge = buildKnowledgeSection(ctx.repoKnowledge, ctx.userKnowledge);
  if (knowledge) {
    parts.push(knowledge);
  }

  // 6. Phase Instructions
  parts.push(buildPlanningInstructions());

  // 7. Planning Strategy (adapts to complexity)
  parts.push(buildPlanningStrategy(ctx.intakeOutput));

  // 8. Iteration Budget
  parts.push(
    section(
      "Iteration Budget",
      "You have up to 10 iterations. Use them to verify your plan against the actual code. Read files referenced in research findings to confirm your assumptions before finalizing the plan.",
    ),
  );

  // 9. Output Schema
  parts.push(section("Output Requirements", formatOutputSchema("planning")));

  // 10. Action Reference
  parts.push(
    section(
      "Actions",
      formatActionReference(["read_file", "search_files", "search_content", "done"]),
    ),
  );

  return parts.join("\n\n");
}

// ── Internal Helpers ─────────────────────────────────────────────────────────

function buildTaskBrief(ctx: PlanningPromptContext): string {
  const lines = [`Task: ${ctx.task.title}`];
  if (ctx.task.description) {
    lines.push("", ctx.task.description);
  }
  return section("Task", lines.join("\n"));
}

function buildIntakeSection(intakeOutput: Record<string, unknown> | null): string {
  if (!intakeOutput) {
    return section(
      "Intake Analysis",
      "No intake analysis available. Plan based on the task description and research findings.",
    );
  }
  return section("Intake Analysis", formatPriorPhaseOutput("intake_analysis", intakeOutput));
}

function buildResearchSection(researchOutput: Record<string, unknown> | null): string {
  if (!researchOutput) {
    return section(
      "Research Findings",
      "No research findings available. Create the plan based on the task description alone.",
    );
  }
  return section("Research Findings", formatPriorPhaseOutput("research", researchOutput));
}

function buildRepoOverview(repoContext: RepoContext | null): string {
  if (!repoContext) {
    return section(
      "Repository",
      "No repository context available. Use read actions to explore if needed.",
    );
  }

  const parts: string[] = [];

  if (repoContext.gitBranch) {
    parts.push(`Branch: ${repoContext.gitBranch}`);
  }

  if (repoContext.packageInfo) {
    parts.push("", repoContext.packageInfo);
  }

  // Include directory tree (helps reason about file placement).
  // Omit README — already seen in intake.
  if (repoContext.directoryTree) {
    parts.push("", "### File Structure", "", repoContext.directoryTree);
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

function buildPlanningInstructions(): string {
  return section(
    "Instructions",
    [
      "Create a concrete, actionable technical plan. A good plan makes execution almost mechanical.",
      "",
      "1. Define the approach — a clear description of what you will build and how. Think about the design before listing changes.",
      "",
      '2. List every file change with change_type (create, modify, or delete) and a specific description of what changes in each file. Be precise — "add pagination parameters to listUsers handler" not "modify users.ts".',
      "",
      "3. Identify risks and their mitigations. Consider:",
      "   - Breaking existing tests or functionality",
      "   - API contract changes that affect consumers",
      "   - Performance implications",
      "   - Edge cases and error handling gaps",
      "",
      "4. Define the test strategy — which test files to create or modify, what behaviors to test, what edge cases to cover.",
      "",
      "5. If the task is complex (multiple independent areas of change), consider decomposition into subtasks with clear boundaries and dependencies.",
      "",
      "6. Verify your plan by reading key files if you haven't already seen their content in research. The plan must be grounded in actual code, not assumptions.",
    ].join("\n"),
  );
}

function buildPlanningStrategy(intakeOutput: Record<string, unknown> | null): string {
  const complexity = (intakeOutput?.["complexity"] as string) ?? "moderate";

  if (complexity === "trivial" || complexity === "simple") {
    return section(
      "Planning Strategy",
      "This task has low complexity. A concise plan with 1-3 file changes should suffice. Don't over-plan simple tasks — state the approach, list the changes, and move on.",
    );
  }

  if (complexity === "complex" || complexity === "epic") {
    return section(
      "Planning Strategy",
      [
        "This task has high complexity. Use a structured approach:",
        "1. Break the approach into phases or stages.",
        "2. Consider which changes must come first (dependency ordering).",
        "3. Plan for incremental testing — each group of changes should be testable independently.",
        "4. Identify the highest-risk changes and plan those carefully.",
        "5. If the task has 3+ genuinely independent areas of change, use decomposition_plan to split into subtasks.",
        "   Each subtask runs the full engineering pipeline independently (research, plan, execute, review).",
        "   Only decompose when subtasks are truly separable — do NOT decompose when changes are tightly coupled.",
        "   Good subtask boundaries: separate modules, independent features, different domains.",
        "   Bad boundaries: UI and API that must match, schema and all consumers, tightly coupled refactors.",
      ].join("\n"),
    );
  }

  // Moderate (default)
  return section(
    "Planning Strategy",
    "Balance detail with pragmatism. Cover all file changes and risks without over-specifying. Focus on getting the approach right and listing concrete changes — a plan that makes execution almost mechanical.",
  );
}
