import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { InferenceRequest, InferenceResult } from "../../src/schemas/adapters.js";

/**
 * Simulates the file-writing behavior of a real CLI LLM agent.
 *
 * Real CLI tools (claude-code, opencode) write `session-result.json` to a phase
 * directory before exiting. The FakeLLM doesn't do this — without a side effect,
 * `runPhaseWithCli` reads the unmodified template, sees "invalid", and throws.
 *
 * The prompt always includes an absolute `…/session-result.json` path. We parse
 * the last such mention and write a valid result there. Prompts that don't need
 * a session-result (review sub-phases) are no-ops.
 */
export function writeSessionResultFromPrompt(_request: InferenceRequest, response: InferenceResult): void {
  const prompt = _request.prompt;
  const matches = prompt.matchAll(/(\/[^\s`'"]+\/session-result\.json)/g);
  let targetPath: string | null = null;
  for (const m of matches) {
    targetPath = m[1] ?? targetPath;
  }
  if (!targetPath) {
    return;
  }

  // The canned response may carry a `result` object describing the phase
  // outcome. Use status if present, otherwise default to `ready`.
  let status: "ready" | "need_more_info" | "error" = "ready";
  try {
    const parsed = JSON.parse(response.content) as {
      result?: { status?: string; next_phase?: string; complexity?: string };
    };
    const s = parsed.result?.status;
    if (s === "ready" || s === "need_more_info" || s === "error") {
      status = s;
    }
  } catch {
    // Non-JSON canned response — fine, default values are used.
  }

  const sessionResult = {
    status,
    next_phase: "research",
    summary: "fake-cli-writer: synthetic session result",
    complexity: "moderate",
  };

  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, `${JSON.stringify(sessionResult, null, 2)}\n`, "utf-8");
}
