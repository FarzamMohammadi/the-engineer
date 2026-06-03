import { ulid } from "ulid";
import { describe, expect, it } from "vitest";

import {
  type AttributeContext,
  type OtlpKeyValue,
  SCOPE_NAME,
  SERVICE_NAME,
  buildAttributes,
  buildResourceSpans,
  deriveSpanId,
  deriveTraceId,
  mapObservationToSpan,
} from "../../../../src/core/observer/otlp/index.js";
import type { Observation } from "../../../../src/schemas/observer.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const CTX: AttributeContext = { dashboardBaseUrl: "http://127.0.0.1:3847" };

/** Build an Observation with sensible defaults, overridable per test. */
function makeObservation(overrides: Partial<Observation> = {}): Observation {
  return {
    id: ulid(),
    trace_id: ulid(),
    parent_observation_id: null,
    type: "tool_execution",
    name: "do_thing",
    task_id: "task-1",
    phase: "implementation",
    session_id: "session-1",
    start_time: "2026-06-02T12:00:00.000Z",
    end_time: "2026-06-02T12:00:01.500Z",
    duration_ms: 1500,
    input: null,
    output: null,
    metadata: null,
    level: "info",
    status: "ok",
    error_message: null,
    links: null,
    ...overrides,
  };
}

/** Find an attribute by key (or undefined). */
function attr(attrs: OtlpKeyValue[], key: string): OtlpKeyValue | undefined {
  return attrs.find((a) => a.key === key);
}

// ── deriveTraceId / deriveSpanId ──────────────────────────────────────────────

describe("deriveTraceId", () => {
  it("produces 32 hex chars (16 bytes) from a ULID", () => {
    const traceId = deriveTraceId(ulid());
    expect(traceId).toMatch(/^[0-9a-f]{32}$/);
  });

  it("is deterministic — same ULID round-trips to the same hex", () => {
    const id = ulid();
    expect(deriveTraceId(id)).toBe(deriveTraceId(id));
  });

  it("decodes the canonical ULID spec vector losslessly", () => {
    // 01ARZ3NDEKTSV4RRFFQ69G5FAV is the reference ULID from the spec.
    expect(deriveTraceId("01ARZ3NDEKTSV4RRFFQ69G5FAV")).toBe("01563e3ab5d3d6764c61efb99302bd5b");
  });

  it("is case-insensitive (Crockford alphabet)", () => {
    const id = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    expect(deriveTraceId(id.toLowerCase())).toBe(deriveTraceId(id));
  });

  it("distinct ULIDs yield distinct trace ids (no truncation collision)", () => {
    const a = deriveTraceId(ulid());
    const b = deriveTraceId(ulid());
    expect(a).not.toBe(b);
  });

  it("throws on a non-ULID input rather than producing a wrong id", () => {
    expect(() => deriveTraceId("not-a-ulid")).toThrow(/Invalid ULID/);
    expect(() => deriveTraceId("")).toThrow(/Invalid ULID/);
  });

  it("clamps an out-of-range ULID to exactly 32 hex chars (16 bytes)", () => {
    // A canonical ULID's leading char is ≤ '7' (128 bits fit the encoding). A
    // leading char of '8'..'Z' decodes past 128 bits and would otherwise produce
    // 33+ hex chars — an invalid OTLP trace id. The 128-bit mask must clamp it.
    // 26 'Z's is the maximum-value 26-char Crockford string (well above 2^128).
    const outOfRange = "Z".repeat(26);
    const traceId = deriveTraceId(outOfRange);
    expect(traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(traceId).toHaveLength(32);
  });
});

describe("deriveSpanId", () => {
  it("produces 16 hex chars (8 bytes) from a ULID", () => {
    const spanId = deriveSpanId(ulid());
    expect(spanId).toMatch(/^[0-9a-f]{16}$/);
  });

  it("is deterministic", () => {
    const id = ulid();
    expect(deriveSpanId(id)).toBe(deriveSpanId(id));
  });

  it("is the low 64 bits — the trailing 16 hex of the full 128-bit decode", () => {
    const id = ulid();
    expect(deriveSpanId(id)).toBe(deriveTraceId(id).slice(16));
  });

  it("preserves the random component (sibling ids stay distinct)", () => {
    // Two ULIDs minted back-to-back share a timestamp but differ in randomness;
    // the low 64 bits live entirely in the random half, so span ids must differ.
    const a = deriveSpanId(ulid());
    const b = deriveSpanId(ulid());
    expect(a).not.toBe(b);
  });

  it("throws on a non-ULID input", () => {
    expect(() => deriveSpanId("01ARZ3")).toThrow(/Invalid ULID/);
  });
});

// ── buildAttributes ───────────────────────────────────────────────────────────

describe("buildAttributes", () => {
  it("returns no attributes for null input and output", () => {
    expect(buildAttributes(null, null, CTX)).toEqual([]);
  });

  it("namespaces input.* and output.* keys", () => {
    const attrs = buildAttributes({ retries: 3 }, { result: "ok" }, CTX);
    expect(attr(attrs, "input.retries")).toBeDefined();
    expect(attr(attrs, "output.result")).toBeDefined();
  });

  it("projects typed scalars onto OTLP AnyValue variants", () => {
    const attrs = buildAttributes({ count: 7, ratio: 0.5, flag: true, label: "hello" }, null, CTX);
    expect(attr(attrs, "input.count")?.value).toEqual({ intValue: "7" });
    expect(attr(attrs, "input.ratio")?.value).toEqual({ doubleValue: 0.5 });
    expect(attr(attrs, "input.flag")?.value).toEqual({ boolValue: true });
    expect(attr(attrs, "input.label")?.value).toEqual({ stringValue: "hello" });
  });

  it("JSON-stringifies nested objects and arrays into stringValue", () => {
    const attrs = buildAttributes({ nested: { a: 1 }, list: [1, 2] }, null, CTX);
    expect(attr(attrs, "input.nested")?.value).toEqual({ stringValue: '{"a":1}' });
    expect(attr(attrs, "input.list")?.value).toEqual({ stringValue: "[1,2]" });
  });

  it("converts a blob ref to a dashboard URL attribute, never inlining the ref", () => {
    const ref = `ab/${"a".repeat(64)}`;
    const attrs = buildAttributes({ prompt_ref: ref }, { response_ref: ref }, CTX);

    expect(attr(attrs, "input.prompt_ref")).toBeUndefined();
    expect(attr(attrs, "input.prompt_ref.url")?.value).toEqual({
      stringValue: `http://127.0.0.1:3847/api/blob/${ref}`,
    });
    expect(attr(attrs, "output.response_ref.url")?.value).toEqual({
      stringValue: `http://127.0.0.1:3847/api/blob/${ref}`,
    });
  });

  it("does not treat a malformed ref value as a blob ref", () => {
    const attrs = buildAttributes({ prompt_ref: "not-a-real-ref" }, null, CTX);
    expect(attr(attrs, "input.prompt_ref.url")).toBeUndefined();
    expect(attr(attrs, "input.prompt_ref")?.value).toEqual({ stringValue: "not-a-real-ref" });
  });

  it("sanitizes a planted secret in a string value", () => {
    const secret = `ghp_${"a".repeat(36)}`;
    const attrs = buildAttributes({ command: `git push ${secret}` }, null, CTX);
    const value = attr(attrs, "input.command")?.value;
    expect(value).toHaveProperty("stringValue");
    const stringValue = (value as { stringValue: string }).stringValue;
    expect(stringValue).not.toContain(secret);
  });

  it("sanitizes a planted secret nested inside a stringified object", () => {
    const secret = `ghp_${"b".repeat(36)}`;
    const attrs = buildAttributes({ env: { token: secret } }, null, CTX);
    const stringValue = (attr(attrs, "input.env")?.value as { stringValue: string }).stringValue;
    expect(stringValue).not.toContain(secret);
  });
});

// ── mapObservationToSpan ──────────────────────────────────────────────────────

describe("mapObservationToSpan", () => {
  it("derives traceId and spanId from the right ULIDs", () => {
    const obs = makeObservation();
    const span = mapObservationToSpan(obs, CTX);
    expect(span.traceId).toBe(deriveTraceId(obs.trace_id as string));
    expect(span.spanId).toBe(deriveSpanId(obs.id));
  });

  it("emits times as unix-nanos STRINGS (ms × 1e6)", () => {
    const obs = makeObservation({
      start_time: "2026-06-02T12:00:00.000Z",
      end_time: "2026-06-02T12:00:01.500Z",
    });
    const span = mapObservationToSpan(obs, CTX);
    expect(span.startTimeUnixNano).toBe(String(Date.parse("2026-06-02T12:00:00.000Z") * 1_000_000));
    expect(span.endTimeUnixNano).toBe(String(Date.parse("2026-06-02T12:00:01.500Z") * 1_000_000));
    expect(typeof span.startTimeUnixNano).toBe("string");
    expect(typeof span.endTimeUnixNano).toBe("string");
  });

  it("preserves full nanosecond precision without 2^53 float loss", () => {
    const obs = makeObservation({ start_time: "2026-06-02T12:00:00.123Z" });
    const span = mapObservationToSpan(obs, CTX);
    // The nanos value exceeds Number.MAX_SAFE_INTEGER; the string must be exact.
    expect(BigInt(span.startTimeUnixNano)).toBe(BigInt(Date.parse("2026-06-02T12:00:00.123Z")) * 1_000_000n);
    expect(BigInt(span.startTimeUnixNano) > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
  });

  it("maps an instant (start == end) to a zero-duration span", () => {
    const instant = "2026-06-02T12:00:00.000Z";
    const obs = makeObservation({ start_time: instant, end_time: instant, duration_ms: 0 });
    const span = mapObservationToSpan(obs, CTX);
    expect(span.startTimeUnixNano).toBe(span.endTimeUnixNano);
  });

  it("falls back end → start for a still-open span (null end_time)", () => {
    const obs = makeObservation({ end_time: null, duration_ms: null });
    const span = mapObservationToSpan(obs, CTX);
    expect(span.endTimeUnixNano).toBe(span.startTimeUnixNano);
  });

  it("omits parentSpanId for a root span (null parent)", () => {
    const obs = makeObservation({ parent_observation_id: null });
    const span = mapObservationToSpan(obs, CTX);
    expect(span.parentSpanId).toBeUndefined();
    expect("parentSpanId" in span).toBe(false);
  });

  it("sets parentSpanId from parent_observation_id and links to the parent's span id", () => {
    const parent = makeObservation();
    const child = makeObservation({
      trace_id: parent.trace_id,
      parent_observation_id: parent.id,
    });
    const parentSpan = mapObservationToSpan(parent, CTX);
    const childSpan = mapObservationToSpan(child, CTX);

    expect(childSpan.parentSpanId).toBe(parentSpan.spanId);
    expect(childSpan.traceId).toBe(parentSpan.traceId);
  });

  it("maps status ok → STATUS_CODE_OK", () => {
    const span = mapObservationToSpan(makeObservation({ status: "ok" }), CTX);
    expect(span.status).toEqual({ code: "STATUS_CODE_OK" });
  });

  it("maps status error → STATUS_CODE_ERROR (no message when error_message is null)", () => {
    const span = mapObservationToSpan(makeObservation({ status: "error", error_message: null }), CTX);
    expect(span.status).toEqual({ code: "STATUS_CODE_ERROR" });
  });

  it("carries the error_message column as the sanitized status.message on an error span", () => {
    const span = mapObservationToSpan(
      makeObservation({ status: "error", error_message: "lint failed: 3 errors" }),
      CTX,
    );
    expect(span.status).toEqual({ code: "STATUS_CODE_ERROR", message: "lint failed: 3 errors" });
  });

  it("sanitizes a planted secret in the error_message before it rides on status.message", () => {
    const secret = `ghp_${"c".repeat(36)}`;
    const span = mapObservationToSpan(
      makeObservation({ status: "error", error_message: `auth failed with ${secret}` }),
      CTX,
    );
    expect(span.status.message).toBeDefined();
    expect(span.status.message).not.toContain(secret);
  });

  it("drops the always-null metadata (never emits a metadata attribute)", () => {
    const obs = makeObservation({
      input: { a: 1 },
      output: { b: 2 },
      metadata: null,
    });
    const span = mapObservationToSpan(obs, CTX);
    expect(span.attributes.some((a) => a.key.includes("metadata"))).toBe(false);
  });

  it("carries the span name and projected attributes", () => {
    const obs = makeObservation({ name: "run_gate", input: { gate: "lint" } });
    const span = mapObservationToSpan(obs, CTX);
    expect(span.name).toBe("run_gate");
    expect(attr(span.attributes, "input.gate")?.value).toEqual({ stringValue: "lint" });
  });

  it("falls back to the observation id when trace_id is null (orphan)", () => {
    const obs = makeObservation({ trace_id: null });
    const span = mapObservationToSpan(obs, CTX);
    expect(span.traceId).toBe(deriveTraceId(obs.id));
  });

  it("omits parentSpanId for an untraced span even when it carries a parent (clean root)", () => {
    // trace_id null → the span is its own single-span trace. Its parent lives in a
    // DIFFERENT trace, so linking to it would dangle. Must be a clean root.
    const obs = makeObservation({ trace_id: null, parent_observation_id: ulid() });
    const span = mapObservationToSpan(obs, CTX);
    expect(span.traceId).toBe(deriveTraceId(obs.id));
    expect(span.parentSpanId).toBeUndefined();
    expect("parentSpanId" in span).toBe(false);
  });

  it("omits links when the observation has none", () => {
    const span = mapObservationToSpan(makeObservation({ links: null }), CTX);
    expect(span.links).toBeUndefined();
    expect("links" in span).toBe(false);
  });

  it("maps cross-trace continuity links to OTLP links, deriving ids from the link target", () => {
    // The link points at a span in ANOTHER trace (the prior dispatch's root), so its
    // OTLP traceId/spanId derive from the LINK's own trace_id/observation_id — not this span's.
    const priorTraceId = ulid();
    const priorRootId = ulid();
    const obs = makeObservation({ links: [{ trace_id: priorTraceId, observation_id: priorRootId }] });

    const span = mapObservationToSpan(obs, CTX);

    expect(span.links).toEqual([{ traceId: deriveTraceId(priorTraceId), spanId: deriveSpanId(priorRootId) }]);
    // The link's trace differs from this span's own trace — it is a cross-trace edge.
    expect(span.links?.[0]?.traceId).not.toBe(span.traceId);
  });

  it("throws on an invalid ISO timestamp", () => {
    const obs = makeObservation({ start_time: "not-a-date" });
    expect(() => mapObservationToSpan(obs, CTX)).toThrow(/Invalid ISO timestamp/);
  });
});

// ── buildResourceSpans ────────────────────────────────────────────────────────

describe("buildResourceSpans", () => {
  it("wraps spans in the resourceSpans → scopeSpans → spans envelope", () => {
    const span = mapObservationToSpan(makeObservation(), CTX);
    const payload = buildResourceSpans([span]);

    expect(payload.resourceSpans).toHaveLength(1);
    const resourceSpan = payload.resourceSpans[0]!;
    expect(resourceSpan.scopeSpans).toHaveLength(1);
    expect(resourceSpan.scopeSpans[0]!.spans).toEqual([span]);
  });

  it("stamps service.name = the-engineer on the resource", () => {
    const payload = buildResourceSpans([]);
    const serviceAttr = payload.resourceSpans[0]!.resource.attributes.find((a) => a.key === "service.name");
    expect(serviceAttr?.value).toEqual({ stringValue: SERVICE_NAME });
    expect(SERVICE_NAME).toBe("the-engineer");
  });

  it("stamps the instrumentation scope name", () => {
    const payload = buildResourceSpans([]);
    expect(payload.resourceSpans[0]!.scopeSpans[0]!.scope.name).toBe(SCOPE_NAME);
  });

  it("produces a valid empty-but-well-formed payload for an empty batch", () => {
    const payload = buildResourceSpans([]);
    expect(payload.resourceSpans[0]!.scopeSpans[0]!.spans).toEqual([]);
  });

  it("serializes to JSON with string nanos (no precision loss on the wire)", () => {
    const obs = makeObservation({ start_time: "2026-06-02T12:00:00.123Z" });
    const span = mapObservationToSpan(obs, CTX);
    const roundTripped = JSON.parse(JSON.stringify(buildResourceSpans([span]))) as ReturnType<
      typeof buildResourceSpans
    >;
    const wireSpan = roundTripped.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
    expect(typeof wireSpan.startTimeUnixNano).toBe("string");
  });
});
