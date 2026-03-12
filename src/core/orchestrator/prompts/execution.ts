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

/** Context needed to build the execution phase prompt. */
export interface ExecutionPromptContext {
  task: {
    title: string;
    description: string | null;
  };
  repoContext: RepoContext | null;
  intakeOutput: Record<string, unknown> | null;
  researchOutput: Record<string, unknown> | null;
  planningOutput: Record<string, unknown> | null;
  repoKnowledge: KnowledgeEntry[];
  userKnowledge: KnowledgeEntry[];
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Build the initial prompt for the execution phase.
 *
 * Pure function: context in, prompt string out.
 */
export function buildExecutionPrompt(ctx: ExecutionPromptContext): string {
  const parts: string[] = [];

  // 1. Task Brief
  parts.push(buildTaskBrief(ctx));

  // 2. Plan (primary guide)
  parts.push(buildPlanSection(ctx.planningOutput));

  // 3. Research Context (conventions, patterns)
  parts.push(buildResearchSection(ctx.researchOutput));

  // 4. Repository (minimal — LLM has the worktree)
  const repoSection = buildRepoOverview(ctx.repoContext);
  if (repoSection) {
    parts.push(repoSection);
  }

  // 5. Known Knowledge
  const knowledge = buildKnowledgeSection(ctx.repoKnowledge, ctx.userKnowledge);
  if (knowledge) {
    parts.push(knowledge);
  }

  // 6. Phase Instructions
  parts.push(buildExecutionInstructions());

  // 7. Execution Strategy (adapts to complexity)
  parts.push(buildExecutionStrategy(ctx.intakeOutput));

  // 8. Iteration Budget
  parts.push(
    section(
      "Iteration Budget",
      "You have up to 25 iterations. This is your execution budget — use it to write code, run tests, and fix issues. Prioritize getting tests passing over writing more code. Quality over quantity.",
    ),
  );

  // 9. Output Schema
  parts.push(section("Output Requirements", formatOutputSchema("execution")));

  // 10. Action Reference
  parts.push(
    section(
      "Actions",
      formatActionReference([
        "read_file",
        "write_file",
        "edit_file",
        "search_files",
        "search_content",
        "run_command",
        "done",
      ]),
    ),
  );

  return parts.join("\n\n");
}

// ── Internal Helpers ─────────────────────────────────────────────────────────

function buildTaskBrief(ctx: ExecutionPromptContext): string {
  const lines = [`Task: ${ctx.task.title}`];
  if (ctx.task.description) {
    lines.push("", ctx.task.description);
  }
  return section("Task", lines.join("\n"));
}

function buildPlanSection(planningOutput: Record<string, unknown> | null): string {
  if (!planningOutput) {
    return section(
      "Plan",
      "No plan available. Implement changes based on the task description, following existing codebase conventions.",
    );
  }
  return section("Plan", formatPriorPhaseOutput("planning", planningOutput));
}

function buildResearchSection(researchOutput: Record<string, unknown> | null): string {
  if (!researchOutput) {
    return section(
      "Research Context",
      "No research context available. Follow existing patterns you find in the codebase.",
    );
  }
  return section("Research Context", formatPriorPhaseOutput("research", researchOutput));
}

function buildRepoOverview(repoContext: RepoContext | null): string | null {
  if (!repoContext) {
    return null;
  }

  // Minimal: branch only. Execution has the worktree — no need to repeat
  // README, directory tree, or commits. The LLM can explore freely.
  if (!repoContext.gitBranch) {
    return null;
  }

  return section("Repository", `Branch: ${repoContext.gitBranch}`);
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

function buildExecutionInstructions(): string {
  return section(
    "Instructions",
    [
      "Implement the plan. Write clean, tested code that follows the conventions identified in research.",
      "",
      "1. Start with foundation changes — types, interfaces, schemas, or any code that other changes depend on.",
      "",
      "2. Implement the core logic. Follow the plan's file_changes list, but adapt if you discover something the plan didn't anticipate. Use edit_file for surgical changes to existing files, write_file for new files.",
      "",
      "3. Write tests alongside the code. Every behavior change needs a test. Follow the test patterns from research — same assertion style, same file naming, same describe/it structure.",
      "",
      "4. Run tests after each meaningful change (run_command). Fix failures immediately before moving on. The test-fix loop is what makes code actually work:",
      "   - Make a change",
      "   - Run the relevant tests",
      "   - If tests fail, read the error, fix the issue, run again",
      "   - Only move to the next change when tests pass",
      "",
      "5. When all changes are implemented and tests pass, run the full relevant test suite to check for regressions.",
      "",
      "6. Stage and commit at meaningful checkpoints. Each commit should represent a logical unit of work with passing tests.",
    ].join("\n"),
  );
}

function buildExecutionStrategy(intakeOutput: Record<string, unknown> | null): string {
  const complexity = (intakeOutput?.["complexity"] as string) ?? "moderate";

  if (complexity === "trivial" || complexity === "simple") {
    return section(
      "Execution Strategy",
      "This is a simple change. Implement it directly, write the test, run it, done. Don't overthink it.",
    );
  }

  if (complexity === "complex" || complexity === "epic") {
    return section(
      "Execution Strategy",
      [
        "This is a complex implementation. Work through the plan's file_changes in dependency order:",
        "1. Foundation first (types, schemas, interfaces).",
        "2. Core logic next (the main implementation).",
        "3. Tests after each logical group.",
        "4. Integration and regression tests last.",
        "If you hit an unexpected obstacle, adapt the approach but stay aligned with the plan's intent.",
      ].join("\n"),
    );
  }

  // Moderate (default)
  return section(
    "Execution Strategy",
    "Follow the plan methodically. Implement, test, fix, commit. If a test keeps failing, re-read the relevant code to understand what you're missing before trying more fixes.",
  );
}
