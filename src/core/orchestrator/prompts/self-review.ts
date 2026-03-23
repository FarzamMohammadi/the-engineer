import type { KnowledgeEntry } from "../../../schemas/session-memory.js";
import type { RepoContext } from "./context.js";
import { buildTaskBrief, formatKnowledge, section } from "./format.js";

// ── Types ────────────────────────────────────────────────────────────────────

/** Context needed to build the self-review phase prompt. */
export interface SelfReviewPromptContext {
  task: {
    title: string;
    description: string | null;
  };
  repoContext: RepoContext | null;
  repoKnowledge: KnowledgeEntry[];
  userKnowledge: KnowledgeEntry[];
  thoughtsDir: string;
  /** How many times we've looped back. 0 on first pass. */
  loopbackCount: number;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Build the prompt for the review phase (CLI-native RRPIR).
 *
 * Pure function: context in, prompt string out.
 */
export function buildSelfReviewPrompt(ctx: SelfReviewPromptContext): string {
  const parts: string[] = [];

  // 1. How The Engineer Works
  parts.push(buildRRPIROverview());

  // 2. What Happened Before You
  parts.push(buildPriorPhasePointers(ctx.thoughtsDir, ctx.loopbackCount));

  // 3. What YOU Need To Do
  parts.push(buildReviewInstructions(ctx.loopbackCount));

  // 4. Where To Put Your Work
  parts.push(buildOutputInstructions(ctx.thoughtsDir));

  // 5. The Task Context
  parts.push(buildTaskContext(ctx));

  return parts.join("\n\n");
}

// ── Internal Helpers ─────────────────────────────────────────────────────────

function buildRRPIROverview(): string {
  return section(
    "How The Engineer Works",
    [
      "You are one session in a multi-phase pipeline called RRPIR (Requirements Gathering -> Research -> Planning -> Implementation -> Review).",
      "Each phase is a separate CLI session with a fresh context window. File-based handoffs connect the phases.",
      "",
      "- Each phase has a directory in thoughts/ containing deliverables (.md files) and a session-result.json file.",
      "- You read previous phases' files for context. You write your phase's deliverables and update session-result.json.",
      "- session-result.json tells The Engineer where to route next. You MUST update it before finishing.",
      "- You have full CLI capabilities: read files, write files, search code, run commands. Use them freely.",
      "",
      "You are the Review session. Your job is to review the implementation with the critical eye of a senior code reviewer.",
    ].join("\n"),
  );
}

function buildPriorPhasePointers(thoughtsDir: string, loopbackCount: number): string {
  const lines = [
    "Read the implementation results and all prior phase files:",
    "",
    `- \`${thoughtsDir}/requirements/requirements.md\` — original requirements`,
    `- \`${thoughtsDir}/research/research.md\` — codebase analysis`,
    `- \`${thoughtsDir}/planning/plan.md\` — the plan (check which items are [x] done)`,
    `- \`${thoughtsDir}/implementation/session-result.json\` — implementation summary`,
    "",
    "Also run `git diff` to see all code changes.",
  ];

  if (loopbackCount > 0) {
    lines.push(
      "",
      `This is review iteration ${String(loopbackCount + 1)}. Prior review findings are in \`${thoughtsDir}/review/\`. Read them to understand what was already flagged and whether fixes were applied.`,
    );
  }

  return section("What Happened Before You", lines.join("\n"));
}

function buildReviewInstructions(loopbackCount: number): string {
  const lines = [
    "Review the code changes with the critical eye of a senior reviewer. Quality is non-negotiable.",
    "",
    "1. Read the plan and check which items are marked [x] done. Verify the implementation matches the plan.",
    "",
    "2. Run `git diff` to see all code changes. Read each changed file carefully.",
    "",
    "3. Check for:",
    "   - Requirements met? Compare against requirements.md acceptance criteria.",
    "   - Security issues? Injection, exposed secrets, unsafe operations, trust boundaries.",
    "   - Code quality? Naming, patterns, complexity, missing types, dead code.",
    "   - Missing tests? Uncovered edge cases, missing error handling tests.",
    "   - Performance? Unnecessary loops, N+1 queries, missing indexes.",
    "",
    "4. Run the test suite. If tests fail, that is a finding.",
    "",
    "5. Write your findings to the review directory (see output instructions below).",
    "",
    "6. If you find issues you can fix directly, fix them and document what you fixed.",
    "",
    "7. If fundamental issues remain that need another implementation pass, set next_phase to execution.",
  ];

  if (loopbackCount > 0) {
    lines.push(
      "",
      `This is loopback #${String(loopbackCount)}. Focus on the specific issues identified in the previous review. Verify they have been fixed before assessing overall quality.`,
    );
  }

  return section("What YOU Need To Do", lines.join("\n"));
}

function buildOutputInstructions(thoughtsDir: string): string {
  return section(
    "Where To Put Your Work",
    [
      "Write review findings to these files:",
      "",
      `- \`${thoughtsDir}/review/requirements-check.md\` — did we hit all acceptance criteria?`,
      `- \`${thoughtsDir}/review/security-review.md\` — security findings (or "No issues found")`,
      `- \`${thoughtsDir}/review/code-quality.md\` — quality, naming, patterns, refactoring suggestions`,
      "",
      `Update session-result.json at \`${thoughtsDir}/review/session-result.json\` with:`,
      "",
      "```json",
      "{",
      '  "status": "ready" or "need_more_info",',
      '  "next_phase": "demo_prep" (if ship-ready) or "execution" (if needs more work) or "requirements_gathering" (if requirements unclear),',
      '  "summary": "<one-line review verdict>"',
      "}",
      "```",
      "",
      'Set next_phase to "demo_prep" when the code is clean, tested, and ready for PR.',
      'Set next_phase to "execution" when fixable issues remain that need another implementation pass.',
      'Set next_phase to "requirements_gathering" when requirements themselves are ambiguous or incomplete.',
    ].join("\n"),
  );
}

function buildTaskContext(ctx: SelfReviewPromptContext): string {
  const parts: string[] = [];

  // Task brief
  parts.push(buildTaskBrief(ctx.task));

  // Repository context (minimal — branch only, reviewer explores via git diff)
  if (ctx.repoContext?.gitBranch) {
    parts.push(section("Repository", `Branch: ${ctx.repoContext.gitBranch}`));
  }

  // Knowledge
  const knowledge = buildKnowledgeSection(ctx.repoKnowledge, ctx.userKnowledge);
  if (knowledge) {
    parts.push(knowledge);
  }

  return section("The Task Context", parts.join("\n\n"));
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
