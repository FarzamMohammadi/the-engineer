import type { Phase } from "../../../schemas/orchestrator.js";
import type { KnowledgeEntry } from "../../../schemas/session-memory.js";

// ── Action Descriptions ──────────────────────────────────────────────────────

const ACTION_DESCRIPTIONS: Record<string, string> = {
  read_file: 'Read a file. Params: {"path": "relative/path/to/file"}',
  write_file:
    'Create or overwrite a file. Params: {"path": "relative/path", "content": "file content"}',
  edit_file:
    'Replace a string in a file. Params: {"path": "relative/path", "old_string": "text to find", "new_string": "replacement text"}',
  search_files: 'Find files by name pattern. Params: {"pattern": "*.ts", "path": "src/"}',
  search_content:
    'Search file contents (regex). Params: {"pattern": "regex", "path": "src/", "glob": "*.ts"}',
  run_command: 'Run a shell command. Params: {"command": "the command to run"}',
  done: 'Complete this phase. Params: {"result": {your output data with the required fields below}}',
};

// ── Output Schema Descriptions ───────────────────────────────────────────────

const OUTPUT_SCHEMAS: Record<Phase, string> = {
  intake_analysis: [
    "Required fields in your done result:",
    '- complexity: one of "trivial", "simple", "moderate", "complex", "epic"',
    "- estimated_phases: array of phase names this task needs (from: intake_analysis, research, planning, execution, self_review, demo_prep, integration)",
    "- ambiguities: array of strings — unclear requirements or missing information",
    "- fast_path: boolean — true only if this is truly trivial (single file, no ambiguity, no new deps, no architectural changes)",
    "- decomposition_likely: boolean — true if the task should be split into subtasks",
  ].join("\n"),
  research: [
    "Required fields in your done result:",
    "- relevant_files: array of file paths that will need changes or provide important context",
    "- relevant_modules: array of logical module/component names (e.g., 'event-bus', 'task-engine')",
    "- conventions: array of objects describing codebase conventions found, e.g., {name: 'test naming', description: 'Tests use describe/it blocks'}",
    "- existing_patterns: array of strings describing reusable patterns (e.g., 'Factory functions for test helpers')",
    "- dependencies: array of strings — external packages or internal modules relevant to the task",
  ].join("\n"),
  planning: [
    "Required fields in your done result:",
    "- approach: string describing the technical approach",
    "- file_changes: array of {file, change_type, description} objects",
    "- risks: array of {risk, mitigation} objects",
    "- decomposition_plan: null, or an object describing how to split the task",
  ].join("\n"),
  execution: [
    "Required fields in your done result:",
    "- files_changed: array of file paths that were modified",
    "- tests_written: array of test file paths created or modified",
    "- test_results: {passed: number, failed: number, skipped: number}",
    '- build_status: "passing" or "failing"',
  ].join("\n"),
  self_review: [
    "Required fields in your done result:",
    "- findings: array of {type, file, description, fixed} objects",
    "- refactoring_applied: array of strings describing refactoring done",
    '- quality_assessment: one of "ship_it", "needs_work", "fundamental_issues"',
  ].join("\n"),
  demo_prep: [
    "Required fields in your done result:",
    "- artifacts: array of {type, location, permanent} objects",
    "- pr_number: positive integer",
    "- pr_description: string — full PR description with context",
  ].join("\n"),
  integration: [
    "Required fields in your done result:",
    "- children_verified: array of child task IDs that were checked",
    "- integration_tests: {passed: number, failed: number}",
    "- conflicts_found: array of strings describing merge/integration conflicts",
    "- resolution_actions: array of strings describing what was done to resolve them",
  ].join("\n"),
};

// ── Prior Phase Output Formatters ────────────────────────────────────────────

const PHASE_FORMATTERS: Partial<Record<Phase, (data: Record<string, unknown>) => string>> = {
  intake_analysis: (data) => {
    const lines = ["Intake Analysis Results:"];
    if (data["complexity"]) {
      lines.push(`- Complexity: ${String(data["complexity"])}`);
    }
    if (Array.isArray(data["estimated_phases"])) {
      lines.push(`- Estimated phases: ${(data["estimated_phases"] as string[]).join(", ")}`);
    }
    if (Array.isArray(data["ambiguities"]) && (data["ambiguities"] as string[]).length > 0) {
      lines.push("- Ambiguities:");
      for (const a of data["ambiguities"] as string[]) {
        lines.push(`  - ${a}`);
      }
    }
    lines.push(`- Fast path: ${data["fast_path"] === true ? "yes" : "no"}`);
    lines.push(`- Decomposition likely: ${data["decomposition_likely"] === true ? "yes" : "no"}`);
    return lines.join("\n");
  },
  research: (data) => {
    const lines = ["Research Findings:"];
    if (Array.isArray(data["relevant_files"]) && (data["relevant_files"] as string[]).length > 0) {
      lines.push("- Relevant files:");
      for (const f of data["relevant_files"] as string[]) {
        lines.push(`  - ${f}`);
      }
    }
    if (
      Array.isArray(data["relevant_modules"]) &&
      (data["relevant_modules"] as string[]).length > 0
    ) {
      lines.push(`- Relevant modules: ${(data["relevant_modules"] as string[]).join(", ")}`);
    }
    if (
      Array.isArray(data["existing_patterns"]) &&
      (data["existing_patterns"] as string[]).length > 0
    ) {
      lines.push("- Existing patterns:");
      for (const p of data["existing_patterns"] as string[]) {
        lines.push(`  - ${p}`);
      }
    }
    if (Array.isArray(data["dependencies"]) && (data["dependencies"] as string[]).length > 0) {
      lines.push(`- Dependencies: ${(data["dependencies"] as string[]).join(", ")}`);
    }
    return lines.join("\n");
  },
};

// ── Public API ───────────────────────────────────────────────────────────────

/** Format the available actions for a phase prompt. */
export function formatActionReference(allowedActions: string[]): string {
  const lines = ["Available actions:"];
  for (const action of allowedActions) {
    const desc = ACTION_DESCRIPTIONS[action];
    if (desc) {
      lines.push(`- ${action}: ${desc}`);
    }
  }
  return lines.join("\n");
}

/** Format the required output schema for a phase's done result. */
export function formatOutputSchema(phase: Phase): string {
  return OUTPUT_SCHEMAS[phase];
}

/** Format prior phase output as readable text instead of raw JSON. */
export function formatPriorPhaseOutput(phase: Phase, data: Record<string, unknown>): string {
  const formatter = PHASE_FORMATTERS[phase];
  if (formatter) {
    return formatter(data);
  }
  // Fallback for phases without a custom formatter
  return `${phase} output:\n${JSON.stringify(data, null, 2)}`;
}

/** Format knowledge entries as a readable block. */
export function formatKnowledge(entries: KnowledgeEntry[]): string {
  if (entries.length === 0) {
    return "";
  }
  const lines: string[] = [];
  for (const entry of entries) {
    lines.push(`- [${entry.domain}] ${entry.key}: ${entry.body} (confidence: ${entry.confidence})`);
  }
  return lines.join("\n");
}

/** Wrap content in a markdown section with heading. */
export function section(heading: string, content: string): string {
  return `## ${heading}\n\n${content}`;
}
