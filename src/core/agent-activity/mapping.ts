/**
 * Pure mapping from a canonical {@link AgentActivityEvent} to the parts of an `agent_activity`
 * observation: its filter-friendly `name`, its structured `data`, and any large payloads to offload
 * to the blob store. No effects — it sanitizes secrets and bounds size in memory, then hands the
 * effectful sink (see {@link createActivitySink}) the decisions to carry out. This is the unit the
 * tests pin hard: every kind maps to a stable shape, a big payload becomes a preview plus a blob
 * directive, and a planted secret never survives into either.
 */
import type { AgentActivityEvent } from "../../schemas/adapters.js";
import { sanitizeSecrets } from "../../utils/sanitize.js";

// ── Bounds ─────────────────────────────────────────────────────────────────────

/**
 * Inline-preview ceiling for any one field (text, a tool's input, a tool's result). Anything longer is
 * truncated to this many characters inline and the full sanitized value is offloaded to a blob the
 * dashboard drills into. Keeps each row scannable and the table small while losing no detail.
 */
const PREVIEW_LIMIT = 600;

// ── Result ───────────────────────────────────────────────────────────────────

/**
 * A full sanitized payload the sink must store via `observer.storeBlob`, keyed by the `data` field that
 * will hold its returned ref. The pure mapping decides *what* to offload; the sink performs the write.
 */
export interface BlobDirective {
  /** The `data` key that receives the blob ref once stored (e.g. "input_blob", "text_blob"). */
  readonly field: string;
  /** The full, already-sanitized content to store. */
  readonly content: string;
}

/** The pieces of an `agent_activity` observation a sink writes: a name to filter on, its data, and blobs to offload. */
export interface ActivityParts {
  /** Observation `name` — chosen so the conversation reads well and filters cleanly (the kind, or the tool name). */
  readonly name: string;
  /** Structured observation `data`: the canonical kind, sanitized inline previews, and `*_blob` ref placeholders. */
  readonly data: Record<string, unknown>;
  /** Full sanitized payloads to offload to the blob store; the sink stores each and writes its ref into `data`. */
  readonly blobs: readonly BlobDirective[];
}

// ── Mapping ────────────────────────────────────────────────────────────────────

/** Map one canonical activity event to the parts of its `agent_activity` observation (pure: no I/O). */
export function mapActivity(event: AgentActivityEvent): ActivityParts {
  switch (event.kind) {
    case "session":
      return {
        name: "session",
        data: { kind: "session", model: event.model, tools: event.tools, cwd: event.cwd },
        blobs: [],
      };
    case "assistant_text":
      return textParts("assistant_text", event.text);
    case "thinking":
      return textParts("thinking", event.text);
    case "tool_use":
      return toolUseParts(event.tool_call_id, event.name, event.input);
    case "tool_result":
      return toolResultParts(event.tool_call_id, event.status, event.output);
    default: {
      // A new kind on the contract must be mapped here — the compiler proves this branch is unreachable today.
      const exhaustive: never = event;
      throw new Error(`Unhandled agent activity kind "${JSON.stringify(exhaustive)}"`);
    }
  }
}

// ── Per-kind builders ────────────────────────────────────────────────────────────

/** A text or thinking block: the canonical kind plus a bounded, sanitized preview (full value to a blob when long). */
function textParts(kind: "assistant_text" | "thinking", text: string): ActivityParts {
  const field = bound("text", "text_blob", text);
  return { name: kind, data: { kind, ...field.data }, blobs: field.blobs };
}

/** A tool invocation: name it after the tool so the conversation and the Tools filter read by tool, not by "tool_use". */
function toolUseParts(toolCallId: string, name: string, input: unknown): ActivityParts {
  const field = bound("input", "input_blob", stringify(input));
  return {
    name,
    data: { kind: "tool_use", tool_call_id: toolCallId, name, ...field.data },
    blobs: field.blobs,
  };
}

/** A tool result, paired to its call by `tool_call_id`; the full output goes to a blob when it is large. */
function toolResultParts(toolCallId: string, status: "ok" | "error", output: unknown): ActivityParts {
  const field = bound("output", "output_blob", stringify(output));
  return {
    name: "tool_result",
    data: { kind: "tool_result", tool_call_id: toolCallId, status, ...field.data },
    blobs: field.blobs,
  };
}

// ── Sanitize + bound ──────────────────────────────────────────────────────────────

/** A sanitized field's contribution to `data` plus any blob it spilled to. */
interface BoundField {
  readonly data: Record<string, unknown>;
  readonly blobs: readonly BlobDirective[];
}

/**
 * Sanitize a string, then bound it: when it fits, inline it under `previewKey`; when it overruns
 * `PREVIEW_LIMIT`, inline a truncated preview, flag `truncated: true`, and emit a blob directive so the
 * sink stores the full sanitized value under `blobKey`. Secrets are scrubbed before either path.
 */
function bound(previewKey: string, blobKey: string, raw: string): BoundField {
  const sanitized = sanitizeSecrets(raw);
  if (sanitized.length <= PREVIEW_LIMIT) {
    return { data: { [previewKey]: sanitized }, blobs: [] };
  }
  return {
    data: { [previewKey]: sanitized.slice(0, PREVIEW_LIMIT), truncated: true },
    blobs: [{ field: blobKey, content: sanitized }],
  };
}

/** Render an unknown tool payload as a string for sanitizing and previewing — JSON when it serializes, else `String`. */
function stringify(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
