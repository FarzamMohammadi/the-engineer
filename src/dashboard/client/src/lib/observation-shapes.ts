/**
 * Typed readers for the rich observation payloads the engine emits.
 *
 * The dashboard receives observations with `input`/`output` as opaque `Record<string, unknown>` JSON
 * (see `types/api.ts`). The engine stores each rich observation in a known shape, but those shapes are not
 * re-validated client-side. These pure readers narrow the raw JSON into the exact shape a shared component
 * renders, dropping anything malformed rather than crashing the view — so a single bad row degrades to an
 * empty/partial card instead of a white screen. They are unit-tested directly (no DOM needed).
 *
 * The readers take only the structural slice they need (`type` + `input`) rather than the full
 * `Observation` — both to stay dependency-free for the NodeNext test graph (the client's extensionless
 * imports resolve under the bundler tsconfig, not under the test compiler) and because a reader has no
 * business touching the rest of the row. Any `Observation` is structurally assignable.
 */

/** The structural slice of an observation these readers narrow — any `Observation` satisfies it. */
export interface ObservationLike {
  readonly type: string;
  readonly input: Record<string, unknown> | null;
}

// ── decision_point ─────────────────────────────────────────────────────────────
// Stored in `input`: { context, options: [{ id, description }], chosen, reasoning, confidence }.

/** One alternative the engine weighed at a decision fork. */
export interface DecisionOption {
  readonly id: string;
  readonly description: string;
}

/** The narrowed `decision_point` payload a `DecisionCard` renders. */
export interface DecisionShape {
  readonly context: string;
  readonly options: readonly DecisionOption[];
  readonly chosen: string;
  readonly reasoning: string;
  /** 0–1 model-reported confidence in the choice; null when the engine did not record one. */
  readonly confidence: number | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function parseOptions(value: unknown): readonly DecisionOption[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    const record = asRecord(entry);
    if (record === null) {
      return [];
    }
    return [{ id: asString(record["id"]), description: asString(record["description"]) }];
  });
}

/** Narrow a `decision_point` observation's `input` into a `DecisionShape`, or null when it is not a decision. */
export function readDecision(observation: ObservationLike): DecisionShape | null {
  if (observation.type !== "decision_point") {
    return null;
  }
  const input = asRecord(observation.input);
  if (input === null) {
    return null;
  }
  const confidence = input["confidence"];
  return {
    context: asString(input["context"]),
    options: parseOptions(input["options"]),
    chosen: asString(input["chosen"]),
    reasoning: asString(input["reasoning"]),
    confidence: typeof confidence === "number" ? confidence : null,
  };
}

// ── safety_verdict / verify_gates ───────────────────────────────────────────────
// Stored in `input`: { passed, gate_count, gates: [{ name, passed }], failed_gates }.

/** A single gate result inside a verify verdict. */
export interface GateResult {
  readonly name: string;
  readonly passed: boolean;
}

/** The narrowed `verify_gates` payload a `VerdictBadge` renders. */
export interface VerdictShape {
  readonly passed: boolean;
  readonly gateCount: number;
  readonly gates: readonly GateResult[];
  readonly failedGates: readonly string[];
}

// ── phase_transition ───────────────────────────────────────────────────────────
// Named phase_entered / sub_phase_started / sub_phase_result. The phase ALWAYS lives in `input.phase`
// (never in `name`). sub_phase_started/result carry `input.subPhase`; sub_phase_result also carries
// `input.outcome` and `input.summary` (and an optional structured `input.data`).

/** The structural slice a phase_transition reader needs. */
export interface PhaseTransitionLike {
  readonly name: string;
  readonly input: Record<string, unknown> | null;
}

/** The narrowed `phase_transition` payload the Phases tab groups and renders. */
export interface PhaseTransitionShape {
  /** The transition event: phase entry, sub-phase start, or sub-phase result. */
  readonly event: "phase_entered" | "sub_phase_started" | "sub_phase_result" | "unknown";
  /** The real pipeline phase this transition belongs to (`input.phase`); empty when absent. */
  readonly phase: string;
  /** The sub-phase, for start/result events; empty for a bare phase entry. */
  readonly subPhase: string;
  /** The sub-phase's terminal outcome, on a result event; empty otherwise. */
  readonly outcome: string;
  /** The sub-phase's one-line summary, on a result event; empty otherwise. */
  readonly summary: string;
}

function readEvent(name: string): PhaseTransitionShape["event"] {
  if (name === "phase_entered" || name === "sub_phase_started" || name === "sub_phase_result") {
    return name;
  }
  return "unknown";
}

/** Narrow a `phase_transition` observation into its phase/sub-phase/outcome — reads `input.phase`, never `name`. */
export function readPhaseTransition(observation: PhaseTransitionLike): PhaseTransitionShape {
  const input = asRecord(observation.input) ?? {};
  return {
    event: readEvent(observation.name),
    phase: asString(input["phase"]),
    subPhase: asString(input["subPhase"]),
    outcome: asString(input["outcome"]),
    summary: asString(input["summary"]),
  };
}

/** A sub-phase's run within a phase: its name, terminal outcome/summary, and whether it finished or is mid-flight. */
export interface SubPhaseRun {
  readonly subPhase: string;
  readonly outcome: string;
  readonly summary: string;
  /** ok = finished cleanly, error = finished with an error outcome, pending = started but no result yet (running now). */
  readonly status: "ok" | "error" | "pending";
}

/**
 * Reconstruct one phase's ordered sub-phase runs from its phase_transition observations. A `sub_phase_started`
 * opens a pending run; the matching `sub_phase_result` resolves the latest pending run of that sub-phase to its
 * outcome. A started-without-result stays pending — that is the sub-phase running right now. Assumes the input
 * is chronological (the order the read model returns), matching how the engine emitted the transitions.
 */
export function buildSubPhaseRuns(transitions: readonly PhaseTransitionLike[], phase: string): SubPhaseRun[] {
  const list: SubPhaseRun[] = [];
  for (const obs of transitions) {
    const shape = readPhaseTransition(obs);
    if (shape.phase !== phase || !shape.subPhase) {
      continue;
    }
    if (shape.event === "sub_phase_started") {
      list.push({ subPhase: shape.subPhase, outcome: "", summary: "", status: "pending" });
    } else if (shape.event === "sub_phase_result") {
      const pending = [...list].reverse().find((sp) => sp.subPhase === shape.subPhase && sp.status === "pending");
      const resolved: SubPhaseRun = {
        subPhase: shape.subPhase,
        outcome: shape.outcome,
        summary: shape.summary,
        status: shape.outcome === "error" ? "error" : "ok",
      };
      if (pending) {
        list[list.indexOf(pending)] = resolved;
      } else {
        list.push(resolved);
      }
    }
  }
  return list;
}

// ── agent_call ───────────────────────────────────────────────────────────────
// Stored in `input`: { step, prompt_blob }. Stored in `output`: { outcome, summary, cost_usd, tokens_in,
// tokens_out, cache_read_tokens, result_blob, transcript_blob }. `metadata` is ALWAYS null — cost/tokens and
// the blob refs live in `output` (with `input` as the observe()-path fallback the metrics aggregator uses).

/** The structural slice an agent_call reader needs: the step name lives in `input`, the spend in `output`. */
export interface AgentCallLike {
  readonly type: string;
  readonly input: Record<string, unknown> | null;
  readonly output: Record<string, unknown> | null;
}

/** The narrowed `agent_call` payload the Agent Calls tab and the timeline render. */
export interface AgentCallShape {
  /** The pipeline step the agent ran (e.g. "implement", "self-review") — the honest row label. */
  readonly step: string;
  /** The agent's terminal outcome ("ok"/"error"/…); empty when the span did not record one. */
  readonly outcome: string;
  /** The agent's one-line result summary; empty when none was recorded. */
  readonly summary: string;
  /** USD cost, or null when the CLI omitted pricing — distinct from a real $0 run, never inferred as 0. */
  readonly costUsd: number | null;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly cacheReadTokens: number;
  /** Blob ref (`prefix/hash`) for the full prompt the agent was given; empty when none. */
  readonly promptBlob: string;
  /** Blob ref for the agent's structured result (session-result.json); empty when none. */
  readonly resultBlob: string;
  /** Blob ref for the full agent transcript; empty when none. */
  readonly transcriptBlob: string;
}

function readNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return typeof value === "number" ? value : 0;
}

/**
 * Narrow an `agent_call` observation into an `AgentCallShape`, or null when it is not an agent call.
 *
 * Cost and tokens are read from `output` (where `span.end()` writes them) with `input` as the observe()-path
 * fallback — the SAME source the server's `aggregateAgentCost` uses, so the tab's totals never disagree with
 * the metrics page. `metadata` is deliberately never read: the observer never writes it (always null).
 */
export function readAgentCall(observation: AgentCallLike): AgentCallShape | null {
  if (observation.type !== "agent_call") {
    return null;
  }
  const input = asRecord(observation.input) ?? {};
  // span.end() writes the spend/result into `output`; `input` is the observe()-path fallback.
  const out = asRecord(observation.output) ?? input;
  const costRaw = out["cost_usd"];
  const tokensIn = readNumber(out, "tokens_in") || readNumber(out, "input_tokens");
  const tokensOut = readNumber(out, "tokens_out") || readNumber(out, "output_tokens");
  return {
    step: asString(input["step"]) || asString(out["step"]),
    outcome: asString(out["outcome"]),
    summary: asString(out["summary"]),
    costUsd: typeof costRaw === "number" ? costRaw : null,
    tokensIn,
    tokensOut,
    cacheReadTokens: readNumber(out, "cache_read_tokens"),
    promptBlob: asString(input["prompt_blob"]),
    resultBlob: asString(out["result_blob"]),
    transcriptBlob: asString(out["transcript_blob"]),
  };
}

function parseGates(value: unknown): readonly GateResult[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    const record = asRecord(entry);
    if (record === null) {
      return [];
    }
    return [{ name: asString(record["name"]), passed: record["passed"] === true }];
  });
}

function parseFailedGates(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}

/** Narrow a `safety_verdict` observation's `input` into a `VerdictShape`, or null when it is not a verdict. */
export function readVerdict(observation: ObservationLike): VerdictShape | null {
  if (observation.type !== "safety_verdict") {
    return null;
  }
  const input = asRecord(observation.input);
  if (input === null) {
    return null;
  }
  const gates = parseGates(input["gates"]);
  const failedGates = parseFailedGates(input["failed_gates"]);
  const gateCount = typeof input["gate_count"] === "number" ? input["gate_count"] : gates.length;
  // The verdict passes only when explicitly flagged so AND no gate failed — never infer a pass from a
  // missing flag. A gate marked failed overrides a stray `passed: true`.
  const passed = input["passed"] === true && failedGates.length === 0 && gates.every((gate) => gate.passed);
  return { passed, gateCount, gates, failedGates };
}
