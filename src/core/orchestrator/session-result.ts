import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { type SessionResult, SessionResultSchema } from "../../schemas/orchestrator.js";

/** Read and validate session-result.json from a phase directory. */
export function readSessionResult(phaseDir: string): SessionResult | null {
  const filePath = path.join(phaseDir, "session-result.json");
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    const raw = JSON.parse(readFileSync(filePath, "utf-8"));
    const result = SessionResultSchema.safeParse(raw);
    // safeParse rejects template placeholders (they don't match the enum values)
    return result.success ? result.data : null;
  } catch {
    return null;
  }
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
