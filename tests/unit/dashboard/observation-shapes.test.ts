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
      promptBlob: "prompts/abc",
      resultBlob: "results/def",
      transcriptBlob: "transcripts/ghi",
    });
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
// The feed reconstructs every sub-phase run across the whole task (LLM and non-LLM) and correlates each run's
// enriching observations to it by (phase, trace_id) + the half-open time window [run.start, nextRun.start).
// The canonical target is the execution loop implement → verify → implement → verify: the verify steps must be
// visible between the implements, each owning ONLY its own gates/verdict/route — that is the bug this fixes.

/** A fixed-width, lexicographically-orderable timestamp — string `<`/`>=` then matches the real store order. */
function at(tick: number): string {
  return tick.toString().padStart(4, "0");
}

function makeStepObs(
  partial: Partial<StepObservationLike> & Pick<StepObservationLike, "id" | "type" | "name" | "start_time">,
): StepObservationLike {
  return { phase: "execution", trace_id: "t1", input: null, output: null, ...partial };
}

function transition(
  name: "sub_phase_started" | "sub_phase_result",
  subPhase: string,
  tick: number,
  extra: Record<string, unknown> = {},
  over: Partial<StepObservationLike> = {},
): StepObservationLike {
  return makeStepObs({
    id: `${name}-${subPhase}-${String(tick)}`,
    type: "phase_transition",
    name,
    start_time: at(tick),
    input: { phase: over.phase ?? "execution", subPhase, ...extra },
    ...over,
  });
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

  it("leaves a started-without-result run pending (the step running now)", () => {
    const runs = buildStepRuns([transition("sub_phase_started", "verify", 1)]);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("pending");
    expect(runs[0]?.startTime).toBe("0001");
  });

  it("marks an error outcome as error", () => {
    const runs = buildStepRuns([
      transition("sub_phase_started", "verify", 1),
      transition("sub_phase_result", "verify", 2, { outcome: "error", summary: "A gate failed." }),
    ]);
    expect(runs[0]?.status).toBe("error");
  });

  it("emits a result with no matching start as its own resolved run rather than dropping it", () => {
    const runs = buildStepRuns([transition("sub_phase_result", "push", 1, { outcome: "ok", summary: "Pushed." })]);
    expect(runs).toEqual([
      {
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
  // The canonical execution loop: implement → verify(repeat) → implement → verify(advance).
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
  const agentCalls = [
    makeStepObs({ id: "ac1", type: "agent_call", name: "implement", start_time: at(1), input: { step: "implement" } }),
    makeStepObs({ id: "ac2", type: "agent_call", name: "implement", start_time: at(8), input: { step: "implement" } }),
  ];
  const verdicts = [
    makeStepObs({
      id: "v1",
      type: "safety_verdict",
      name: "verify_gates",
      start_time: at(6),
      input: { passed: false },
    }),
    makeStepObs({
      id: "v2",
      type: "safety_verdict",
      name: "verify_gates",
      start_time: at(12),
      input: { passed: true },
    }),
  ];
  const tools = [
    makeStepObs({
      id: "lint1",
      type: "tool_execution",
      name: "gate:lint",
      start_time: at(5),
      output: { passed: false },
    }),
    makeStepObs({
      id: "test1",
      type: "tool_execution",
      name: "gate:test",
      start_time: at(5),
      output: { passed: true },
    }),
    makeStepObs({
      id: "lint2",
      type: "tool_execution",
      name: "gate:lint",
      start_time: at(11),
      output: { passed: true },
    }),
    makeStepObs({
      id: "test2",
      type: "tool_execution",
      name: "gate:test",
      start_time: at(11),
      output: { passed: true },
    }),
  ];
  const decisions = [
    makeStepObs({
      id: "ri1",
      type: "decision_point",
      name: "route:implement",
      start_time: at(3),
      input: { chosen: "advance" },
    }),
    makeStepObs({
      id: "rv1",
      type: "decision_point",
      name: "route:verify",
      start_time: at(7),
      input: { chosen: "repeat" },
    }),
    makeStepObs({ id: "lr1", type: "decision_point", name: "loop_repeat", start_time: at(7), input: { count: 1 } }),
    makeStepObs({
      id: "ri2",
      type: "decision_point",
      name: "route:implement",
      start_time: at(9),
      input: { chosen: "advance" },
    }),
    makeStepObs({
      id: "rv2",
      type: "decision_point",
      name: "route:verify",
      start_time: at(13),
      input: { chosen: "advance" },
    }),
  ];

  it("emits the verify steps between the implements, in true executed order", () => {
    const feed = buildStepFeed(loopTransitions(), agentCalls, verdicts, tools, decisions);
    expect(feed.map((step) => step.subPhase)).toEqual(["implement", "verify", "implement", "verify"]);
    expect(feed.map((step) => step.kind)).toEqual(["llm", "nonllm", "llm", "nonllm"]);
  });

  it("attaches each implement's own agent_call and nothing it does not own", () => {
    const feed = buildStepFeed(loopTransitions(), agentCalls, verdicts, tools, decisions);
    expect(feed[0]?.agentCall?.id).toBe("ac1");
    expect(feed[2]?.agentCall?.id).toBe("ac2");
    expect(feed[0]?.verdict).toBeNull();
    expect(feed[0]?.tools).toEqual([]);
  });

  it("gives each verify only its own gates and verdict", () => {
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
    // The loop counter sits under the verify that drove the loop, not the next step.
    expect(feed[1]?.decisions.some((d) => d.name === "loop_repeat")).toBe(true);
    expect(feed[3]?.decisions.some((d) => d.name === "loop_repeat")).toBe(false);
  });

  it("attaches an agent_call sharing its sub_phase_started's instant to its own run, not the previous one", () => {
    const transitions = [
      transition("sub_phase_started", "verify", 1),
      transition("sub_phase_result", "verify", 2, { outcome: "ok", summary: "ok", data: { passed: true } }),
      transition("sub_phase_started", "implement", 3),
    ];
    // The agent_call opens in the same millisecond the runner recorded the sub_phase_started.
    const sameInstant = [
      makeStepObs({ id: "ac", type: "agent_call", name: "implement", start_time: at(3), input: { step: "implement" } }),
    ];
    const feed = buildStepFeed(transitions, sameInstant, [], [], []);
    expect(feed[0]?.subPhase).toBe("verify");
    expect(feed[0]?.agentCall).toBeNull(); // the inclusive lower bound keeps it OUT of the prior verify run
    expect(feed[1]?.subPhase).toBe("implement");
    expect(feed[1]?.agentCall?.id).toBe("ac"); // and IN its own implement run
  });

  it("attributes a route:<prev> sharing the next run's start instant to the prev step, not the next", () => {
    // The real runner emits route:implement in the SAME millisecond the next sub-phase (verify) starts — the
    // closing decision and the next sub_phase_started share an instant. The window's inclusive lower bound would
    // hand it to verify; by name it belongs to implement, and verify must show only its own route.
    const transitions = [
      transition("sub_phase_started", "implement", 1),
      transition("sub_phase_result", "implement", 3, { outcome: "ok", summary: "Done." }),
      transition("sub_phase_started", "verify", 3),
      transition("sub_phase_result", "verify", 5, { outcome: "ok", summary: "ok", data: { passed: true } }),
    ];
    const agentCalls = [
      makeStepObs({ id: "ac", type: "agent_call", name: "implement", start_time: at(1), input: { step: "implement" } }),
    ];
    const decisions = [
      makeStepObs({
        id: "ri",
        type: "decision_point",
        name: "route:implement",
        start_time: at(3),
        input: { chosen: "advance" },
      }),
      makeStepObs({
        id: "rv",
        type: "decision_point",
        name: "route:verify",
        start_time: at(5),
        input: { chosen: "advance" },
      }),
    ];
    const feed = buildStepFeed(transitions, agentCalls, [], [], decisions);
    expect(feed.map((step) => step.subPhase)).toEqual(["implement", "verify"]);
    expect(feed[0]?.decisions.map((d) => d.id)).toEqual(["ri"]); // route:implement stays with implement…
    expect(feed[1]?.decisions.map((d) => d.id)).toEqual(["rv"]); // …and never leaks onto verify's start instant
  });

  it("keeps a loop_* decision on the run that closed, not the next run opening on the same instant", () => {
    // verify fails and loops back: loop_repeat fires as the next implement starts, sharing its instant. The loop
    // belongs to the verify that drove it, never the re-entered implement.
    const transitions = [
      transition("sub_phase_started", "verify", 1),
      transition("sub_phase_result", "verify", 3, { outcome: "ok", summary: "Gates failed.", data: { passed: false } }),
      transition("sub_phase_started", "implement", 3),
    ];
    const decisions = [
      makeStepObs({ id: "lr", type: "decision_point", name: "loop_repeat", start_time: at(3), input: { count: 1 } }),
    ];
    const feed = buildStepFeed(transitions, [], [], [], decisions);
    expect(feed[0]?.subPhase).toBe("verify");
    expect(feed[0]?.decisions.map((d) => d.id)).toEqual(["lr"]); // the loop sits under verify…
    expect(feed[1]?.decisions).toEqual([]); // …not the implement it looped back to
  });

  it("ignores skip: decisions and observations from a different trace", () => {
    const transitions = [
      transition("sub_phase_started", "verify", 1),
      transition("sub_phase_result", "verify", 5, { outcome: "ok", summary: "ok", data: { passed: true } }),
    ];
    const otherTrace = [
      makeStepObs({
        id: "v-other",
        type: "safety_verdict",
        name: "verify_gates",
        start_time: at(2),
        input: { passed: true },
        trace_id: "t2",
      }),
    ];
    const mixedDecisions = [
      makeStepObs({
        id: "skip",
        type: "decision_point",
        name: "skip:research",
        start_time: at(2),
        input: { chosen: "skip" },
      }),
      makeStepObs({
        id: "route",
        type: "decision_point",
        name: "route:verify",
        start_time: at(2),
        input: { chosen: "advance" },
      }),
    ];
    const feed = buildStepFeed(transitions, [], otherTrace, [], mixedDecisions);
    expect(feed[0]?.verdict).toBeNull(); // the other-trace verdict does not attach
    expect(feed[0]?.decisions.map((d) => d.id)).toEqual(["route"]); // skip: is dropped, route: kept
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
