import type { KnowledgeEntry } from "../../../schemas/session-memory.js";
import type { RepoContext } from "./context.js";
import { buildTaskBrief, formatKnowledge, section } from "./format.js";

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
  parts.push(buildRrpirOverview(ctx.thoughtsDir));

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

function buildRrpirOverview(thoughtsDir: string): string {
  return section(
    "How The Engineer Works",
    [
      "You are running as part of The Engineer, an autonomous software engineering agent. The Engineer uses RRPIR methodology — Requirements Gathering, Research, Planning, Implementation, Review. Each phase is a separate CLI session. You are the Research session.",
      "",
      "You have full CLI capabilities: read files, write files, search code, run commands. Use them freely to explore the codebase. You are researching — do NOT make code changes or plan solutions.",
      "",
      `Your deliverable goes in \`${thoughtsDir}/research/research.md\`. After you finish, update \`${thoughtsDir}/research/session-result.json\` to tell The Engineer where to go next.`,
    ].join("\n"),
  );
}

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
      "   - Identify conventions: coding style, naming patterns, test patterns (file location, naming, assertion style), directory structure, import/export patterns, error handling.",
      "   - Identify dependencies: external packages involved, internal modules that interact with target code, shared types/schemas/utilities.",
      "   - Look at existing tests for the relevant modules. Understand the testing approach so new tests follow the same patterns.",
      "   - Check configuration, build setup, and CI/CD patterns that might affect changes.",
      "",
      "3. Do NOT make code changes. Do NOT plan solutions. Research only.",
      "",
      `4. If you discover you need more information from people that was not covered in requirements gathering, document it in research.md and set next_phase to "requirements_gathering" in session-result.json.`,
      "",
      `5. Write your findings to \`${thoughtsDir}/research/research.md\`. Use the template provided in the deliverable section.`,
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
      "## Dependencies & Integration Points",
      "[What this change touches, what depends on it, ripple effects]",
      "",
      "## Complexity Assessment",
      "[Simple/moderate/complex — informs planning depth]",
      "",
      "## Open Questions",
      "[Anything still unclear after research]",
      "",
      "## Key Findings",
      "[Most important discoveries that should guide planning]",
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

function buildRepoOverview(repoContext: RepoContext | null): string {
  if (!repoContext) {
    return section(
      "Repository",
      "No repository context available. Explore the codebase yourself using search and read commands.",
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

  // README omitted in research — the CLI already has access and requirements.md
  // captures the relevant context. Recent commits included for change history.
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
