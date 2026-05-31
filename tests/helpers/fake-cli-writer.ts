import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";

import type { AgentRunRequest, AgentRunResult } from "../../src/schemas/adapters.js";

/**
 * Simulates the file-writing behavior of a real CLI agent.
 *
 * Real CLI tools (claude-code, opencode) write `session-result.json` to their step directory
 * before exiting. The FakeLLM doesn't — without this side effect, `agentStep` reads the
 * unmodified template, sees "invalid", and fails the sub-phase.
 *
 * The prompt always names an absolute `…/session-result.json` path. We parse the last such
 * mention, infer the sub-phase from its directory, and write a valid new-handoff result there:
 * an honest `ok` plus the typed `details` the two detail-carrying sub-phases require (requirements'
 * grounding, refine's verdict).
 */
export function writeSessionResultFromPrompt(request: AgentRunRequest, _response: AgentRunResult): void {
  const targetPath = lastSessionResultPath(request.prompt);
  if (!targetPath) {
    return;
  }
  const stepDir = basename(dirname(targetPath));
  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, JSON.stringify(resultFor(stepDir)), "utf-8");
}

/** The last absolute `…/session-result.json` path named in a prompt — where this step reports. */
function lastSessionResultPath(prompt: string): string | null {
  let last: string | null = null;
  for (const match of prompt.matchAll(/(\/[^\s`'"]+\/session-result\.json)/g)) {
    last = match[1] ?? last;
  }
  return last;
}

/** The new-handoff result for a sub-phase, keyed by its step directory. */
function resultFor(stepDir: string): { status: string; summary: string; details?: Record<string, unknown> } {
  const summary = `fake-cli-writer: ${stepDir} done`;
  if (stepDir === "requirements") {
    return { status: "ok", summary, details: { complexity: "moderate", verification: { commands: [] } } };
  }
  if (stepDir === "refine") {
    return { status: "ok", summary, details: { verdict: "ship" } };
  }
  return { status: "ok", summary };
}
