import type { KnowledgeEntry } from "../../../schemas/session-memory.js";
import type { RepoContext } from "./context.js";
import {
  buildKnowledgeSection,
  buildRRPIROverview,
  buildRepoOverview,
  buildTaskBrief,
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
  repoKnowledge: KnowledgeEntry[];
  userKnowledge: KnowledgeEntry[];
  /** Full path to the thoughts directory, e.g. "thoughts/2026-03-22-issue-42" */
  thoughtsDir: string;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Build the prompt for the research phase (CLI-native RRPIR).
 *
 * Pure function: context in, prompt string out.
 */
export function buildResearchPrompt(ctx: ResearchPromptContext): string {
  const parts: string[] = [];

  // 1. How The Engineer Works
  parts.push(buildRRPIROverview("Research", ctx.thoughtsDir));

  // 2. What Happened Before You
  parts.push(buildPriorContext(ctx.thoughtsDir));

  // 3. What YOU Need To Do
  parts.push(buildResearchInstructions(ctx.thoughtsDir));

  // 4. Where To Put Your Work
  parts.push(buildDeliverableInstructions(ctx.thoughtsDir));

  // 5. The Task Context
  parts.push(buildTaskContextSection(ctx));

  return parts.join("\n\n");
}

// ── Internal Helpers ─────────────────────────────────────────────────────────

function buildPriorContext(thoughtsDir: string): string {
  return section(
    "What Happened Before You",
    [
      "Requirements were gathered in the previous phase.",
      "",
      `Read \`${thoughtsDir}/requirements/requirements.md\` for full task context and \`${thoughtsDir}/requirements/session-result.json\` for the previous phase's status.`,
      "",
      "Start by reading the requirements file — it contains the task description, gathered context, any Q&A with stakeholders, and an assessment of readiness.",
    ].join("\n"),
  );
}

function buildResearchInstructions(thoughtsDir: string): string {
  return section(
    "What YOU Need To Do",
    [
      "Research the codebase to build a complete picture of what this task involves. You are a senior engineer studying the code before writing a single line.",
      "",
      `1. Read \`${thoughtsDir}/requirements/requirements.md\` first for full task context.`,
      "",
      "2. Explore the codebase systematically. Document what exists, how it works, what patterns to follow:",
      "   - Map the relevant files: find every file that will need to change, plus files that provide critical context (interfaces, types, tests, configs).",
      "   - Trace execution paths end-to-end: For the core behavior being changed, follow the actual code path from trigger to final effect. Don't just identify which files are relevant — trace what happens at runtime. What values are passed? What error codes are returned? What flags are checked or ignored? Assumptions about behavior must be verified by reading the actual code, not inferred from type signatures or interface definitions.",
      "   - Identify conventions: coding style, naming patterns, test patterns (file location, naming, assertion style), directory structure, import/export patterns, error handling.",
      "   - Study the architectural patterns in the files you will modify. Every file has design choices — how it organizes logic, what it extracts vs inlines, how it separates concerns. These are the patterns your changes must follow. New code that ignores the architecture of the file it lives in is a regression, even if it works.",
      "   - Inventory the problem space: When the task involves changing, replacing, or removing instances of something, produce a precise count of every instance across the codebase before proposing solutions. The inventory is the contract — if you find 47 instances, execution must address 47, and review must verify zero remain. A representative sample is not an inventory.",
      "   - Identify dependencies: external packages involved, internal modules that interact with target code, shared types/schemas/utilities.",
      "   - Look at existing tests for the relevant modules. Understand the testing approach so new tests follow the same patterns.",
      "   - Check tooling configuration: linter rules, formatter settings, pre-commit hooks, test setup. These are hard constraints your implementation must satisfy — understand them now, not after a failed commit.",
      "",
      "3. **Challenge what you found.** After gathering findings, step back and stress-test them:",
      "   - What is the simplest possible approach to this task? Not the first approach you thought of — the minimum viable change that fully meets the requirements.",
      "   - Are the patterns you found actually good? An existing pattern might be legacy, over-engineered, or wrong for this case. If you find a pattern that seems unnecessarily complex, note it — do not blindly replicate bad architecture.",
      "   - What assumptions are you making that you have not verified? List them explicitly.",
      "   - Where does the pattern break? For every convention or pattern you identified, search for places where it is NOT followed — inconsistencies, legacy deviations, one-off exceptions. The exceptions are often more important than the pattern itself: they reveal tech debt, missed migrations, or intentional divergence that your implementation must account for.",
      "   - Is there an existing mechanism (utility, shared function, library) that already solves part of this problem? The best code is code you do not write.",
      "",
      "4. Do NOT make code changes. Do NOT plan solutions. Research only.",
      "",
      `5. If you discover you need more information from people that was not covered in requirements gathering, document it in research.md and set next_phase to "requirements_gathering" in session-result.json.`,
      "",
      `6. Write your findings to \`${thoughtsDir}/research/research.md\`. Use the template provided in the deliverable section.`,
      "",
      "7. **Update session-result.json** with your routing decision (see deliverable section below for the format).",
    ].join("\n"),
  );
}

function buildDeliverableInstructions(thoughtsDir: string): string {
  return section(
    "Where To Put Your Work",
    [
      `Deliverable: \`${thoughtsDir}/research/research.md\``,
      `Session result: \`${thoughtsDir}/research/session-result.json\``,
      "",
      "Update session-result.json with:",
      "```json",
      "{",
      '  "status": "ready" or "need_more_info",',
      '  "next_phase": "planning" (if ready) or "requirements_gathering" (if need more info),',
      '  "summary": "<one-line summary of your research findings>"',
      "}",
      "```",
      "",
      "Use this template for research.md:",
      "",
      "```markdown",
      "# Research: [Task Title]",
      "",
      "## Task Context",
      "[Brief — full details in requirements.md]",
      "",
      "## Codebase Analysis",
      "[What exists, how it works, relevant architecture]",
      "",
      "## Relevant Files",
      "- `path/to/file.ts` — [why relevant, what it does]",
      "",
      "## Patterns & Conventions",
      "[Coding style, test patterns, directory structure, naming]",
      "",
      "## Architectural Patterns in Target Files",
      "[How do the files you will modify organize their logic? What do they extract vs inline? What separation-of-concerns choices have been made? Your changes must follow these established patterns — not just naming conventions, but structural decisions.]",
      "",
      "## Dependencies & Integration Points",
      "[What this change touches, what depends on it, ripple effects]",
      "",
      "## Contract Verification",
      "[When the change depends on adapter contract fields (e.g., error codes, flags, capabilities), verify that relevant plugin implementations actually populate those fields correctly for the target scenario. A feature built on an unset flag is a feature that doesn't work. Document any gaps found.]",
      "",
      "## Complexity Assessment",
      "[Simple/moderate/complex — informs planning depth]",
      "",
      "## Open Questions",
      "[Anything still unclear after research]",
      "",
      "## Key Findings",
      "[Most important discoveries that should guide planning]",
      "",
      "## Simplest Viable Approach",
      "[What is the minimum change that fully meets the requirements? Not a shortcut — the genuinely simplest correct solution.]",
      "",
      "## Assumptions Made",
      "[What are you assuming that you have not verified? Be explicit — these become risks in planning.]",
      "",
      "## Patterns Questioned",
      "[Any existing patterns you found that seem over-engineered, legacy, or wrong for this case. If none, say so.]",
      "```",
    ].join("\n"),
  );
}

function buildTaskContextSection(ctx: ResearchPromptContext): string {
  const parts: string[] = [];

  // Task brief
  parts.push(buildTaskBrief(ctx.task));

  // Repository overview
  parts.push(buildRepoOverview(ctx.repoContext));

  // Knowledge
  const knowledge = buildKnowledgeSection(ctx.repoKnowledge, ctx.userKnowledge);
  if (knowledge) {
    parts.push(knowledge);
  }

  return parts.join("\n\n");
}
