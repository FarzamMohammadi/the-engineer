import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { type SessionResult, SessionResultSchema } from "../../schemas/orchestrator.js";

const PLACEHOLDER_PATTERN = /^<.+>$/;

/** Read and validate session-result.json from a phase directory. */
export function readSessionResult(phaseDir: string): SessionResult | null {
  const filePath = path.join(phaseDir, "session-result.json");
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    const raw = JSON.parse(readFileSync(filePath, "utf-8"));
    const result = SessionResultSchema.safeParse(raw);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/** Check if a session result has been filled in (not still template placeholders). */
export function isTemplateFilled(result: SessionResult): boolean {
  return !(
    PLACEHOLDER_PATTERN.test(result.status) ||
    PLACEHOLDER_PATTERN.test(result.next_phase) ||
    PLACEHOLDER_PATTERN.test(result.summary)
  );
}

/** Write a session-result.json template with placeholder options to a phase directory. */
export function writeSessionResultTemplate(phaseDir: string): void {
  const template = {
    status: "<ready | need_more_info | error>",
    next_phase:
      "<requirements_gathering | research | planning | execution | self_review | demo_prep | integration>",
    summary: "<one-line summary of what you accomplished>",
  };
  writeFileSync(
    path.join(phaseDir, "session-result.json"),
    `${JSON.stringify(template, null, 2)}\n`,
    "utf-8",
  );
}
