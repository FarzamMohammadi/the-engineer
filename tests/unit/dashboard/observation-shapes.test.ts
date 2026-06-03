import { describe, expect, it } from "vitest";

import {
  type AgentCallLike,
  type ObservationLike,
  type PhaseTransitionLike,
  buildSubPhaseRuns,
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
