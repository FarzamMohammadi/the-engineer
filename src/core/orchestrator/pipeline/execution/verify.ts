import { execFileSync } from "node:child_process";

import { WorkspaceNotReadyError } from "../../errors.js";
import { type GateCommand, verificationCommands } from "../grounding.js";
import {
  BlockCategories,
  type Ctx,
  type RoutableResult,
  type Route,
  type SubPhase,
  type SubPhaseResult,
} from "../types.js";

// ── The Sub-Phase ────────────────────────────────────────────────────────────
//
// An orchestrator sub-phase, not an agent one: it runs the project's own gates
// and reads their real exit codes, so a passing implementation cannot be faked.
// A red gate is a normal `ok` result with `passed: false` that routes back to
// `implement`; only a gate that cannot be run at all (missing tool) is an error.

/** Per-gate wall-clock ceiling. A gate that hangs past this is killed and counts as a failure. */
const GATE_TIMEOUT_MS = 600_000;
/** How much of a failing gate's output to carry back to `implement` — the tail, where the error usually is. */
const OUTPUT_LIMIT = 2_000;

/** Execution's verify: run the project's verification gates and route on the real verdict. */
export const verify: SubPhase = {
  name: "verify",
  run: runVerify,
  next: verifyNext,
};

/** Green gates advance; red gates repeat `implement` carrying the failures so the next pass can fix them. */
export function verifyNext(result: RoutableResult): Route {
  if (result.outcome === "needs_human") {
    return { go: "block", category: BlockCategories.awaiting_human, needed: "Resolve the verification ambiguity" };
  }
  const passed = (result.data as { passed?: boolean } | undefined)?.passed ?? false;
  return passed ? { go: "advance" } : { go: "repeat", carry: { summary: result.summary } };
}

// ── Running the Gates ────────────────────────────────────────────────────────

async function runVerify(ctx: Ctx): Promise<SubPhaseResult> {
  const commands = verificationCommands(ctx);
  if (commands.length === 0) {
    ctx.observer.warn("No verification gates recorded during grounding — verify has nothing to run", {
      taskId: ctx.task.id,
    });
    return {
      outcome: "ok",
      summary: "No verification gates were recorded during grounding — nothing to run",
      data: { passed: true },
    };
  }

  const cwd = ctx.worktreePath;
  if (!cwd) {
    throw new WorkspaceNotReadyError(ctx.task.id);
  }

  const results = commands.map((gate) => runGate(gate, cwd, ctx.signal));
  const failures = results.filter((result) => !result.passed);
  if (failures.length === 0) {
    return {
      outcome: "ok",
      summary: `All ${String(commands.length)} verification gates passed`,
      data: { passed: true },
    };
  }
  return { outcome: "ok", summary: summarizeFailures(failures), data: { passed: false } };
}

/** The outcome of one gate: whether it passed and, when it failed, the tail of its output. */
interface GateResult {
  readonly name: string;
  readonly passed: boolean;
  readonly output: string;
}

/** Run one gate via its real binary. A non-zero exit is a failure; a spawn failure (missing tool) throws. */
function runGate(gate: GateCommand, cwd: string, signal?: AbortSignal): GateResult {
  try {
    execFileSync(gate.command, gate.args, {
      cwd,
      encoding: "utf-8",
      timeout: GATE_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
      ...(signal ? { signal } : {}),
    });
    return { name: gate.name, passed: true, output: "" };
  } catch (error) {
    if (isExitFailure(error)) {
      return { name: gate.name, passed: false, output: captureOutput(error) };
    }
    throw new Error(`Cannot run verification gate "${gate.name}" (${gate.command}): ${describe(error)}`);
  }
}

/** A non-zero exit carries a numeric `status`; a spawn failure (ENOENT, EACCES) does not. */
function isExitFailure(error: unknown): boolean {
  return typeof (error as { status?: unknown }).status === "number";
}

/** Combine stdout and stderr from a failed gate, keeping the tail where the error usually lands. */
function captureOutput(error: unknown): string {
  const streams = error as { stdout?: string; stderr?: string };
  const combined = `${streams.stdout ?? ""}${streams.stderr ?? ""}`.trim();
  return combined.length > OUTPUT_LIMIT ? combined.slice(-OUTPUT_LIMIT) : combined;
}

function describe(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

/** Render the failing gates and their output for the carry back to `implement`. */
function summarizeFailures(failures: readonly GateResult[]): string {
  const names = failures.map((failure) => failure.name).join(", ");
  const detail = failures
    .map((failure) => `### ${failure.name}\n${failure.output || "(no output captured)"}`)
    .join("\n\n");
  return `Verification failed: ${names}\n\n${detail}`;
}
