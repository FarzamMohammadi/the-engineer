import { describe, expect, it } from "vitest";

import {
  type ObservationLike,
  readDecision,
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
