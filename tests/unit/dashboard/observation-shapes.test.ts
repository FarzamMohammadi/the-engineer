import { describe, expect, it } from "vitest";

import {
  type AgentCallLike,
  type ObservationLike,
  type PhaseTransitionLike,
  type StepObservationLike,
  buildStepFeed,
  buildStepRuns,
  buildSubPhaseRuns,
  readAgentActivity,
  readAgentCall,
  readBlock,
  readDecision,
  readGate,
  readPhaseTransition,
  readVerdict,
} from "../../../src/dashboard/client/src/lib/observation-shapes.js";

// ── observation-shapes ───────────────────────────────────────────────────────────
//
// These pure readers narrow the opaque `input` JSON the API returns into the exact shape a shared component
// renders. The dashboard cannot re-validate with zod, so the readers must drop malformed payloads to a
// safe partial/empty shape rather than throw — a single bad row must not white-screen the view. They take
// only the `{ type, input }` slice, so the test builds that slice directly (a full `Observation` is
// structurally assignable but pulls the client's extensionless import chain into the test compiler).

function makeObservation(type: string, input: Record<string, unknown> | null): ObservationLike {
  return { type, input };
}

describe("readDecision", () => {
  it("narrows a well-formed decision_point input", () => {
    const obs = makeObservation("decision_point", {
      context: "Should the verify sub-phase re-run?",
      options: [
        { id: "rerun", description: "Re-run verify" },
        { id: "skip", description: "Skip to review" },
      ],
      chosen: "rerun",
      reasoning: "Two gates were still failing.",
      confidence: 0.82,
    });

    expect(readDecision(obs)).toEqual({
      context: "Should the verify sub-phase re-run?",
      options: [
        { id: "rerun", description: "Re-run verify" },
        { id: "skip", description: "Skip to review" },
      ],
      chosen: "rerun",
      reasoning: "Two gates were still failing.",
      confidence: 0.82,
    });
  });

  it("returns null for a non-decision observation", () => {
    expect(readDecision(makeObservation("safety_verdict", { passed: true }))).toBeNull();
  });

  it("returns null when input is null", () => {
    expect(readDecision(makeObservation("decision_point", null))).toBeNull();
  });

  it("defaults missing fields and drops malformed options", () => {
    const obs = makeObservation("decision_point", {
      context: "ctx",
      options: ["not-an-object", { id: "a", description: "A" }, { id: 5 }],
    });
    const decision = readDecision(obs);
    expect(decision).not.toBeNull();
    expect(decision?.options).toEqual([
      { id: "a", description: "A" },
      { id: "", description: "" },
    ]);
    expect(decision?.chosen).toBe("");
    expect(decision?.reasoning).toBe("");
    expect(decision?.confidence).toBeNull();
  });

  it("treats a non-numeric confidence as null", () => {
    const obs = makeObservation("decision_point", { confidence: "high" });
    expect(readDecision(obs)?.confidence).toBeNull();
  });
});

describe("readVerdict", () => {
  it("narrows a passing verdict", () => {
    const obs = makeObservation("safety_verdict", {
      passed: true,
      gate_count: 2,
      gates: [
        { name: "typecheck", passed: true },
        { name: "lint", passed: true },
      ],
      failed_gates: [],
    });

    expect(readVerdict(obs)).toEqual({
      passed: true,
      gateCount: 2,
      gates: [
        { name: "typecheck", passed: true },
        { name: "lint", passed: true },
      ],
      failedGates: [],
    });
  });

  it("reports failure when a gate failed even if passed is stray-true", () => {
    const obs = makeObservation("safety_verdict", {
      passed: true,
      gate_count: 2,
      gates: [
        { name: "typecheck", passed: true },
        { name: "test", passed: false },
      ],
      failed_gates: ["test"],
    });
    const verdict = readVerdict(obs);
    expect(verdict?.passed).toBe(false);
    expect(verdict?.failedGates).toEqual(["test"]);
  });

  it("never infers a pass from a missing passed flag", () => {
    const obs = makeObservation("safety_verdict", {
      gates: [{ name: "lint", passed: true }],
      failed_gates: [],
    });
    expect(readVerdict(obs)?.passed).toBe(false);
  });

  it("falls back gate_count to the gate list length when absent", () => {
    const obs = makeObservation("safety_verdict", {
      passed: true,
      gates: [{ name: "lint", passed: true }],
      failed_gates: [],
    });
    expect(readVerdict(obs)?.gateCount).toBe(1);
  });

  it("returns null for a non-verdict observation", () => {
    expect(readVerdict(makeObservation("decision_point", { context: "x" }))).toBeNull();
  });

  it("returns null when input is null", () => {
    expect(readVerdict(makeObservation("safety_verdict", null))).toBeNull();
  });

  it("drops malformed gate entries instead of throwing", () => {
    const obs = makeObservation("safety_verdict", {
      passed: true,
      gates: ["bad", { name: "lint", passed: true }, 42],
      failed_gates: ["x", 7],
    });
    const verdict = readVerdict(obs);
    expect(verdict?.gates).toEqual([{ name: "lint", passed: true }]);
    expect(verdict?.failedGates).toEqual(["x"]);
  });
});

function makeAgentCall(
  type: string,
  input: Record<string, unknown> | null,
  output: Record<string, unknown> | null,
): AgentCallLike {
  return { type, input, output };
}

describe("readAgentCall", () => {
  it("reads step from input and spend/blobs from output", () => {
    const obs = makeAgentCall(
      "agent_call",
      { step: "implement", prompt_blob: "prompts/abc" },
      {
        outcome: "ok",
        summary: "Implemented the feature.",
        cost_usd: 0.42,
        tokens_in: 1200,
        tokens_out: 340,
        cache_read_tokens: 800,
        cache_creation_tokens: 150,
        result_blob: "results/def",
        transcript_blob: "transcripts/ghi",
      },
    );

    expect(readAgentCall(obs)).toEqual({
      step: "implement",
      outcome: "ok",
      summary: "Implemented the feature.",
      costUsd: 0.42,
      tokensIn: 1200,
      tokensOut: 340,
      cacheReadTokens: 800,
      cacheCreationTokens: 150,
      promptBlob: "prompts/abc",
      resultBlob: "results/def",
      transcriptBlob: "transcripts/ghi",
    });
  });

  it("defaults cache-write tokens to 0 when an older span omits cache_creation_tokens", () => {
    const obs = makeAgentCall("agent_call", { step: "gather" }, { outcome: "ok", cache_read_tokens: 500 });
    expect(readAgentCall(obs)?.cacheCreationTokens).toBe(0);
  });

  it("returns null for a non-agent observation", () => {
    expect(readAgentCall(makeAgentCall("tool_execution", { step: "x" }, null))).toBeNull();
  });

  it("never reads cost from metadata — a missing cost is null, never inferred 0", () => {
    const obs = makeAgentCall("agent_call", { step: "verify" }, { outcome: "ok" });
    const call = readAgentCall(obs);
    expect(call?.costUsd).toBeNull();
    expect(call?.tokensIn).toBe(0);
    expect(call?.tokensOut).toBe(0);
  });

  it("falls back to the observe()-path input when output is absent", () => {
    const obs = makeAgentCall("agent_call", { step: "design", cost_usd: 0.1, tokens_in: 50 }, null);
    const call = readAgentCall(obs);
    expect(call?.step).toBe("design");
    expect(call?.costUsd).toBe(0.1);
    expect(call?.tokensIn).toBe(50);
  });

  it("accepts the input_tokens/output_tokens token aliases", () => {
    const obs = makeAgentCall("agent_call", { step: "implement" }, { input_tokens: 10, output_tokens: 20 });
    const call = readAgentCall(obs);
    expect(call?.tokensIn).toBe(10);
    expect(call?.tokensOut).toBe(20);
  });
});

describe("readAgentActivity", () => {
  it("narrows an assistant_text row", () => {
    const obs = makeObservation("agent_activity", { kind: "assistant_text", text: "Reading the file." });
    const activity = readAgentActivity(obs);
    expect(activity?.kind).toBe("assistant_text");
    expect(activity?.text).toBe("Reading the file.");
    expect(activity?.truncated).toBe(false);
    expect(activity?.textBlob).toBe("");
  });

  it("narrows a thinking row and its full-text blob when truncated", () => {
    const obs = makeObservation("agent_activity", {
      kind: "thinking",
      text: "Let me consider…",
      truncated: true,
      text_blob: "blobs/think",
    });
    const activity = readAgentActivity(obs);
    expect(activity?.kind).toBe("thinking");
    expect(activity?.truncated).toBe(true);
    expect(activity?.textBlob).toBe("blobs/think");
  });

  it("narrows a tool_use row with its tool name, input, and pairing id", () => {
    const obs = makeObservation("agent_activity", {
      kind: "tool_use",
      tool_call_id: "call-1",
      name: "Bash",
      input: "ls -la",
    });
    const activity = readAgentActivity(obs);
    expect(activity?.kind).toBe("tool_use");
    expect(activity?.toolName).toBe("Bash");
    expect(activity?.name).toBe("Bash");
    expect(activity?.toolCallId).toBe("call-1");
    expect(activity?.input).toBe("ls -la");
  });

  it("narrows a tool_result row with status and output, paired by tool_call_id", () => {
    const obs = makeObservation("agent_activity", {
      kind: "tool_result",
      tool_call_id: "call-1",
      status: "error",
      output: "command not found",
      truncated: true,
      output_blob: "blobs/out",
    });
    const activity = readAgentActivity(obs);
    expect(activity?.kind).toBe("tool_result");
    expect(activity?.toolCallId).toBe("call-1");
    expect(activity?.status).toBe("error");
    expect(activity?.output).toBe("command not found");
    expect(activity?.outputBlob).toBe("blobs/out");
  });

  it("narrows a session row carrying the model", () => {
    const obs = makeObservation("agent_activity", { kind: "session", model: "claude-opus", tools: 12, cwd: "/repo" });
    const activity = readAgentActivity(obs);
    expect(activity?.kind).toBe("session");
    expect(activity?.model).toBe("claude-opus");
  });

  it("treats an unknown status as null rather than passing it through", () => {
    const obs = makeObservation("agent_activity", { kind: "tool_result", tool_call_id: "x", status: "weird" });
    expect(readAgentActivity(obs)?.status).toBeNull();
  });

  it("returns null for a non-activity observation", () => {
    expect(readAgentActivity(makeObservation("agent_call", { step: "implement" }))).toBeNull();
  });

  it("returns null when input is null", () => {
    expect(readAgentActivity(makeObservation("agent_activity", null))).toBeNull();
  });

  it("returns null when the kind is missing or unrecognized", () => {
    expect(readAgentActivity(makeObservation("agent_activity", { text: "no kind" }))).toBeNull();
    expect(readAgentActivity(makeObservation("agent_activity", { kind: "bogus" }))).toBeNull();
  });

  it("defaults absent string fields to empty rather than throwing", () => {
    const obs = makeObservation("agent_activity", { kind: "tool_use" });
    const activity = readAgentActivity(obs);
    expect(activity?.toolName).toBe("");
    expect(activity?.input).toBe("");
    expect(activity?.toolCallId).toBe("");
  });
});

function makePhaseTransition(name: string, input: Record<string, unknown> | null): PhaseTransitionLike {
  return { name, input };
}

describe("readPhaseTransition", () => {
  it("reads the phase from input.phase, never the name", () => {
    const obs = makePhaseTransition("phase_entered", { phase: "execution" });
    expect(readPhaseTransition(obs)).toEqual({
      event: "phase_entered",
      phase: "execution",
      subPhase: "",
      outcome: "",
      summary: "",
    });
  });

  it("narrows a sub_phase_result with its outcome and summary", () => {
    const obs = makePhaseTransition("sub_phase_result", {
      phase: "review",
      subPhase: "security",
      outcome: "ok",
      summary: "No issues found.",
    });
    expect(readPhaseTransition(obs)).toEqual({
      event: "sub_phase_result",
      phase: "review",
      subPhase: "security",
      outcome: "ok",
      summary: "No issues found.",
    });
  });

  it("marks an unrecognized event name as unknown and defaults absent fields", () => {
    const obs = makePhaseTransition("something_else", null);
    expect(readPhaseTransition(obs)).toEqual({
      event: "unknown",
      phase: "",
      subPhase: "",
      outcome: "",
      summary: "",
    });
  });
});

describe("buildSubPhaseRuns", () => {
  it("reconstructs a phase's ordered runs, leaving the started-without-result one pending", () => {
    const transitions = [
      makePhaseTransition("phase_entered", { phase: "review" }),
      makePhaseTransition("sub_phase_started", { phase: "review", subPhase: "self-review" }),
      makePhaseTransition("sub_phase_result", {
        phase: "review",
        subPhase: "self-review",
        outcome: "ok",
        summary: "Looks good.",
      }),
      makePhaseTransition("sub_phase_started", { phase: "review", subPhase: "security" }),
    ];

    expect(buildSubPhaseRuns(transitions, "review")).toEqual([
      { subPhase: "self-review", outcome: "ok", summary: "Looks good.", status: "ok" },
      { subPhase: "security", outcome: "", summary: "", status: "pending" },
    ]);
  });

  it("marks an error outcome as error", () => {
    const transitions = [
      makePhaseTransition("sub_phase_started", { phase: "execution", subPhase: "verify" }),
      makePhaseTransition("sub_phase_result", {
        phase: "execution",
        subPhase: "verify",
        outcome: "error",
        summary: "A gate failed.",
      }),
    ];

    expect(buildSubPhaseRuns(transitions, "execution")).toEqual([
      { subPhase: "verify", outcome: "error", summary: "A gate failed.", status: "error" },
    ]);
  });

  it("ignores other phases' transitions and bare phase entries", () => {
    const transitions = [
      makePhaseTransition("phase_entered", { phase: "execution" }),
      makePhaseTransition("sub_phase_started", { phase: "execution", subPhase: "implement" }),
      makePhaseTransition("sub_phase_started", { phase: "review", subPhase: "security" }),
    ];

    expect(buildSubPhaseRuns(transitions, "execution")).toEqual([
      { subPhase: "implement", outcome: "", summary: "", status: "pending" },
    ]);
  });
});

// ── step feed (buildStepRuns / buildStepFeed / readGate) ──────────────────────────
//
// The feed reconstructs every sub-phase run across the whole task (LLM and non-LLM) and LOOKS UP each run's
// enriching observations by the run's id: every observation a sub-phase emits carries that run's
// `sub_phase_started` id as its `parent_observation_id` (the Core correlation fix). There is no time-window
// guessing and no same-instant tie-break — ownership is by parentage. The canonical target is the execution
// loop implement → verify → implement → verify: the verify steps must be visible between the implements, each
// owning ONLY the gates/verdict/route that parent on its own run.

/** A fixed-width, lexicographically-orderable timestamp — keeps fixtures readable; ownership is by id, not time. */
function at(tick: number): string {
  return tick.toString().padStart(4, "0");
}

function makeStepObs(
  partial: Partial<StepObservationLike> & Pick<StepObservationLike, "id" | "type" | "name" | "start_time">,
): StepObservationLike {
  return { parent_observation_id: null, phase: "execution", trace_id: "t1", input: null, output: null, ...partial };
}

/**
 * A `phase_transition` row. A `sub_phase_started` gets a deterministic id of `run:<subPhase>:<tick>` — that id
 * is the run's correlation key, so enrichments set `parent_observation_id` to it via {@link runId}.
 */
function transition(
  name: "sub_phase_started" | "sub_phase_result",
  subPhase: string,
  tick: number,
  extra: Record<string, unknown> = {},
  over: Partial<StepObservationLike> = {},
): StepObservationLike {
  return makeStepObs({
    id: name === "sub_phase_started" ? runId(subPhase, tick) : `${name}-${subPhase}-${String(tick)}`,
    type: "phase_transition",
    name,
    start_time: at(tick),
    input: { phase: over.phase ?? "execution", subPhase, ...extra },
    ...over,
  });
}

/** The id a `sub_phase_started` at `(subPhase, tick)` carries — the parent every enrichment of that run sets. */
function runId(subPhase: string, tick: number): string {
  return `run:${subPhase}:${String(tick)}`;
}

describe("buildStepRuns", () => {
  it("reconstructs runs across multiple phases in order, carrying timing/trace and result data", () => {
    const transitions = [
      transition("sub_phase_started", "implement", 1, {}, { phase: "execution", trace_id: "t1" }),
      transition("sub_phase_result", "implement", 2, { outcome: "ok", summary: "Done." }),
      transition("sub_phase_started", "self-review", 3, {}, { phase: "review", trace_id: "t1" }),
      transition(
        "sub_phase_result",
        "self-review",
        4,
        { outcome: "ok", summary: "Clean.", data: { findings: 0 } },
        { phase: "review" },
      ),
    ];

    expect(buildStepRuns(transitions)).toEqual([
      {
        id: runId("implement", 1),
        phase: "execution",
        subPhase: "implement",
        status: "ok",
        outcome: "ok",
        summary: "Done.",
        startTime: "0001",
        traceId: "t1",
        data: null,
      },
      {
        id: runId("self-review", 3),
        phase: "review",
        subPhase: "self-review",
        status: "ok",
        outcome: "ok",
        summary: "Clean.",
        startTime: "0003",
        traceId: "t1",
        data: { findings: 0 },
      },
    ]);
  });

  it("leaves a started-without-result run pending (the step running now), carrying its run id", () => {
    const runs = buildStepRuns([transition("sub_phase_started", "verify", 1)]);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("pending");
    expect(runs[0]?.startTime).toBe("0001");
    expect(runs[0]?.id).toBe(runId("verify", 1));
  });

  it("marks an error outcome as error", () => {
    const runs = buildStepRuns([
      transition("sub_phase_started", "verify", 1),
      transition("sub_phase_result", "verify", 2, { outcome: "error", summary: "A gate failed." }),
    ]);
    expect(runs[0]?.status).toBe("error");
  });

  it("emits a result with no matching start as its own resolved run (empty id — it owns no enrichments)", () => {
    const runs = buildStepRuns([transition("sub_phase_result", "push", 1, { outcome: "ok", summary: "Pushed." })]);
    expect(runs).toEqual([
      {
        id: "",
        phase: "execution",
        subPhase: "push",
        status: "ok",
        outcome: "ok",
        summary: "Pushed.",
        startTime: "0001",
        traceId: "t1",
        data: null,
      },
    ]);
  });
});

describe("buildStepFeed", () => {
  // The canonical execution loop: implement → verify(repeat) → implement → verify(advance). Every enrichment
  // sets `parent_observation_id` to its owning run's id (runId(subPhase, startTick)) — that parentage is the
  // only thing the feed groups on. Timestamps are incidental.
  function enrichment(
    over: Partial<StepObservationLike> & Pick<StepObservationLike, "id" | "type" | "name">,
    parent: string,
  ): StepObservationLike {
    return makeStepObs({ start_time: at(1), parent_observation_id: parent, ...over });
  }
  function loopTransitions(): StepObservationLike[] {
    return [
      transition("sub_phase_started", "implement", 1),
      transition("sub_phase_result", "implement", 3, { outcome: "ok", summary: "First pass." }),
      transition("sub_phase_started", "verify", 4),
      transition("sub_phase_result", "verify", 7, { outcome: "ok", summary: "Gates failed.", data: { passed: false } }),
      transition("sub_phase_started", "implement", 8),
      transition("sub_phase_result", "implement", 9, { outcome: "ok", summary: "Second pass." }),
      transition("sub_phase_started", "verify", 10),
      transition("sub_phase_result", "verify", 13, { outcome: "ok", summary: "Gates passed.", data: { passed: true } }),
    ];
  }
  // ac1/ac2 parent on the two implement runs; the verdicts and gates on the two verify runs.
  const agentCalls = [
    enrichment(
      { id: "ac1", type: "agent_call", name: "implement", input: { step: "implement" } },
      runId("implement", 1),
    ),
    enrichment(
      { id: "ac2", type: "agent_call", name: "implement", input: { step: "implement" } },
      runId("implement", 8),
    ),
  ];
  const verdicts = [
    enrichment(
      { id: "v1", type: "safety_verdict", name: "verify_gates", input: { passed: false } },
      runId("verify", 4),
    ),
    enrichment(
      { id: "v2", type: "safety_verdict", name: "verify_gates", input: { passed: true } },
      runId("verify", 10),
    ),
  ];
  const tools = [
    enrichment(
      { id: "lint1", type: "tool_execution", name: "gate:lint", output: { passed: false } },
      runId("verify", 4),
    ),
    enrichment(
      { id: "test1", type: "tool_execution", name: "gate:test", output: { passed: true } },
      runId("verify", 4),
    ),
    enrichment(
      { id: "lint2", type: "tool_execution", name: "gate:lint", output: { passed: true } },
      runId("verify", 10),
    ),
    enrichment(
      { id: "test2", type: "tool_execution", name: "gate:test", output: { passed: true } },
      runId("verify", 10),
    ),
  ];
  // Each closing route:/loop_ decision parents on the run that MADE it — exactly what the same-millisecond
  // tie-break used to chase by timing. route:implement → the implement run; route:verify/loop_repeat → verify.
  const decisions = [
    enrichment(
      { id: "ri1", type: "decision_point", name: "route:implement", input: { chosen: "advance" } },
      runId("implement", 1),
    ),
    enrichment(
      { id: "rv1", type: "decision_point", name: "route:verify", input: { chosen: "repeat" } },
      runId("verify", 4),
    ),
    enrichment({ id: "lr1", type: "decision_point", name: "loop_repeat", input: { count: 1 } }, runId("verify", 4)),
    enrichment(
      { id: "ri2", type: "decision_point", name: "route:implement", input: { chosen: "advance" } },
      runId("implement", 8),
    ),
    enrichment(
      { id: "rv2", type: "decision_point", name: "route:verify", input: { chosen: "advance" } },
      runId("verify", 10),
    ),
  ];

  it("emits the verify steps between the implements, in true executed order", () => {
    const feed = buildStepFeed(loopTransitions(), agentCalls, verdicts, tools, decisions);
    expect(feed.map((step) => step.subPhase)).toEqual(["implement", "verify", "implement", "verify"]);
    expect(feed.map((step) => step.kind)).toEqual(["llm", "nonllm", "llm", "nonllm"]);
  });

  it("attaches each implement's own agent_call by parentage and nothing it does not own", () => {
    const feed = buildStepFeed(loopTransitions(), agentCalls, verdicts, tools, decisions);
    expect(feed[0]?.agentCall?.id).toBe("ac1");
    expect(feed[2]?.agentCall?.id).toBe("ac2");
    expect(feed[0]?.verdict).toBeNull();
    expect(feed[0]?.tools).toEqual([]);
  });

  it("gives each verify only the gates and verdict that parent on its run", () => {
    const feed = buildStepFeed(loopTransitions(), agentCalls, verdicts, tools, decisions);
    expect(feed[1]?.agentCall).toBeNull();
    expect(feed[1]?.verdict?.id).toBe("v1");
    expect(feed[1]?.tools.map((tool) => tool.id)).toEqual(["lint1", "test1"]);
    expect(feed[3]?.verdict?.id).toBe("v2");
    expect(feed[3]?.tools.map((tool) => tool.id)).toEqual(["lint2", "test2"]);
  });

  it("carries each verify's own routing decision — first repeat (the loop), then advance", () => {
    const feed = buildStepFeed(loopTransitions(), agentCalls, verdicts, tools, decisions);
    const firstRoute = feed[1]?.decisions.find((d) => d.name === "route:verify");
    const secondRoute = feed[3]?.decisions.find((d) => d.name === "route:verify");
    expect(firstRoute?.input?.["chosen"]).toBe("repeat");
    expect(secondRoute?.input?.["chosen"]).toBe("advance");
    // The loop counter sits under the verify that drove the loop (it parents on that run), not the next step.
    expect(feed[1]?.decisions.some((d) => d.name === "loop_repeat")).toBe(true);
    expect(feed[3]?.decisions.some((d) => d.name === "loop_repeat")).toBe(false);
  });

  it("groups a closing route:/loop_ by parentage even when it shares the next run's start instant", () => {
    // The real runner emits route:implement in the SAME millisecond the next sub-phase (verify) starts. With id
    // grouping there is no tie-break to tune: each decision parents on the run that made it, so it lands there
    // regardless of timestamps. (This replaces the old same-instant route and loop tie-break tests.)
    const transitions = [
      transition("sub_phase_started", "implement", 1),
      transition("sub_phase_result", "implement", 3, { outcome: "ok", summary: "Done." }),
      transition("sub_phase_started", "verify", 3),
      transition("sub_phase_result", "verify", 3, { outcome: "ok", summary: "ok", data: { passed: false } }),
      transition("sub_phase_started", "implement", 3),
    ];
    // Both closing decisions and an opening agent_call all share the instant at(3) — yet parentage is exact.
    const calls = [
      enrichment(
        { id: "ac", type: "agent_call", name: "implement", input: { step: "implement" } },
        runId("implement", 1),
      ),
    ];
    const sameInstantDecisions = [
      enrichment(
        { id: "ri", type: "decision_point", name: "route:implement", input: { chosen: "advance" } },
        runId("implement", 1),
      ),
      enrichment({ id: "lr", type: "decision_point", name: "loop_repeat", input: { count: 1 } }, runId("verify", 3)),
    ];
    const feed = buildStepFeed(transitions, calls, [], [], sameInstantDecisions);
    expect(feed.map((step) => step.subPhase)).toEqual(["implement", "verify", "implement"]);
    expect(feed[0]?.agentCall?.id).toBe("ac"); // the agent_call lands on its own implement run
    expect(feed[0]?.decisions.map((d) => d.id)).toEqual(["ri"]); // route:implement stays with implement
    expect(feed[1]?.decisions.map((d) => d.id)).toEqual(["lr"]); // loop_repeat stays with the verify that drove it
    expect(feed[2]?.decisions).toEqual([]); // the re-entered implement claims neither
  });

  it("ignores skip: decisions and any observation that parents on a different run", () => {
    const transitions = [
      transition("sub_phase_started", "verify", 1),
      transition("sub_phase_result", "verify", 5, { outcome: "ok", summary: "ok", data: { passed: true } }),
    ];
    const otherRun = [
      enrichment(
        { id: "v-other", type: "safety_verdict", name: "verify_gates", input: { passed: true } },
        "run:elsewhere:99",
      ),
    ];
    const mixedDecisions = [
      enrichment(
        { id: "skip", type: "decision_point", name: "skip:research", input: { chosen: "skip" } },
        runId("verify", 1),
      ),
      enrichment(
        { id: "route", type: "decision_point", name: "route:verify", input: { chosen: "advance" } },
        runId("verify", 1),
      ),
    ];
    const feed = buildStepFeed(transitions, [], otherRun, [], mixedDecisions);
    expect(feed[0]?.verdict).toBeNull(); // the verdict parenting on another run does not attach
    expect(feed[0]?.decisions.map((d) => d.id)).toEqual(["route"]); // skip: is dropped, route: kept
  });

  it("attaches nothing to a result-only run (empty id owns no enrichments)", () => {
    // A result with no start in the window has an empty id; an enrichment parenting on a real run must not bleed
    // onto it (an empty parent_observation_id would otherwise spuriously match an empty run id).
    const transitions = [transition("sub_phase_result", "push", 1, { outcome: "ok", summary: "Pushed." })];
    const strays = [enrichment({ id: "t", type: "tool_execution", name: "git_push", output: {} }, "")];
    const feed = buildStepFeed(transitions, [], [], strays, []);
    expect(feed[0]?.id).toBe("");
    expect(feed[0]?.tools).toEqual([]);
  });

  // ── block → resume (Part 3) ────────────────────────────────────────────────────
  // An autonomy block leaves the run with a `task_blocked` state_transition and (for an autonomy escalation) an
  // `autonomy_policy` decision, both parenting on the run's id. The feed surfaces them as the step's `block` so
  // the tab renders an explained marker between the blocked step and the resume step — the exact "implement,
  // implement with nothing between" gap issue #27 set out to eliminate.
  describe("block / resume", () => {
    // implement (blocks on autonomy) → resume → implement again.
    const transitions = [
      transition("sub_phase_started", "implement", 1),
      transition("sub_phase_result", "implement", 2, { outcome: "ok", summary: "Touched 6 files." }),
      transition("sub_phase_started", "implement", 5),
      transition("sub_phase_result", "implement", 6, { outcome: "ok", summary: "Done." }),
    ];
    const stateTransitions = [
      enrichment(
        {
          id: "blk",
          type: "state_transition",
          name: "task_blocked",
          input: { category: "awaiting_human_decision", sub_phase: "implement", needed: "Confirm the 6-file scope?" },
        },
        runId("implement", 1),
      ),
    ];
    const policyDecision = enrichment(
      {
        id: "pol",
        type: "decision_point",
        name: "autonomy_policy",
        input: { chosen: "ask_human", reasoning: "scope_expansion over threshold (6 > 5)" },
      },
      runId("implement", 1),
    );

    it("attaches the block (transition + autonomy_policy) to the run that blocked, by parentage", () => {
      const feed = buildStepFeed(transitions, [], [], [], [policyDecision], stateTransitions);
      expect(feed[0]?.block?.transition.id).toBe("blk");
      expect(feed[0]?.block?.policy?.id).toBe("pol");
      // The resumed implement did not block, so it carries no marker.
      expect(feed[1]?.block).toBeNull();
    });

    it("leaves block null for a run that did not block", () => {
      const feed = buildStepFeed(transitions, [], [], [], [], []);
      expect(feed[0]?.block).toBeNull();
      expect(feed[1]?.block).toBeNull();
    });

    it("surfaces the block without an autonomy_policy decision (a non-autonomy block)", () => {
      const feed = buildStepFeed(transitions, [], [], [], [], stateTransitions);
      expect(feed[0]?.block?.transition.id).toBe("blk");
      expect(feed[0]?.block?.policy).toBeNull();
    });
  });
});

describe("readGate", () => {
  it("narrows a gate: tool_execution, stripping the prefix and reading pass/output", () => {
    const obs = { type: "tool_execution", name: "gate:lint", output: { passed: false, output: "1 error" } };
    expect(readGate(obs)).toEqual({ name: "lint", passed: false, output: "1 error" });
  });

  it("treats a missing pass flag as not-passed and a missing output as empty", () => {
    const obs = { type: "tool_execution", name: "gate:typecheck", output: null };
    expect(readGate(obs)).toEqual({ name: "typecheck", passed: false, output: "" });
  });

  it("returns null for a non-gate tool_execution and for a non-tool observation", () => {
    expect(readGate({ type: "tool_execution", name: "git_push", output: { pushed: true } })).toBeNull();
    expect(readGate({ type: "safety_verdict", name: "gate:lint", output: { passed: true } })).toBeNull();
  });
});

describe("readBlock", () => {
  it("narrows a task_blocked state_transition into its category, sub-phase, and needed step", () => {
    const obs = {
      type: "state_transition",
      name: "task_blocked",
      input: { category: "awaiting_human_decision", sub_phase: "implement", needed: "Confirm the 6-file scope?" },
    };
    expect(readBlock(obs)).toEqual({
      category: "awaiting_human_decision",
      subPhase: "implement",
      needed: "Confirm the 6-file scope?",
    });
  });

  it("returns empty strings for absent fields rather than throwing", () => {
    expect(readBlock({ type: "state_transition", name: "task_blocked", input: null })).toEqual({
      category: "",
      subPhase: "",
      needed: "",
    });
  });

  it("returns null for a non-block state_transition and for a non-transition observation", () => {
    expect(readBlock({ type: "state_transition", name: "cost_window_rolled_over", input: {} })).toBeNull();
    expect(readBlock({ type: "decision_point", name: "task_blocked", input: {} })).toBeNull();
  });
});
