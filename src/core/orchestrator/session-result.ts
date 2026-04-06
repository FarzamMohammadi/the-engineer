import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import { type SessionResult, SessionResultSchema } from "../../schemas/orchestrator.js";

/**
 * Read and validate session-result.json from a phase directory.
 *
 * Returns:
 * - `SessionResult` — valid, parsed result
 * - `null` — file does not exist (normal for phases that don't write it)
 * - `"invalid"` — file exists but contains malformed JSON or fails schema validation
 */
export function readSessionResult(phaseDir: string): SessionResult | null | "invalid" {
  const filePath = path.join(phaseDir, "session-result.json");
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    const raw = JSON.parse(readFileSync(filePath, "utf-8"));
    const result = SessionResultSchema.safeParse(raw);
    // safeParse rejects template placeholders (they don't match the enum values)
    return result.success ? result.data : "invalid";
  } catch {
    return "invalid";
  }
}

/**
 * Backup existing session-result.json with ISO timestamp before a new CLI call.
 *
 * Preserves old files for debugging (sequentially timestamped, never collide,
 * easy to trace across 10+ retries) while ensuring no stale file exists when
 * the CLI runs. This prevents files from prior runs masking failures.
 */
export function backupSessionResult(phaseDir: string): void {
  const filePath = path.join(phaseDir, "session-result.json");
  if (!existsSync(filePath)) {
    return;
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(phaseDir, `session-result.${timestamp}.json.bak`);
  try {
    renameSync(filePath, backupPath);
  } catch {
    // If rename fails (permissions, cross-device, etc.), try unlinkSync as fallback.
    // Removing the stale file is more important than preserving the backup.
    try {
      unlinkSync(filePath);
    } catch {
      // Best effort — if both fail, the stale file remains but the warn log
      // from readSessionResult will surface the issue.
    }
  }
}

/** Write a session-result.json template with placeholder options to a phase directory. */
export function writeSessionResultTemplate(phaseDir: string): void {
  const template = {
    status: "<ready | need_more_info | error>",
    next_phase:
      "<requirements_gathering | research | planning | execution | self_review | demo_prep | integration>",
    summary: "<one-line summary of what you accomplished>",
    complexity: "<trivial | moderate | complex>",
  };
  writeFileSync(
    path.join(phaseDir, "session-result.json"),
    `${JSON.stringify(template, null, 2)}\n`,
    "utf-8",
  );
}
