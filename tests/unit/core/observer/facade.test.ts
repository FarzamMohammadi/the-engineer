import { describe, expect, it } from "vitest";

import { type Observer, createObserverFacade } from "../../../../src/core/observer/facade.js";
import type { IObservationStore, ObservationSpan } from "../../../../src/core/observer/types.js";
import type { Observation, ObservationTypeValue, SpanOptions } from "../../../../src/schemas/observer.js";
import { createTestObserverFacade } from "../../../helpers/test-observer-facade.js";

// ── Stub observation store ─────────────────────────────────────────────────

interface CapturedSpan {
  type: ObservationTypeValue;
  name: string;
  input: Record<string, unknown> | undefined;
  options: SpanOptions | undefined;
}

function createCapturingStore(): { store: IObservationStore; spans: CapturedSpan[] } {
  const spans: CapturedSpan[] = [];
  const makeSpan = (id: string): ObservationSpan => ({
    id,
    end: () => {},
    startChild: () => makeSpan(`${id}-child`),
    addEvent: () => {},
    setError: () => {},
  });
  const store: IObservationStore = {
    startSpan(type, name, input, options) {
      spans.push({ type, name, input, options });
      return makeSpan("span-1");
    },
    observe(type, name, data, options) {
      spans.push({ type, name, input: data, options });
      return "obs-1";
    },
    recordDecision(name, context, _options, chosen, reasoning, confidence, opts) {
      spans.push({
        type: "decision_point",
        name,
        input: { context, chosen, reasoning, confidence },
        options: opts,
      });
      return "dec-1";
    },
    recordError(_error, context, _recovery, opts) {
      spans.push({
        type: "error",
        name: context.operation,
        input: { component: context.component },
        options: opts,
      });
      return "err-1";
    },
    query: (): Observation[] => [],
    subscribe: () => () => {},
    storeBlob: () => "",
    readBlob: () => null,
  };
  return { store, spans };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("Observer.withTrace", () => {
  it("returns a new observer that does not mutate the parent", () => {
    const parent = createTestObserverFacade("orchestrator");
    const traced = parent.withTrace("trace-abc");
    expect(traced).not.toBe(parent);
  });

  it("injects trace_id into startSpan calls", () => {
    const { store, spans } = createCapturingStore();
    const observer = createObserverFacade(createTestObserverFacade("orchestrator").pino, "orchestrator");
    (observer as Observer).upgrade(store);

    observer.withTrace("trace-xyz").startSpan("phase_transition", "execute", { foo: "bar" });

    expect(spans).toHaveLength(1);
    expect(spans[0]?.options?.trace_id).toBe("trace-xyz");
  });

  it("preserves explicit trace_id in SpanOptions over the bound one", () => {
    const { store, spans } = createCapturingStore();
    const observer = createObserverFacade(createTestObserverFacade("orchestrator").pino, "orchestrator");
    (observer as Observer).upgrade(store);

    observer.withTrace("bound-trace").observe("lifecycle", "event", {}, { trace_id: "explicit-trace" });

    expect(spans[0]?.options?.trace_id).toBe("explicit-trace");
  });

  it("threads trace_id into recordDecision and recordError", () => {
    const { store, spans } = createCapturingStore();
    const observer = createObserverFacade(createTestObserverFacade("orchestrator").pino, "orchestrator");
    (observer as Observer).upgrade(store);

    const traced = observer.withTrace("trace-q");
    traced.recordDecision("name", "ctx", [{ id: "a", description: "a" }], "a", "because", 0.9);
    traced.recordError(new Error("boom"), { operation: "op", component: "orchestrator" });

    expect(spans).toHaveLength(2);
    expect(spans[0]?.options?.trace_id).toBe("trace-q");
    expect(spans[1]?.options?.trace_id).toBe("trace-q");
  });

  it("child() of a traced observer keeps the trace_id bound", () => {
    const { store, spans } = createCapturingStore();
    const observer = createObserverFacade(createTestObserverFacade("orchestrator").pino, "orchestrator");
    (observer as Observer).upgrade(store);

    observer.withTrace("trace-deep").child("pr-manager").observe("lifecycle", "x", {});

    expect(spans[0]?.options?.trace_id).toBe("trace-deep");
  });
});
