import type { CompletionResult } from "../../schemas/adapters.js";
import {
  type ActionResult,
  type AgentAction,
  AgentActionSchema,
  type PhaseToolConfig,
} from "../../schemas/orchestrator.js";

// ── Constants ───────────────────────────────────────────────────────────────────

/** Regex to extract JSON from markdown code blocks. */
const CODE_BLOCK_RE = /```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/;

/** Max action-result pairs to include in context (rolling window). */
const MAX_HISTORY_WINDOW = 20;

// ── Types ───────────────────────────────────────────────────────────────────────

/** Configuration for a single agent loop run. */
export interface AgentLoopConfig {
  /** Current orchestrator phase. */
  phase: string;
  /** Task ID for tracking. */
  taskId: string;
  /** System prompt (role, constraints). */
  systemPrompt: string;
  /** Initial user prompt (task context + instructions). */
  initialPrompt: string;
  /** Per-phase tool restrictions. */
  toolConfig: PhaseToolConfig;
  /** Worktree path for file operations. Null if no worktree (degraded mode). */
  worktreePath: string | null;
}

/** Result of a completed agent loop. */
export interface AgentLoopResult {
  /** The phase output data from the terminal "done" action. */
  phaseData: Record<string, unknown>;
  /** Number of LLM calls made. */
  iterations: number;
  /** Full action history (for audit trail). */
  actions: Array<{ action: AgentAction; result: ActionResult | null }>;
  /** Accumulated cost across all iterations. */
  totalCost: { tokens_in: number; tokens_out: number; spend_usd: number | null };
}

/** A single action-result pair in conversation history. */
interface HistoryEntry {
  action: AgentAction;
  result: ActionResult | null;
}

// ── Agent Loop ──────────────────────────────────────────────────────────────────

/**
 * Run the agent loop for a single phase.
 *
 * The Engineer IS the agent. This loop is the core: call LLM for inference,
 * parse structured action, execute tool, feed result back, repeat until done.
 * Provider-agnostic — any LLM that outputs JSON works.
 *
 * @param config - Phase-specific configuration
 * @param callLlm - Injected LLM inference function (single-shot)
 * @param execAction - Injected action execution function
 */
export async function runAgentLoop(
  config: AgentLoopConfig,
  callLlm: (prompt: string, systemPrompt: string) => Promise<CompletionResult>,
  execAction: (action: AgentAction, worktreePath: string) => Promise<ActionResult>,
): Promise<AgentLoopResult> {
  const history: HistoryEntry[] = [];
  const totalCost = { tokens_in: 0, tokens_out: 0, spend_usd: null as number | null };
  let iterations = 0;

  while (iterations < config.toolConfig.max_iterations) {
    iterations++;

    const prompt = buildPrompt(config, history);
    const completion = await callLlm(prompt, config.systemPrompt);
    accumulateCost(totalCost, completion);

    const action = parseAction(completion.content);

    if (!action) {
      // Unparseable response — retry once with guidance
      const retryResult = await handleRetry(
        config,
        history,
        completion.content,
        totalCost,
        iterations,
        callLlm,
        execAction,
      );
      if (retryResult) {
        return retryResult;
      }
      iterations++;
      continue;
    }

    // Terminal action
    if (action.action === "done") {
      history.push({ action, result: null });
      return buildResult(action.result, iterations, history, totalCost);
    }

    // Validate action against allowed actions
    if (!config.toolConfig.allowed_actions.includes(action.action)) {
      history.push({
        action,
        result: {
          success: false,
          output: "",
          error: `Action "${action.action}" is not allowed in ${config.phase} phase. Allowed: ${config.toolConfig.allowed_actions.join(", ")}`,
        },
      });
      continue;
    }

    // Execute action
    const worktreePath = config.worktreePath ?? ".";
    const result = await execAction(action, worktreePath);
    history.push({ action, result });
  }

  // Iteration limit reached — force done
  return buildForcedResult(history, iterations, totalCost);
}

// ── Retry Logic ─────────────────────────────────────────────────────────────────

async function handleRetry(
  config: AgentLoopConfig,
  history: HistoryEntry[],
  failedContent: string,
  totalCost: { tokens_in: number; tokens_out: number; spend_usd: number | null },
  currentIterations: number,
  callLlm: (prompt: string, systemPrompt: string) => Promise<CompletionResult>,
  execAction: (action: AgentAction, worktreePath: string) => Promise<ActionResult>,
): Promise<AgentLoopResult | null> {
  if (currentIterations >= config.toolConfig.max_iterations) {
    return buildForcedResult(history, currentIterations, totalCost);
  }

  const retryPrompt = buildRetryPrompt(config, history, failedContent);
  const retryCompletion = await callLlm(retryPrompt, config.systemPrompt);
  accumulateCost(totalCost, retryCompletion);

  const retryAction = parseAction(retryCompletion.content);
  if (!retryAction) {
    return buildForcedResult(history, currentIterations + 1, totalCost);
  }

  if (retryAction.action === "done") {
    history.push({ action: retryAction, result: null });
    return buildResult(retryAction.result, currentIterations + 1, history, totalCost);
  }

  // Execute the retry action and continue the loop
  const worktreePath = config.worktreePath ?? ".";
  const result = await execAction(retryAction, worktreePath);
  history.push({ action: retryAction, result });
  return null; // Signal to continue loop
}

// ── Prompt Building ─────────────────────────────────────────────────────────────

/** Build the prompt including conversation history. */
function buildPrompt(config: AgentLoopConfig, history: HistoryEntry[]): string {
  if (history.length === 0) {
    return config.initialPrompt;
  }

  const parts: string[] = [config.initialPrompt, "", "## Previous Actions"];

  const windowStart = Math.max(0, history.length - MAX_HISTORY_WINDOW);
  if (windowStart > 0) {
    parts.push(`[${String(windowStart)} earlier actions omitted]`);
  }

  for (let i = windowStart; i < history.length; i++) {
    // biome-ignore lint/style/noNonNullAssertion: i is within bounds from loop condition
    const entry = history[i]!;
    appendHistoryEntry(parts, entry, i);
  }

  parts.push("", "## What's your next action?");
  parts.push(
    `Respond with a JSON object. Available actions: ${config.toolConfig.allowed_actions.join(", ")}`,
  );

  return parts.join("\n");
}

function appendHistoryEntry(parts: string[], entry: HistoryEntry, index: number): void {
  parts.push("", `### Action ${String(index + 1)}: ${entry.action.action}`);
  if (entry.action.action !== "done") {
    parts.push(`Input: ${JSON.stringify("params" in entry.action ? entry.action.params : {})}`);
  }
  if (entry.result) {
    const outputPreview =
      entry.result.output.length > 2000
        ? `${entry.result.output.slice(0, 2000)}\n[... truncated, ${String(entry.result.output.length)} chars total]`
        : entry.result.output;
    parts.push(`Result: ${entry.result.success ? "success" : "error"}`);
    if (entry.result.output) {
      parts.push(`Output:\n${outputPreview}`);
    }
    if (entry.result.error) {
      parts.push(`Error: ${entry.result.error}`);
    }
  }
}

/** Build a retry prompt after unparseable response. */
function buildRetryPrompt(
  config: AgentLoopConfig,
  history: HistoryEntry[],
  failedContent: string,
): string {
  const base = buildPrompt(config, history);
  return [
    base,
    "",
    "## IMPORTANT: Your previous response could not be parsed as JSON.",
    `Your response was: ${failedContent.slice(0, 500)}`,
    "",
    "Please respond with ONLY a valid JSON object. No markdown, no explanation outside the JSON.",
    'Example: {"action": "read_file", "params": {"path": "src/index.ts"}}',
    'Or to finish: {"action": "done", "result": {your phase output data}}',
  ].join("\n");
}

// ── JSON Parsing ────────────────────────────────────────────────────────────────

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

  const result = AgentActionSchema.safeParse(json);
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

// ── Cost & Result Helpers ───────────────────────────────────────────────────────

/** Accumulate cost from a completion into the running total. */
function accumulateCost(
  total: { tokens_in: number; tokens_out: number; spend_usd: number | null },
  completion: CompletionResult,
): void {
  total.tokens_in += completion.usage.tokens_in;
  total.tokens_out += completion.usage.tokens_out;
  if (completion.usage.spend_usd !== null) {
    total.spend_usd = (total.spend_usd ?? 0) + completion.usage.spend_usd;
  }
}

/** Build a successful result from a "done" action. */
function buildResult(
  phaseData: Record<string, unknown>,
  iterations: number,
  history: HistoryEntry[],
  totalCost: { tokens_in: number; tokens_out: number; spend_usd: number | null },
): AgentLoopResult {
  return {
    phaseData,
    iterations,
    actions: history.map((h) => ({ action: h.action, result: h.result })),
    totalCost,
  };
}

/** Build a forced result when the loop can't continue (parse failures or iteration limit). */
function buildForcedResult(
  history: HistoryEntry[],
  iterations: number,
  totalCost: { tokens_in: number; tokens_out: number; spend_usd: number | null },
): AgentLoopResult {
  return {
    phaseData: {},
    iterations,
    actions: history.map((h) => ({ action: h.action, result: h.result })),
    totalCost,
  };
}
