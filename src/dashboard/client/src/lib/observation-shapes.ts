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
