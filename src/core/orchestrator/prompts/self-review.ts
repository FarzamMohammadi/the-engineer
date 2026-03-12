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

/** Context needed to build the self-review phase prompt. */
export interface SelfReviewPromptContext {
  task: {
    title: string;
    description: string | null;
  };
  repoContext: RepoContext | null;
  intakeOutput: Record<string, unknown> | null;
  planningOutput: Record<string, unknown> | null;
  executionOutput: Record<string, unknown> | null;
  /** Self-review findings from a prior loopback. Null on first pass. */
  selfReviewFindings: Record<string, unknown> | null;
  /** How many times we've looped back. 0 on first pass. */
  loopbackCount: number;
  repoKnowledge: KnowledgeEntry[];
  userKnowledge: KnowledgeEntry[];
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Build the initial prompt for the self-review phase.
 *
 * Pure function: context in, prompt string out.
 */
export function buildSelfReviewPrompt(ctx: SelfReviewPromptContext): string {
  const parts: string[] = [];

  // 1. Task Brief
  parts.push(buildTaskBrief(ctx));

  // 2. Original Plan (compare planned vs done)
  parts.push(buildPlanSection(ctx.planningOutput));

  // 3. Execution Summary
  parts.push(buildExecutionSection(ctx.executionOutput));

  // 4. Prior Review Findings (loopback only)
  const priorFindings = buildPriorFindings(ctx.selfReviewFindings, ctx.loopbackCount);
  if (priorFindings) {
    parts.push(priorFindings);
  }

  // 5. Repository (branch only)
  const repoSection = buildRepoOverview(ctx.repoContext);
  if (repoSection) {
    parts.push(repoSection);
  }

  // 6. Known Knowledge
  const knowledge = buildKnowledgeSection(ctx.repoKnowledge, ctx.userKnowledge);
  if (knowledge) {
    parts.push(knowledge);
  }

  // 7. Phase Instructions
  parts.push(buildSelfReviewInstructions());

  // 8. Review Strategy (complexity-adaptive + loopback-aware)
  parts.push(buildReviewStrategy(ctx.intakeOutput, ctx.loopbackCount));

  // 9. Iteration Budget
  parts.push(
    section(
      "Iteration Budget",
      "You have up to 15 iterations. Use them to read changed files, run tests, and fix any issues you find. Thoroughness over speed.",
    ),
  );

  // 10. Output Schema + Action Reference
  parts.push(section("Output Requirements", formatOutputSchema("self_review")));
  parts.push(
    section(
      "Actions",
      formatActionReference(["read_file", "search_files", "search_content", "run_command", "done"]),
    ),
  );

  return parts.join("\n\n");
}

// ── Internal Helpers ─────────────────────────────────────────────────────────

function buildTaskBrief(ctx: SelfReviewPromptContext): string {
  const lines = [`Task: ${ctx.task.title}`];
  if (ctx.task.description) {
    lines.push("", ctx.task.description);
  }
  return section("Task", lines.join("\n"));
}

function buildPlanSection(planningOutput: Record<string, unknown> | null): string {
  if (!planningOutput) {
    return section(
      "Original Plan",
      "No plan available. Review the changes based on general engineering quality standards.",
    );
  }
  return section("Original Plan", formatPriorPhaseOutput("planning", planningOutput));
}

function buildExecutionSection(executionOutput: Record<string, unknown> | null): string {
  if (!executionOutput) {
    return section(
      "Execution Summary",
      "No execution summary available. Read the changed files directly to understand what was done.",
    );
  }
  return section("Execution Summary", formatPriorPhaseOutput("execution", executionOutput));
}

function buildPriorFindings(
  selfReviewFindings: Record<string, unknown> | null,
  loopbackCount: number,
): string | null {
  if (!selfReviewFindings || loopbackCount === 0) {
    return null;
  }
  return section(
    `Previous Review Findings (Loopback #${String(loopbackCount)})`,
    [
      "The following issues were identified in a previous review. Verify they have been addressed:",
      "",
      formatPriorPhaseOutput("self_review", selfReviewFindings),
    ].join("\n"),
  );
}

function buildRepoOverview(repoContext: RepoContext | null): string | null {
  if (!repoContext?.gitBranch) {
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

function buildSelfReviewInstructions(): string {
  return section(
    "Instructions",
    [
      "Review the code changes with the critical eye of a senior engineer. Quality is non-negotiable.",
      "",
      "1. Read the changed files listed in the execution summary. Understand what was done and compare against the original plan.",
      "",
      "2. Run the test suite to verify everything passes. If tests fail, that's a finding.",
      "",
      "3. Check each changed file for:",
      "   - Logic errors: incorrect conditions, off-by-one, missing edge cases",
      "   - Style issues: naming, formatting, code organization",
      "   - Security vulnerabilities: injection, exposed secrets, unsafe operations",
      "   - Performance concerns: unnecessary loops, missing indexes, N+1 queries",
      "   - Maintainability: unclear code, missing types, overly complex logic",
      "",
      "4. Fix issues you find using run_command. Document what you fixed in your findings (set fixed: true).",
      "",
      "5. Assess overall quality:",
      '   - "ship_it": Code is clean, tested, and ready for review',
      '   - "needs_work": Fixable issues remain that need another execution pass',
      '   - "fundamental_issues": The approach itself is flawed and needs rethinking',
    ].join("\n"),
  );
}

function buildReviewStrategy(
  intakeOutput: Record<string, unknown> | null,
  loopbackCount: number,
): string {
  const complexity = (intakeOutput?.["complexity"] as string) ?? "moderate";

  let strategy: string;

  if (complexity === "trivial" || complexity === "simple") {
    strategy =
      "This is a simple change. Quick sanity check — verify tests pass, check for obvious issues, don't over-review.";
  } else if (complexity === "complex" || complexity === "epic") {
    strategy = [
      "This is a complex change. Thorough review required:",
      "1. Check cross-cutting concerns (does the change affect other modules?).",
      "2. Verify integration points between components.",
      "3. Run the full test suite, not just the new tests.",
      "4. Look for architectural issues, not just line-level problems.",
    ].join("\n");
  } else {
    strategy =
      "Standard review. Read each changed file carefully, run tests, check for common issues. Balance thoroughness with pragmatism.";
  }

  if (loopbackCount > 0) {
    strategy += `\n\nThis is loopback #${String(loopbackCount)}. Focus on the specific issues identified in the previous review. Verify they have been fixed before assessing overall quality.`;
  }

  return section("Review Strategy", strategy);
}
