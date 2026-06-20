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

// ── agent_activity ─────────────────────────────────────────────────────────────
// One element of an agent's live conversation inside a single `agent_call`. The sink writes the canonical
// kind plus a bounded, secret-scrubbed preview into `input` (the `observe()` path), spilling long text or
// large tool I/O to a `*_blob` ref. Shapes by kind:
//   session        → { kind, model, tools, cwd }
//   assistant_text → { kind, text, truncated?, text_blob? }
//   thinking       → { kind, text, truncated?, text_blob? }
//   tool_use       → { kind, tool_call_id, name, input, truncated?, input_blob? }
//   tool_result    → { kind, tool_call_id, status, output, truncated?, output_blob? }

/** The canonical kinds an `agent_activity` row carries — the discriminant for rendering a conversation line. */
export type ActivityKind = "session" | "assistant_text" | "thinking" | "tool_use" | "tool_result";

/** The narrowed `agent_activity` payload the conversation feed renders. Absent fields are empty/null by kind. */
export interface AgentActivityShape {
  /** The conversation element this row is; null when the row is not an `agent_activity` or its kind is unknown. */
  readonly kind: ActivityKind;
  /** The observation `name` — the kind for text/thinking/result, the tool's own name for a `tool_use`. */
  readonly name: string;
  /** Pairs a `tool_use` with its later `tool_result`; empty for text/thinking/session. */
  readonly toolCallId: string;
  /** assistant_text / thinking: the inline text preview (truncated when `truncated`). */
  readonly text: string;
  /** tool_use: the invoked tool's name. */
  readonly toolName: string;
  /** tool_use: the inline tool-input preview. */
  readonly input: string;
  /** tool_result: the inline tool-output preview. */
  readonly output: string;
  /** tool_result: whether the tool succeeded or errored, as the agent reported it. */
  readonly status: "ok" | "error" | null;
  /** session: the model the run reported; empty when none. */
  readonly model: string;
  /** True when the inline preview was truncated and the full value lives in the matching `*Blob`. */
  readonly truncated: boolean;
  /** Blob ref (`prefix/hash`) for the full text, when truncated; empty otherwise. */
  readonly textBlob: string;
  /** Blob ref for the full tool input, when truncated; empty otherwise. */
  readonly inputBlob: string;
  /** Blob ref for the full tool output, when truncated; empty otherwise. */
  readonly outputBlob: string;
}

function asActivityKind(value: unknown): ActivityKind | null {
  if (
    value === "session" ||
    value === "assistant_text" ||
    value === "thinking" ||
    value === "tool_use" ||
    value === "tool_result"
  ) {
    return value;
  }
  return null;
}

function asActivityStatus(value: unknown): "ok" | "error" | null {
  return value === "ok" || value === "error" ? value : null;
}

/**
 * Narrow an `agent_activity` observation's `input` into an `AgentActivityShape`, or null when it is not an
 * activity row or its kind is unrecognized. Drops malformed payloads to a safe partial rather than throwing —
 * a single bad row degrades to an empty line, never a white screen (mirrors the other readers).
 */
export function readAgentActivity(observation: ObservationLike): AgentActivityShape | null {
  if (observation.type !== "agent_activity") {
    return null;
  }
  const input = asRecord(observation.input);
  if (input === null) {
    return null;
  }
  const kind = asActivityKind(input["kind"]);
  if (kind === null) {
    return null;
  }
  const toolName = asString(input["name"]);
  return {
    kind,
    name: toolName,
    toolCallId: asString(input["tool_call_id"]),
    text: asString(input["text"]),
    toolName,
    input: asString(input["input"]),
    output: asString(input["output"]),
    status: asActivityStatus(input["status"]),
    model: asString(input["model"]),
    truncated: input["truncated"] === true,
    textBlob: asString(input["text_blob"]),
    inputBlob: asString(input["input_blob"]),
    outputBlob: asString(input["output_blob"]),
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

// ── tool_execution / gate:<name> ────────────────────────────────────────────────
// verify wraps each gate in a `gate:<name>` tool_execution span (`verify.ts`), recording the gate's pass
// flag and captured command output in `output = { passed, output }`.

/** The structural slice a gate reader needs: the `gate:` prefix lives in `name`, the result in `output`. */
export interface ToolExecutionLike {
  readonly type: string;
  readonly name: string;
  readonly output: Record<string, unknown> | null;
}

/** A verify gate's result: the gate name (without the `gate:` prefix), its pass flag, and its captured output. */
export interface GateExecution {
  readonly name: string;
  readonly passed: boolean;
  readonly output: string;
}

/**
 * Narrow a `gate:<name>` `tool_execution` into its result, or null when the observation is not a gate span.
 * Strips the `gate:` prefix so the name reads as the bare gate (`lint`, `typecheck`); reads the pass flag and
 * captured output from `output`. Mirrors the local reader the Tools tab uses, lifted here so the step feed can
 * render gate output and the logic is unit-tested directly.
 */
export function readGate(observation: ToolExecutionLike): GateExecution | null {
  if (observation.type !== "tool_execution" || !observation.name.startsWith("gate:")) {
    return null;
  }
  const out = asRecord(observation.output) ?? {};
  return {
    name: observation.name.slice("gate:".length),
    passed: out["passed"] === true,
    output: asString(out["output"]),
  };
}

// ── step feed ───────────────────────────────────────────────────────────────────
// One row per sub-phase the engine actually ran — LLM and non-LLM alike — so the feed reads as the true
// executed sequence (e.g. implement → verify → implement), not just the LLM calls.

/**
 * The structural slice the step-feed builders read from each observation — any `Observation` is assignable.
 * Richer than the per-type reader slices above because the builders correlate across rows by phase, trace, and
 * time, and key React elements by id. Kept here (not imported from `types/api`) so this module stays free of
 * the client's extensionless import chain, which the test compiler cannot resolve (see the file header).
 */
export interface StepObservationLike {
  readonly id: string;
  readonly type: string;
  readonly name: string;
  readonly phase: string | null;
  readonly trace_id: string | null;
  readonly start_time: string;
  readonly input: Record<string, unknown> | null;
  readonly output: Record<string, unknown> | null;
}

/**
 * One reconstructed sub-phase run across the whole task: its phase/name, terminal outcome, timing, and trace.
 * Carries the timing and trace that `SubPhaseRun` drops (it does not replace `SubPhaseRun`, which the Phases
 * tab still uses) so the feed can correlate each run's enriching observations to it by a time window.
 */
export interface StepRun {
  readonly phase: string;
  readonly subPhase: string;
  /** ok = finished cleanly, error = finished with an error outcome, pending = started but no result yet. */
  readonly status: "ok" | "error" | "pending";
  readonly outcome: string;
  readonly summary: string;
  readonly startTime: string;
  readonly traceId: string | null;
  /** The sub-phase result's structured `data` payload (e.g. a merge `{disposition}`); null when none. */
  readonly data: Record<string, unknown> | null;
}

/**
 * A reconstructed run enriched with the observations it owns, ready to render. `kind` is `llm` exactly when the
 * run has a correlated `agent_call` — self-maintaining, with no hardcoded list of non-LLM sub-phases to keep in
 * sync with the pipeline. Generic over the observation type so callers passing `Observation[]` get
 * `Observation` back in every payload field (the reused `AgentTraceRow` needs a real `Observation`).
 */
export interface EnrichedStep<T extends StepObservationLike> extends StepRun {
  readonly kind: "llm" | "nonllm";
  /** The single `agent_call` for an LLM step; null for a non-LLM step. */
  readonly agentCall: T | null;
  /** The `safety_verdict` for a verify step; null otherwise. */
  readonly verdict: T | null;
  /** The `tool_execution` spans the run produced — verify's `gate:*` and delivery's git/PR spans. */
  readonly tools: readonly T[];
  /** The `route:*` / `loop_*` decisions the run led to — the "why it advanced/looped". */
  readonly decisions: readonly T[];
}

/**
 * Reconstruct every sub-phase run across the whole task from its `phase_transition` observations, in order.
 * A `sub_phase_started` opens a pending run carrying its timing/trace; the matching `sub_phase_result` resolves
 * the latest still-pending run of that sub-phase to its outcome, summary, and structured `data`. A
 * started-without-result stays pending — the step running right now. A result with no matching start (its start
 * fell outside the fetched window) is emitted as its own resolved run rather than dropped. Assumes the input is
 * chronological (the order the read model returns), matching how the engine emitted the transitions.
 */
export function buildStepRuns(transitions: readonly StepObservationLike[]): StepRun[] {
  const list: StepRun[] = [];
  for (const obs of transitions) {
    const shape = readPhaseTransition(obs);
    if (!shape.subPhase) {
      continue;
    }
    if (shape.event === "sub_phase_started") {
      list.push({
        phase: shape.phase,
        subPhase: shape.subPhase,
        status: "pending",
        outcome: "",
        summary: "",
        startTime: obs.start_time,
        traceId: obs.trace_id,
        data: null,
      });
    } else if (shape.event === "sub_phase_result") {
      const resolution = {
        status: shape.outcome === "error" ? ("error" as const) : ("ok" as const),
        outcome: shape.outcome,
        summary: shape.summary,
        data: asRecord(asRecord(obs.input)?.["data"]),
      };
      const pending = [...list].reverse().find((run) => run.subPhase === shape.subPhase && run.status === "pending");
      if (pending) {
        list[list.indexOf(pending)] = { ...pending, ...resolution };
      } else {
        list.push({
          phase: shape.phase,
          subPhase: shape.subPhase,
          startTime: obs.start_time,
          traceId: obs.trace_id,
          ...resolution,
        });
      }
    }
  }
  return list;
}

/** True when two trace ids are the same dispatch — non-null equality, with null===null as the safe fallback. */
function sameTrace(a: string | null, b: string | null): boolean {
  return a === b;
}

/**
 * Build the ordered step feed: every sub-phase run with the observations it owns.
 *
 * Correlation model — there is NO parent link from a run to its observations (`traceScope` stamps every
 * pipeline observation with the same `parent_observation_id = rootObservationId`), so each run claims its
 * enrichments by `(phase, trace_id)` plus a half-open time window `[run.startTime, nextRun.startTime)`. This
 * encodes the runner's emission order (start → the run's own spans/verdict/agent_call → result → route/loop) as
 * a behavioral assumption: a run's gates, verdict, agent_call, and trailing route/loop decisions all fall in
 * its window. The lower bound is inclusive so an `agent_call` span that shares its `sub_phase_started`'s
 * millisecond lands in its own run; the upper bound is exclusive so it never bleeds into the next run. If a
 * future runner change emits a run's enrichments outside this window, drill-in would mis-attribute — keep the
 * emission order and this window in sync.
 */
export function buildStepFeed<T extends StepObservationLike>(
  transitions: readonly T[],
  agentCalls: readonly T[],
  verdicts: readonly T[],
  toolExecutions: readonly T[],
  decisions: readonly T[],
): EnrichedStep<T>[] {
  const runs = buildStepRuns(transitions);
  return runs.map((run, index) => {
    // The window closes at the next run's start (exclusive); the last run's window is open-ended (+∞).
    const nextStart = runs[index + 1]?.startTime ?? null;
    const inWindow = (obs: T): boolean =>
      (obs.phase ?? "") === run.phase &&
      sameTrace(obs.trace_id, run.traceId) &&
      obs.start_time >= run.startTime &&
      (nextStart === null || obs.start_time < nextStart);

    const agentCall = agentCalls.find((obs) => obs.type === "agent_call" && inWindow(obs)) ?? null;
    return {
      ...run,
      kind: agentCall ? "llm" : "nonllm",
      agentCall,
      verdict: verdicts.find((obs) => obs.type === "safety_verdict" && inWindow(obs)) ?? null,
      tools: toolExecutions.filter((obs) => obs.type === "tool_execution" && inWindow(obs)),
      decisions: decisions.filter(
        (obs) =>
          obs.type === "decision_point" &&
          (obs.name.startsWith("route:") || obs.name.startsWith("loop_")) &&
          inWindow(obs),
      ),
    };
  });
}
