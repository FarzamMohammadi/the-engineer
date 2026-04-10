import type { RepoContext } from "./context.js";
import { buildRRPIROverview, buildTaskBrief, section } from "./format.js";
import { buildSkillsSection } from "./skills.js";

// ── Types ────────────────────────────────────────────────────────────────────

/** Summary of a completed child task for the integration phase. */
export interface ChildTaskSummary {
  child_id: string;
  title: string;
  branch: string;
  test_status: string;
  files_changed: string[];
}

/** Context needed to build the integration phase prompt. */
export interface IntegrationPromptContext {
  task: {
    title: string;
    description: string | null;
  };
  repoContext: RepoContext | null;
  thoughtsDir: string;
  childSummaries: ChildTaskSummary[];
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Build the prompt for the integration phase (CLI-native RRPIR).
 *
 * Pure function: context in, prompt string out.
 */
export function buildIntegrationPrompt(ctx: IntegrationPromptContext): string {
  const parts: string[] = [];

  // 1. How The Engineer Works
  parts.push(buildRRPIROverview("Integration", ctx.thoughtsDir));

  // 2. What Happened Before You
  parts.push(buildPriorPhasePointers(ctx.thoughtsDir, ctx.childSummaries));

  // 3. What YOU Need To Do
  parts.push(buildIntegrationInstructions());

  // 4. Where To Put Your Work
  parts.push(buildOutputInstructions(ctx.thoughtsDir));

  // 5. The Task Context
  parts.push(buildTaskContext(ctx));

  // 6. Skills
  const skills = buildSkillsSection("integration");
  if (skills) {
    parts.push(skills);
  }

  return parts.join("\n\n");
}

// ── Internal Helpers ─────────────────────────────────────────────────────────

function buildPriorPhasePointers(thoughtsDir: string, children: ChildTaskSummary[]): string {
  const lines = [
    "This is a parent task. Child tasks completed their own RRPIR pipelines on separate branches.",
    "",
    `Parent thoughts directory: \`${thoughtsDir}/\``,
    `- \`${thoughtsDir}/requirements/requirements.md\` — original requirements`,
    `- \`${thoughtsDir}/planning/plan.md\` — the decomposition plan`,
    "",
  ];

  if (children.length > 0) {
    lines.push(`${String(children.length)} child task(s) to integrate:`);
    lines.push("");

    for (const child of children) {
      lines.push(`### ${child.title} (\`${child.child_id}\`)`);
      lines.push(`- Branch: \`${child.branch}\``);
      lines.push(`- Test status: ${child.test_status}`);
      if (child.files_changed.length > 0) {
        lines.push("- Files changed:");
        for (const f of child.files_changed) {
          lines.push(`  - \`${f}\``);
        }
      }
      lines.push("");
    }
  } else {
    lines.push("No child tasks found. Verify the parent task's own changes.");
  }

  return section("What Happened Before You", lines.join("\n"));
}

function buildIntegrationInstructions(): string {
  return section(
    "What YOU Need To Do",
    [
      "Merge all child branches and verify the combined result. Nothing ships until integration is verified.",
      "",
      "1. For each child task, merge its branch into the parent branch:",
      "   - `git merge <child-branch>` for each child",
      "   - Resolve any merge conflicts carefully",
      "",
      "2. After merging, check for integration issues across children's changes:",
      "   - Overlapping file modifications that merged cleanly but are logically conflicting",
      "   - Incompatible API changes between children",
      "   - Missing shared dependencies or type updates",
      "   - Broken cross-references between modules",
      "",
      "3. Run the full test suite to verify no regressions across the entire codebase.",
      "",
      "4. If tests fail, diagnose and fix the issues. Integration bugs are usually at the seams between child tasks.",
      "",
      "5. Run any build/lint/typecheck commands to verify the codebase is in a clean state.",
      "",
      "6. Commit the merge result with a clear message documenting which children were integrated.",
    ].join("\n"),
  );
}

function buildOutputInstructions(thoughtsDir: string): string {
  return section(
    "Where To Put Your Work",
    [
      "The merged branch is your primary deliverable. Integration results go in the parent thoughts directory.",
      "",
      `Update session-result.json at \`${thoughtsDir}/integration/session-result.json\` with:`,
      "",
      "```json",
      "{",
      '  "status": "ready" or "error",',
      '  "next_phase": "demo_prep" (if integration succeeded) or "execution" (if fundamental issues need rework),',
      '  "summary": "<one-line integration result>"',
      "}",
      "```",
      "",
      'Set next_phase to "demo_prep" when all children are merged, tests pass, and the codebase is clean.',
      'Set next_phase to "execution" only if integration reveals fundamental issues that need rework.',
    ].join("\n"),
  );
}

function buildTaskContext(ctx: IntegrationPromptContext): string {
  const parts: string[] = [];

  // Task brief
  parts.push(buildTaskBrief(ctx.task));

  // Repository context (branch only)
  if (ctx.repoContext?.gitBranch) {
    parts.push(section("Repository", `Branch: ${ctx.repoContext.gitBranch}`));
  }

  return section("The Task Context", parts.join("\n\n"));
}
