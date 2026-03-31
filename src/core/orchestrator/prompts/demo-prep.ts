import type { ReviewPhaseName } from "../../../schemas/config.js";
import type { KnowledgeEntry } from "../../../schemas/session-memory.js";
import type { RepoContext } from "./context.js";
import { buildKnowledgeSection, buildRRPIROverview, buildTaskBrief, section } from "./format.js";

// ── Types ────────────────────────────────────────────────────────────────────

/** Context needed to build the demo-prep phase prompt. */
export interface DemoPrepPromptContext {
  task: {
    title: string;
    description: string | null;
    external_ref?: { type: string; repo: string; id: string; url?: string | undefined } | null;
  };
  repoContext: RepoContext | null;
  repoKnowledge: KnowledgeEntry[];
  userKnowledge: KnowledgeEntry[];
  thoughtsDir: string;
  /** Which review phases were run (their .md files exist in review/). */
  reviewPhases: ReviewPhaseName[];
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Build the prompt for the demo/PR phase (CLI-native RRPIR).
 *
 * Pure function: context in, prompt string out.
 */
export function buildDemoPrepPrompt(ctx: DemoPrepPromptContext): string {
  const parts: string[] = [];

  // 1. How The Engineer Works
  parts.push(buildRRPIROverview("Demo/PR", ctx.thoughtsDir));

  // 2. What Happened Before You
  parts.push(buildPriorPhasePointers(ctx.thoughtsDir, ctx.reviewPhases));

  // 3. What YOU Need To Do
  parts.push(buildDemoPrepInstructions());

  // 4. Where To Put Your Work
  parts.push(buildOutputInstructions(ctx.thoughtsDir));

  // 5. The Task Context
  parts.push(buildTaskContext(ctx));

  return parts.join("\n\n");
}

// ── Internal Helpers ─────────────────────────────────────────────────────────

function buildPriorPhasePointers(thoughtsDir: string, reviewPhases: ReviewPhaseName[]): string {
  const reviewFiles = reviewPhases
    .map((name) => `- \`${thoughtsDir}/review/${name}.md\``)
    .join("\n");

  return section(
    "What Happened Before You",
    [
      "All work is complete. Read the thoughts/ directory for the full story:",
      "",
      `- \`${thoughtsDir}/requirements/requirements.md\` — original requirements and gathered context`,
      `- \`${thoughtsDir}/research/research.md\` — codebase analysis and findings`,
      `- \`${thoughtsDir}/planning/plan.md\` — the implementation plan`,
      `- \`${thoughtsDir}/implementation/session-result.json\` — implementation summary`,
      "- Review findings:",
      reviewFiles,
      `- \`${thoughtsDir}/review/refinements.md\` — refinement summary — what was caught and fixed`,
      "",
      "Also run `git diff` and `git log` to see all code changes and commits.",
    ].join("\n"),
  );
}

function buildDemoPrepInstructions(): string {
  return section(
    "What YOU Need To Do",
    [
      "Write a PR description that tells the full story. Communication quality is half an engineer's value.",
      "",
      "1. Read the thoughts/ files to understand the full story of what was built and why.",
      "",
      "2. Read the review findings and refinements to understand what was caught and fixed.",
      "",
      "3. Write a `pr-description.md` with a clear narrative:",
      "   - What changed and why (reference the task requirements)",
      "   - Technical approach taken (reference the plan)",
      "   - How to test the changes (concrete steps a reviewer can follow)",
      "   - Any breaking changes, migration steps, or deployment notes",
      "   - Key decisions made during implementation",
      "",
      "4. The thoughts/ directory will be included in the PR for reviewer context.",
      "",
      "IMPORTANT: Do NOT commit, push, or create PRs. Do NOT start dev servers or long-running commands.",
      "The orchestrator handles all git operations and PR creation. Your job is to write the PR narrative.",
    ].join("\n"),
  );
}

function buildOutputInstructions(thoughtsDir: string): string {
  return section(
    "Where To Put Your Work",
    [
      `Write the PR description to: \`${thoughtsDir}/demo-prep/pr-description.md\``,
      "",
      `Update session-result.json at \`${thoughtsDir}/demo-prep/session-result.json\` with:`,
      "",
      "```json",
      "{",
      '  "status": "ready",',
      '  "next_phase": "integration" (if this is a decomposed child task) or "demo_prep" (terminal — pipeline complete),',
      '  "summary": "<PR #X created: title>"',
      "}",
      "```",
      "",
      'For most tasks, next_phase is "demo_prep" (terminal). Only set "integration" if this task has a parent that needs to merge child branches.',
    ].join("\n"),
  );
}

function buildTaskContext(ctx: DemoPrepPromptContext): string {
  const parts: string[] = [];

  // Task brief
  parts.push(buildTaskBrief(ctx.task));

  // Repository context
  if (ctx.repoContext) {
    const repoLines: string[] = [];
    if (ctx.repoContext.gitBranch) {
      repoLines.push(`Branch: ${ctx.repoContext.gitBranch}`);
    }
    if (ctx.repoContext.packageInfo) {
      repoLines.push("", ctx.repoContext.packageInfo);
    }
    if (repoLines.length > 0) {
      parts.push(section("Repository", repoLines.join("\n")));
    }
  }

  // Knowledge
  const knowledge = buildKnowledgeSection(ctx.repoKnowledge, ctx.userKnowledge);
  if (knowledge) {
    parts.push(knowledge);
  }

  return section("The Task Context", parts.join("\n\n"));
}
