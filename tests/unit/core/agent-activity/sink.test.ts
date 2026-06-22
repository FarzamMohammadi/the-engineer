import { describe, expect, it, vi } from "vitest";

import { createActivitySink } from "../../../../src/core/agent-activity/index.js";
import type { IObserver } from "../../../../src/core/observer/index.js";
import type { SpanOptions } from "../../../../src/schemas/observer.js";

// ── Fake observer ────────────────────────────────────────────────────────────────

interface ObserveCall {
  readonly type: string;
  readonly name: string;
  readonly data: Record<string, unknown>;
  readonly options: SpanOptions | undefined;
}

interface FakeObserver {
  readonly observer: IObserver;
  readonly observes: ObserveCall[];
  readonly blobs: string[];
  readonly debugs: string[];
}

/** A fake observer capturing observe (with options), storeBlob, and debug — the sink's whole surface. */
function fakeObserver(overrides: Partial<IObserver> = {}): FakeObserver {
  const observes: ObserveCall[] = [];
  const blobs: string[] = [];
  const debugs: string[] = [];

  const observer = {
    observe: (type: string, name: string, data: Record<string, unknown>, options?: SpanOptions) => {
      observes.push({ type, name, data, options });
      return "obs-id";
    },
    storeBlob: (content: string) => {
      blobs.push(content);
      return `blob-${blobs.length}`;
    },
    debug: (msg: string) => {
      debugs.push(msg);
    },
    ...overrides,
  } as unknown as IObserver;

  return { observer, observes, blobs, debugs };
}

const SCOPE: SpanOptions = { task_id: "task-1", session_id: "s-1", trace_id: "t-1", phase: "execution" };

describe("createActivitySink", () => {
  it("writes an agent_activity observation nested under the agent_call span", () => {
    const fake = fakeObserver();
    const sink = createActivitySink(fake.observer, SCOPE, "span-1");

    sink({ kind: "assistant_text", text: "hello" });

    expect(fake.observes).toHaveLength(1);
    const call = fake.observes[0];
    expect(call?.type).toBe("agent_activity");
    expect(call?.name).toBe("assistant_text");
    expect(call?.data).toMatchObject({ kind: "assistant_text", text: "hello" });
  });

  it("threads the trace scope and parents every activity on the agent_call span", () => {
    const fake = fakeObserver();
    const sink = createActivitySink(fake.observer, SCOPE, "span-1");

    sink({ kind: "thinking", text: "considering" });

    expect(fake.observes[0]?.options).toEqual({
      task_id: "task-1",
      session_id: "s-1",
      trace_id: "t-1",
      phase: "execution",
      parent_observation_id: "span-1",
    });
  });

  it("names a tool_use observation after the tool", () => {
    const fake = fakeObserver();
    const sink = createActivitySink(fake.observer, SCOPE, "span-1");

    sink({ kind: "tool_use", tool_call_id: "c1", name: "write_file", input: { path: "a.ts" } });

    expect(fake.observes[0]?.name).toBe("write_file");
    expect(fake.observes[0]?.data).toMatchObject({ kind: "tool_use", tool_call_id: "c1" });
  });

  it("offloads a large payload to a blob and references it in the observation data", () => {
    const fake = fakeObserver();
    const sink = createActivitySink(fake.observer, SCOPE, "span-1");

    sink({ kind: "assistant_text", text: "w".repeat(2000) });

    expect(fake.blobs).toHaveLength(1);
    expect(fake.observes[0]?.data["text_blob"]).toBe("blob-1");
    expect(fake.observes[0]?.data["truncated"]).toBe(true);
  });

  it("emits nothing extra for a small payload (no blob)", () => {
    const fake = fakeObserver();
    const sink = createActivitySink(fake.observer, SCOPE, "span-1");

    sink({ kind: "assistant_text", text: "tiny" });

    expect(fake.blobs).toHaveLength(0);
    expect(fake.observes[0]?.data["text_blob"]).toBeUndefined();
  });

  // ── Content-less text/thinking is dropped, not recorded (agent-agnostic) ────────

  it("records nothing for a content-less thinking block (an agent withholding its reasoning)", () => {
    const fake = fakeObserver();
    const sink = createActivitySink(fake.observer, SCOPE, "span-1");

    sink({ kind: "thinking", text: "" });
    sink({ kind: "thinking", text: "   \n  " });

    expect(fake.observes).toHaveLength(0);
    expect(fake.debugs).toHaveLength(0);
  });

  it("records nothing for a content-less assistant_text chunk", () => {
    const fake = fakeObserver();
    const sink = createActivitySink(fake.observer, SCOPE, "span-1");

    sink({ kind: "assistant_text", text: "" });

    expect(fake.observes).toHaveLength(0);
  });

  it("still records a thinking block that carries reasoning", () => {
    const fake = fakeObserver();
    const sink = createActivitySink(fake.observer, SCOPE, "span-1");

    sink({ kind: "thinking", text: "weighing the options" });

    expect(fake.observes).toHaveLength(1);
    expect(fake.observes[0]?.data).toMatchObject({ kind: "thinking", text: "weighing the options" });
  });

  it("still records a tool_result with empty output (only text kinds are content-gated)", () => {
    const fake = fakeObserver();
    const sink = createActivitySink(fake.observer, SCOPE, "span-1");

    sink({ kind: "tool_result", tool_call_id: "c", status: "ok", output: "" });

    expect(fake.observes).toHaveLength(1);
    expect(fake.observes[0]?.name).toBe("tool_result");
  });

  // ── Invariant: the sink can never throw into the agent run ──────────────────────

  describe("best-effort: never throws into the run", () => {
    it("swallows a throwing observe and logs a debug instead", () => {
      const debugs: string[] = [];
      const observer = {
        observe: () => {
          throw new Error("store is down");
        },
        storeBlob: () => "blob",
        debug: (msg: string) => debugs.push(msg),
      } as unknown as IObserver;
      const sink = createActivitySink(observer, SCOPE, "span-1");

      expect(() => sink({ kind: "assistant_text", text: "hi" })).not.toThrow();
      expect(debugs).toHaveLength(1);
    });

    it("swallows a throwing storeBlob (large-payload path) without breaking the run", () => {
      const debug = vi.fn();
      const observer = {
        observe: () => "id",
        storeBlob: () => {
          throw new Error("blob disk full");
        },
        debug,
      } as unknown as IObserver;
      const sink = createActivitySink(observer, SCOPE, "span-1");

      expect(() =>
        sink({ kind: "tool_result", tool_call_id: "c", status: "ok", output: "z".repeat(2000) }),
      ).not.toThrow();
      expect(debug).toHaveBeenCalledOnce();
    });

    it("does not let a thrown error escape across many events", () => {
      const observer = {
        observe: () => {
          throw new Error("always fails");
        },
        storeBlob: () => "blob",
        debug: () => undefined,
      } as unknown as IObserver;
      const sink = createActivitySink(observer, SCOPE, "span-1");

      expect(() => {
        sink({ kind: "session", model: "m", tools: 1, cwd: "/" });
        sink({ kind: "thinking", text: "t" });
        sink({ kind: "assistant_text", text: "a" });
      }).not.toThrow();
    });

    it("stays silent even when the debug note itself throws (a fully broken observer)", () => {
      const observer = {
        observe: () => {
          throw new Error("store down");
        },
        storeBlob: () => "blob",
        debug: () => {
          throw new Error("logger down too");
        },
      } as unknown as IObserver;
      const sink = createActivitySink(observer, SCOPE, "span-1");

      expect(() => sink({ kind: "assistant_text", text: "hi" })).not.toThrow();
    });
  });
});
