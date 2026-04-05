import type { ReviewPhaseName } from "../../../schemas/config.js";
import type { KnowledgeEntry } from "../../../schemas/session-memory.js";
import type { RepoContext } from "./context.js";
import { buildKnowledgeSection, buildRRPIROverview, buildTaskBrief, section } from "./format.js";

// ── Types ────────────────────────────────────────────────────────────────────

/** Context needed to build a focused review sub-phase prompt. */
export interface ReviewSubPhaseContext {
  task: {
    title: string;
    description: string | null;
  };
  repoContext: RepoContext | null;
  repoKnowledge: KnowledgeEntry[];
  userKnowledge: KnowledgeEntry[];
  thoughtsDir: string;
  /** Which review lens to apply. */
  reviewPhaseName: ReviewPhaseName;
  /** How many times we've looped back. 0 on first pass. */
  loopbackCount: number;
}

/** Context needed to build the refinement prompt. */
export interface RefinementPromptContext {
  task: {
    title: string;
    description: string | null;
  };
  repoContext: RepoContext | null;
  repoKnowledge: KnowledgeEntry[];
  userKnowledge: KnowledgeEntry[];
  thoughtsDir: string;
  /** Which review phases were run (their .md files exist in review/). */
  reviewPhases: ReviewPhaseName[];
  /** How many times we've looped back. 0 on first pass. */
  loopbackCount: number;
}

// ── Review Lens Descriptions ────────────────────────────────────────────────

const REVIEW_LENS: Record<ReviewPhaseName, { title: string; instructions: string }> = {
  requirements_check: {
    title: "Requirements Check",
    instructions: [
      "Your sole focus is verifying that the implementation meets all acceptance criteria.",
      "",
      '1. Read the requirements file (see path in the "What Happened Before You" section above) carefully. Extract every acceptance criterion and requirement.',
      "2. Run `git diff` to see all code changes.",
      "3. For each criterion, verify it is implemented correctly.",
      "4. Check edge cases mentioned in requirements.",
      "5. Verify tests cover the acceptance criteria.",
      "",
      "Rate each requirement: MET, PARTIALLY MET (explain gap), or NOT MET (explain what's missing).",
    ].join("\n"),
  },
  security_review: {
    title: "Security Review",
    instructions: [
      "Your sole focus is finding security vulnerabilities in the code changes.",
      "",
      "1. Run `git diff` to see all code changes.",
      "2. Check for:",
      "   - Injection vulnerabilities (SQL, command, XSS, template injection)",
      "   - Authentication and authorization gaps",
      "   - Exposed secrets, tokens, or credentials",
      "   - Unsafe file operations (path traversal, symlink attacks)",
      "   - Trust boundary violations (untrusted input used unsafely)",
      "   - Insecure dependencies or API usage",
      "   - Missing input validation at system boundaries",
      "",
      "For each finding: describe the vulnerability, its severity (critical/high/medium/low), and a specific fix.",
      'If no issues found, write "No security issues found" with a brief explanation of what you checked.',
    ].join("\n"),
  },
  code_quality: {
    title: "Code Quality",
    instructions: [
      "Your sole focus is code quality, readability, and maintainability.",
      "",
      "1. Run `git diff` to see all code changes.",
      "2. Check for:",
      "   - Naming clarity (variables, functions, types)",
      "   - Consistent patterns with the existing codebase",
      "   - Unnecessary complexity (can anything be simplified?)",
      "   - Dead code or unused imports",
      "   - Missing or misleading type annotations",
      "   - Duplicated logic that should be extracted",
      "   - Error handling gaps",
      "   - Test quality (meaningful assertions, edge cases, not just happy path)",
      "",
      "For each finding: describe the issue, why it matters, and a specific suggestion.",
      'If the code is clean, write "No quality issues found" with brief praise for what was done well.',
    ].join("\n"),
  },
  architecture_review: {
    title: "Architecture Review",
    instructions: [
      "Your sole focus is architectural fitness — does the change respect system boundaries and design principles?",
      "",
      "1. Read the project's philosophy and architecture docs (`docs/philosophy.md`, `docs/architecture/`).",
      "2. Run `git diff` to see all code changes.",
      "3. Check against the project's architectural principles:",
      "",
      "   **Plugin Blindness (most critical):**",
      "   - Core referencing specific plugins or platform details",
      "   - Hardcoded plugin names, tokens, or platform-specific checks in Core",
      "   - Assumptions about which plugins are installed (must degrade gracefully with zero plugins)",
      "",
      "   **Boundaries as Discipline:**",
      "   - Reaching into module internals instead of extending the contract",
      "   - Layer isolation violations (Core leaking into plugins, plugins leaking into each other, adapters assuming specific plugins behind them)",
      "   - Interface pollution: methods added to interfaces that don't belong (e.g., scheduling concerns on a dispatch interface)",
      "   - Responsibility creep: a module taking on concerns outside its original purpose",
      "",
      "   **Fail Loud:**",
      "   - Errors suppressed silently (caught and swallowed without logging or propagation)",
      "   - Generic wrappers masking the original error (caller cannot tell what happened or where)",
      "   - Errors that should cross adapter boundaries being handled internally instead",
      "",
      "   **Isolation as Survival:**",
      "   - State bleeding across task boundaries (shared mutable state between tasks)",
      "   - State introduced where statelessness was a design choice",
      "",
      "   **Trust Through Restraint:**",
      "   - New output paths that could leak secrets (logs, events, error messages, PR descriptions)",
      "   - Privilege escalation beyond task scope",
      "",
      "   **Structural:**",
      "   - Coupling that could be avoided with better boundaries",
      "   - Existing patterns ignored or unnecessarily diverged from",
      "   - One-way doors: decisions that are hard to reverse (interface changes, new event types, schema additions)",
      "",
      "For each finding: describe the concern, which principle it violates, and a concrete alternative.",
      'If the architecture is clean, write "No architecture issues found" with a brief note on what was checked.',
    ].join("\n"),
  },
};

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Build a focused review sub-phase prompt for one review lens.
 *
 * Each review sub-phase is a separate CLI session with a single focus.
 * It writes findings to `thoughts/{thoughtsDir}/review/{phase-name}.md`.
 * It does NOT write session-result.json (routing is handled by the refinement step).
 */
export function buildReviewSubPhasePrompt(ctx: ReviewSubPhaseContext): string {
  const parts: string[] = [];
  const lens = REVIEW_LENS[ctx.reviewPhaseName];

  // 1. How The Engineer Works
  parts.push(buildRRPIROverview(`Review — ${lens.title}`, ctx.thoughtsDir));

  // 2. What Happened Before You
  parts.push(buildPriorPhasePointers(ctx.thoughtsDir, ctx.loopbackCount));

  // 3. What YOU Need To Do
  parts.push(section("What YOU Need To Do", lens.instructions));

  // 4. Where To Put Your Work
  parts.push(buildReviewOutputInstructions(ctx.thoughtsDir, ctx.reviewPhaseName));

  // 5. The Task Context
  parts.push(buildTaskContext(ctx));

  return parts.join("\n\n");
}

/**
 * Build the refinement prompt that consolidates all review findings and applies fixes.
 *
 * Reads all `thoughts/{thoughtsDir}/review/*.md` files, consolidates findings,
 * executes fixes, and writes session-result.json for routing.
 */
export function buildRefinementPrompt(ctx: RefinementPromptContext): string {
  const parts: string[] = [];

  // 1. How The Engineer Works
  parts.push(buildRRPIROverview("Refinement", ctx.thoughtsDir));

  // 2. What Happened Before You
  parts.push(buildRefinementPriorPointers(ctx.thoughtsDir, ctx.reviewPhases, ctx.loopbackCount));

  // 3. What YOU Need To Do
  parts.push(buildRefinementInstructions(ctx.thoughtsDir));

  // 4. Where To Put Your Work
  parts.push(buildRefinementOutputInstructions(ctx.thoughtsDir));

  // 5. The Task Context
  parts.push(buildTaskContext(ctx));

  return parts.join("\n\n");
}

// ── Internal Helpers ─────────────────────────────────────────────────────────

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

function buildReviewOutputInstructions(
  thoughtsDir: string,
  reviewPhaseName: ReviewPhaseName,
): string {
  return section(
    "Where To Put Your Work",
    [
      `Write your findings to: \`${thoughtsDir}/review/${reviewPhaseName}.md\``,
      "",
      "Structure your findings clearly with headings and specific file/line references.",
      "Do NOT write session-result.json — the refinement step handles routing.",
    ].join("\n"),
  );
}

function buildRefinementPriorPointers(
  thoughtsDir: string,
  reviewPhases: ReviewPhaseName[],
  loopbackCount: number,
): string {
  const reviewFiles = reviewPhases
    .map((name) => `- \`${thoughtsDir}/review/${name}.md\` — ${REVIEW_LENS[name].title} findings`)
    .join("\n");

  const lines = [
    "Read ALL review findings and prior phase context:",
    "",
    reviewFiles,
    "",
    `- \`${thoughtsDir}/requirements/requirements.md\` — original requirements`,
    `- \`${thoughtsDir}/planning/plan.md\` — the plan`,
    "",
    "Also run `git diff` to see current code state.",
  ];

  if (loopbackCount > 0) {
    lines.push(
      "",
      `This is refinement iteration ${String(loopbackCount + 1)}. Check \`${thoughtsDir}/review/refinements.md\` for what was previously consolidated and fixed.`,
    );
  }

  return section("What Happened Before You", lines.join("\n"));
}

function buildRefinementInstructions(thoughtsDir: string): string {
  return section(
    "What YOU Need To Do",
    [
      "You are the final quality gate before the PR goes out.",
      "",
      `1. Read ALL review findings from \`${thoughtsDir}/review/*.md\`.`,
      "2. Consolidate findings. Group by severity and type.",
      "3. Fix every actionable issue directly in the code:",
      "   - Security issues: fix immediately, no exceptions.",
      "   - Requirements gaps: implement missing functionality.",
      "   - Code quality: apply fixes where they improve clarity.",
      "4. Run the test suite after applying fixes. Ensure all tests pass.",
      "5. Write a summary of what you found and what you fixed.",
      "",
      "If substantial issues remain that you cannot fix in this pass, signal that another implementation pass is needed.",
      "If requirements are ambiguous and you cannot determine the correct fix, signal that requirements gathering is needed.",
    ].join("\n"),
  );
}

function buildRefinementOutputInstructions(thoughtsDir: string): string {
  return section(
    "Where To Put Your Work",
    [
      `Write your consolidation to: \`${thoughtsDir}/review/refinements.md\``,
      "",
      "Include:",
      "- Summary of all review findings",
      "- What was fixed (with file references)",
      "- What remains unfixed (and why)",
      "",
      `Update session-result.json at \`${thoughtsDir}/review/session-result.json\` with:`,
      "",
      "```json",
      "{",
      '  "status": "ready" or "need_more_info",',
      '  "next_phase": "demo_prep" (clean, ready for PR) or "execution" (substantial issues remain) or "requirements_gathering" (requirements unclear),',
      '  "summary": "<one-line refinement verdict>"',
      "}",
      "```",
      "",
      'Set next_phase to "demo_prep" when all findings are addressed and the code is PR-ready.',
      'Set next_phase to "execution" when fixable issues remain that need another implementation pass.',
      'Set next_phase to "requirements_gathering" when requirements themselves are ambiguous.',
    ].join("\n"),
  );
}

function buildTaskContext(ctx: ReviewSubPhaseContext | RefinementPromptContext): string {
  const parts: string[] = [];

  parts.push(buildTaskBrief(ctx.task));

  if (ctx.repoContext?.gitBranch) {
    parts.push(section("Repository", `Branch: ${ctx.repoContext.gitBranch}`));
  }

  const knowledge = buildKnowledgeSection(ctx.repoKnowledge, ctx.userKnowledge);
  if (knowledge) {
    parts.push(knowledge);
  }

  return section("The Task Context", parts.join("\n\n"));
}
