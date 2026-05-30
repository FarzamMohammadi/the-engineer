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

  // Only backup files that contain a real, schema-valid result.
  // Templates (placeholder values) and corrupt files are not worth preserving.
  const existing = readSessionResult(phaseDir);
  if (existing === null || existing === "invalid") {
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
    } catch (removalError) {
      // Both rename AND unlink failed — the stale file remains and will mask
      // the next CLI session's output. No observer in this module's scope; use
      // stderr so the failure is at least surfaced to the operator (matches
      // the doctor.ts pattern from the Slice 5 sweep).
      process.stderr.write(
        `session-result: failed to clear stale file at "${filePath}" (${removalError instanceof Error ? removalError.message : String(removalError)})\n`,
      );
    }
  }

  // Re-write fresh template so the CLI always has a file to read and update.
  // Template placeholders return "invalid" from readSessionResult(), so unchanged
  // templates are still caught by the Fail Loud check.
  writeSessionResultTemplate(phaseDir);
}

/** Write a session-result.json template with placeholder options to a phase directory. */
export function writeSessionResultTemplate(phaseDir: string): void {
  const template = {
    status: "<ready | need_more_info | error>",
    next_phase: "<requirements_gathering | research | planning | execution | self_review | demo_prep>",
    summary: "<one-line summary of what you accomplished>",
    complexity: "<trivial | moderate | complex>",
  };
  writeFileSync(path.join(phaseDir, "session-result.json"), `${JSON.stringify(template, null, 2)}\n`, "utf-8");
}
