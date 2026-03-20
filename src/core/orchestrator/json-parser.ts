import { type AgentAction, AgentActionSchema } from "../../schemas/orchestrator.js";

// ── Constants ───────────────────────────────────────────────────────────────────

/** Regex to extract JSON from markdown code blocks. */
const CODE_BLOCK_RE = /```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/;

// ── Public API ──────────────────────────────────────────────────────────────────

/**
 * Extract and parse a JSON AgentAction from LLM response content.
 *
 * Handles common LLM output quirks:
 * - JSON wrapped in markdown code blocks
 * - Explanatory text before/after the JSON
 * - Multiple JSON objects (takes the first valid one)
 */
export function parseAction(content: string): AgentAction | null {
  const json = extractJson(content);
  if (!json) {
    return null;
  }

  // Normalize common LLM mistake: {"action":"done","params":{"result":{...}}} → {"action":"done","result":{...}}
  const normalized = normalizeDoneAction(json);

  const result = AgentActionSchema.safeParse(normalized);
  return result.success ? result.data : null;
}

/**
 * Extract a JSON object from a string that may contain surrounding text.
 *
 * Tries multiple strategies:
 * 1. Direct parse of the entire content
 * 2. Extract from markdown code block
 * 3. Find first balanced { ... } substring
 */
export function extractJson(content: string): unknown | null {
  const trimmed = content.trim();

  // Strategy 1: Direct parse
  try {
    return JSON.parse(trimmed);
  } catch {
    // continue to next strategy
  }

  // Strategy 2: Markdown code block
  const codeBlockMatch = CODE_BLOCK_RE.exec(trimmed);
  if (codeBlockMatch?.[1]) {
    try {
      return JSON.parse(codeBlockMatch[1].trim());
    } catch {
      // continue to next strategy
    }
  }

  // Strategy 3: Find first balanced { ... }
  return extractFirstJsonObject(trimmed);
}

// ── Internal Helpers ────────────────────────────────────────────────────────────

/** Fix common LLM pattern: wrapping done result in params. */
function normalizeDoneAction(json: unknown): unknown {
  if (typeof json !== "object" || json === null) {
    return json;
  }
  const obj = json as Record<string, unknown>;
  if (
    obj["action"] === "done" &&
    !obj["result"] &&
    typeof obj["params"] === "object" &&
    obj["params"] !== null
  ) {
    const params = obj["params"] as Record<string, unknown>;
    if (params["result"]) {
      return { action: "done", result: params["result"], thinking: obj["thinking"] };
    }
  }
  return json;
}

/** Find and parse the first balanced JSON object in a string. */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: balanced brace parser requires nested state tracking
function extractFirstJsonObject(text: string): unknown | null {
  const firstBrace = text.indexOf("{");
  if (firstBrace < 0) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = firstBrace; i < text.length; i++) {
    // biome-ignore lint/style/noNonNullAssertion: i is within text.length bounds
    const ch = text[i]!;

    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }

    if (ch === "{") {
      depth++;
    }
    if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(firstBrace, i + 1));
        } catch {
          return null;
        }
      }
    }
  }

  return null;
}
