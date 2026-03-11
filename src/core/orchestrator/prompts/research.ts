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

/** Context needed to build the research phase prompt. */
export interface ResearchPromptContext {
  task: {
    title: string;
    description: string | null;
  };
  repoContext: RepoContext | null;
  intakeOutput: Record<string, unknown> | null;
  repoKnowledge: KnowledgeEntry[];
  userKnowledge: KnowledgeEntry[];
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Build the initial prompt for the research phase.
 *
 * Pure function: context in, prompt string out.
 */
export function buildResearchPrompt(ctx: ResearchPromptContext): string {
  const parts: string[] = [];

  // 1. Task Brief
  parts.push(buildTaskBrief(ctx));

  // 2. Intake Results
  parts.push(buildIntakeResultsSection(ctx.intakeOutput));

  // 3. Repository Overview
  parts.push(buildRepoOverview(ctx.repoContext));

  // 4. Known Knowledge
  const knowledge = buildKnowledgeSection(ctx.repoKnowledge, ctx.userKnowledge);
  if (knowledge) {
    parts.push(knowledge);
  }

  // 5. Phase Instructions
  parts.push(buildResearchInstructions());

  // 6. Research Strategy (adapts to complexity)
  parts.push(buildResearchStrategy(ctx.intakeOutput));

  // 7. Iteration Budget
  parts.push(
    section(
      "Iteration Budget",
      "You have up to 15 iterations. Be systematic and efficient.\n\nDon't re-read files you've already seen. Use search_content to find patterns across the codebase. Use search_files to locate files by name. Use run_command for git operations (e.g., git log for a specific file's history).",
    ),
  );

  // 8. Output Schema
  parts.push(section("Output Requirements", formatOutputSchema("research")));

  // 9. Action Reference
  parts.push(
    section(
      "Actions",
      formatActionReference(["read_file", "search_files", "search_content", "run_command", "done"]),
    ),
  );

  return parts.join("\n\n");
}

// ── Internal Helpers ─────────────────────────────────────────────────────────

function buildTaskBrief(ctx: ResearchPromptContext): string {
  const lines = [`Task: ${ctx.task.title}`];
  if (ctx.task.description) {
    lines.push("", ctx.task.description);
  }
  return section("Task", lines.join("\n"));
}

function buildIntakeResultsSection(intakeOutput: Record<string, unknown> | null): string {
  if (!intakeOutput) {
    return section(
      "Intake Analysis",
      "No intake analysis available. Proceed with research based on the task description.",
    );
  }
  return section("Intake Analysis", formatPriorPhaseOutput("intake_analysis", intakeOutput));
}

function buildRepoOverview(repoContext: RepoContext | null): string {
  if (!repoContext) {
    return section(
      "Repository",
      "No repository context available. Use search actions to explore the codebase.",
    );
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

  // README omitted in research — the LLM already saw it in intake.
  // Recent commits included for context on recent changes.
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

function buildResearchInstructions(): string {
  return section(
    "Instructions",
    [
      "Research the codebase to build a complete picture of what this task involves.",
      "",
      "1. Start from the ambiguities identified in intake. If requirements are unclear, note what needs human clarification — but don't block on it. Gather what you can.",
      "",
      "2. Map the relevant files: find every file that will need to change, plus files that provide critical context (interfaces, types, tests, configs).",
      "",
      "3. Identify conventions by looking at existing similar code:",
      "   - Coding style and naming patterns",
      "   - Test patterns (test file location, naming, assertion style)",
      "   - Directory structure conventions",
      "   - Import/export patterns",
      "   - Error handling patterns",
      "",
      "4. Identify dependencies:",
      "   - External packages involved in the affected area",
      "   - Internal modules that interact with the target code",
      "   - Shared types, schemas, or utilities that must be respected",
      "",
      "5. Look at existing tests for the relevant modules. Understand the testing approach so new tests follow the same patterns.",
      "",
      "6. Pay attention to configuration, build setup, and any CI/CD patterns that might affect your changes.",
    ].join("\n"),
  );
}

function buildResearchStrategy(intakeOutput: Record<string, unknown> | null): string {
  const complexity = (intakeOutput?.["complexity"] as string) ?? "moderate";

  if (complexity === "trivial" || complexity === "simple") {
    return section(
      "Research Strategy",
      "This task has low complexity. Focus on the single file or area involved. 2-3 file reads should suffice. Identify the file to change, its test file, and any types/interfaces it uses. Don't over-research simple tasks.",
    );
  }

  if (complexity === "complex" || complexity === "epic") {
    return section(
      "Research Strategy",
      [
        "This task has high complexity. Use a systematic approach:",
        "1. Start with the directory structure to orient yourself.",
        "2. Read the key files in the affected area.",
        "3. Trace dependencies — what does the target code import? What imports it?",
        "4. Read test files for the affected modules.",
        "5. Search for related patterns across the codebase (search_content).",
        "6. Check for related configuration or build setup.",
      ].join("\n"),
    );
  }

  // Moderate (default)
  return section(
    "Research Strategy",
    "Read the target files, their test files, and their imports. Search for related patterns if the task touches shared code. Balance thoroughness with efficiency — you have 15 iterations, use them to build a complete picture without redundant reads.",
  );
}
