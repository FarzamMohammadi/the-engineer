import { describe, expect, it } from "vitest";

import {
  type AgentCallLike,
  type ObservationLike,
  type PhaseTransitionLike,
  buildSubPhaseRuns,
  readAgentActivity,
  readAgentCall,
  readDecision,
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
