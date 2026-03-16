import type { CompletionResult } from "../../schemas/adapters.js";
import {
  type ActionResult,
  type AgentAction,
  AgentActionSchema,
  type PhaseToolConfig,
} from "../../schemas/orchestrator.js";
import { sanitizeSecrets } from "../../utils/sanitize.js";
import type { IObserver } from "../observer/facade.js";

// ── Constants ───────────────────────────────────────────────────────────────────

/** Regex to extract JSON from markdown code blocks. */
const CODE_BLOCK_RE = /```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/;

/** Max action-result pairs to include in context (rolling window). */
const MAX_HISTORY_WINDOW = 20;

// ── Callback Record Types ────────────────────────────────────────────────────────

/** Record passed to agent loop action callback. */
export interface ActionTraceRecord {
  action_type: string;
  action_params: string | null;
  result_success: boolean;
  result_output: string | null;
  result_error: string | null;
  duration_ms: number;
  iteration: number;
}

/** Record passed to agent loop LLM callback. */
export interface LlmTraceRecord {
  prompt_length: number;
  response_length: number;
  tokens_in: number;
  tokens_out: number;
  spend_usd: number | null;
  latency_ms: number;
  iteration: number;
  prompt_ref: string | null;
  response_ref: string | null;
  /** Raw prompt content for blob storage (not persisted in DB). */
  prompt_content?: string;
  /** Raw response content for blob storage (not persisted in DB). */
  response_content?: string;
}

// ── Types ───────────────────────────────────────────────────────────────────────

/** Observability callbacks — optional, keeps the agent loop pure. */
export interface AgentLoopCallbacks {
  /** Called after each action is executed with timing and result data. */
  onActionComplete?: (trace: ActionTraceRecord) => void;
  /** Called after each LLM completion with timing and token data. */
  onLlmComplete?: (trace: LlmTraceRecord) => void;
}

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
  /** Observer facade for structured logging. */
  observer: IObserver;
  /** Optional observability callbacks for tracing. */
  callbacks?: AgentLoopCallbacks;
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
  const { observer } = config;

  observer.info("Starting agent loop", {
    phase: config.phase,
    maxIterations: config.toolConfig.max_iterations,
    worktreePath: config.worktreePath ?? "none",
  });

  while (iterations < config.toolConfig.max_iterations) {
    iterations++;

    const prompt = sanitizeSecrets(buildPrompt(config, history));
    const llmStart = Date.now();
    const completion = await callLlm(prompt, sanitizeSecrets(config.systemPrompt));
    const llmLatency = Date.now() - llmStart;
    accumulateCost(totalCost, completion);
    emitLlmCallback(config.callbacks, completion, prompt, llmLatency, iterations);

    const action = parseAction(completion.content);

    if (!action) {
      observer.warn("Unparseable LLM response", {
        phase: config.phase,
        iteration: iterations,
        contentLength: completion.content.length,
        preview: completion.content.slice(0, 200),
      });
      // Unparseable response — retry once with guidance
      const retryResult = await handleRetry(
        config,
        history,
        completion.content,
        totalCost,
        iterations,
        callLlm,
        execAction,
        observer,
      );
      if (retryResult) {
        return retryResult;
      }
      iterations++;
      continue;
    }

    // Terminal action
    if (action.action === "done") {
      observer.info("Agent loop completed", {
        phase: config.phase,
        iteration: iterations,
        resultKeys: Object.keys(action.result),
      });
      history.push({ action, result: null });
      return buildResult(action.result, iterations, history, totalCost);
    }

    // Validate and execute
    await executeAndLog(config, action, iterations, history, execAction, observer);
  }

  observer.warn("Agent loop iteration limit reached", { phase: config.phase, iterations });
  // Iteration limit reached — force done
  return buildForcedResult(history, iterations, totalCost);
}

/** Validate an action against allowed actions, execute it, log result, push to history. */
async function executeAndLog(
  config: AgentLoopConfig,
  action: AgentAction,
  iterations: number,
  history: HistoryEntry[],
  execAction: (action: AgentAction, worktreePath: string) => Promise<ActionResult>,
  observer: IObserver,
): Promise<void> {
  if (!config.toolConfig.allowed_actions.includes(action.action)) {
    observer.warn("Action blocked — not allowed in phase", {
      phase: config.phase,
      iteration: iterations,
      action: action.action,
      allowed: config.toolConfig.allowed_actions,
    });
    history.push({
      action,
      result: {
        success: false,
        output: "",
        error: `Action "${action.action}" is not allowed in ${config.phase} phase. Allowed: ${config.toolConfig.allowed_actions.join(", ")}`,
      },
    });
    return;
  }

  const worktreePath = config.worktreePath ?? ".";
  const actionSummary = summarizeAction(action);
  observer.debug("Executing action", {
    phase: config.phase,
    iteration: iterations,
    action: action.action,
    summary: actionSummary,
  });
  const actionStart = Date.now();
  const result = await execAction(action, worktreePath);
  const actionDuration = Date.now() - actionStart;
  if (result.success) {
    observer.debug("Action succeeded", {
      phase: config.phase,
      iteration: iterations,
      outputLength: result.output.length,
    });
  } else {
    observer.warn("Action failed", {
      phase: config.phase,
      iteration: iterations,
      error: sanitizeSecrets(result.error ?? "unknown"),
    });
  }
  history.push({ action, result });
  emitActionCallback(config.callbacks, action, result, actionDuration, iterations);
}

/** Summarize an action for logging (params only, truncated). */
function summarizeAction(action: AgentAction): string {
  if (action.action === "done") {
    return "";
  }
  const params = "params" in action ? action.params : {};
  const json = JSON.stringify(params);
  return json.length > 120 ? `${json.slice(0, 120)}...` : json;
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
  observer: IObserver,
): Promise<AgentLoopResult | null> {
  if (currentIterations >= config.toolConfig.max_iterations) {
    observer.warn("Retry skipped — at iteration limit", { phase: config.phase });
    return buildForcedResult(history, currentIterations, totalCost);
  }

  observer.debug("Retrying after parse failure", { phase: config.phase });
  const retryPrompt = sanitizeSecrets(buildRetryPrompt(config, history, failedContent));
  const retryLlmStart = Date.now();
  const retryCompletion = await callLlm(retryPrompt, sanitizeSecrets(config.systemPrompt));
  const retryLlmLatency = Date.now() - retryLlmStart;
  accumulateCost(totalCost, retryCompletion);
  emitLlmCallback(
    config.callbacks,
    retryCompletion,
    retryPrompt,
    retryLlmLatency,
    currentIterations + 1,
  );

  const retryAction = parseAction(retryCompletion.content);
  if (!retryAction) {
    observer.warn("Retry also failed to parse — force done", { phase: config.phase });
    return buildForcedResult(history, currentIterations + 1, totalCost);
  }

  if (retryAction.action === "done") {
    observer.debug("Retry produced done", { phase: config.phase });
    history.push({ action: retryAction, result: null });
    return buildResult(retryAction.result, currentIterations + 1, history, totalCost);
  }

  observer.debug("Retry produced action", { phase: config.phase, action: retryAction.action });
  // Execute the retry action and continue the loop
  const worktreePath = config.worktreePath ?? ".";
  const result = await execAction(retryAction, worktreePath);
  history.push({ action: retryAction, result });
  return null; // Signal to continue loop
}

// ── Prompt Building ─────────────────────────────────────────────────────────────

/** Build the prompt including conversation history. */
function buildPrompt(config: AgentLoopConfig, history: HistoryEntry[]): string {
  const jsonDirective = `\n\n## Response Format\nRespond with exactly one JSON object per message. No markdown wrapping, no explanation outside the JSON.\nAvailable actions: ${config.toolConfig.allowed_actions.join(", ")}`;

  if (history.length === 0) {
    return config.initialPrompt + jsonDirective;
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
    parts.push(
      `Input: ${sanitizeSecrets(JSON.stringify("params" in entry.action ? entry.action.params : {}))}`,
    );
  }
  if (entry.result) {
    const sanitizedOutput = sanitizeSecrets(entry.result.output);
    const outputPreview =
      sanitizedOutput.length > 2000
        ? `${sanitizedOutput.slice(0, 2000)}\n[... truncated, ${String(sanitizedOutput.length)} chars total]`
        : sanitizedOutput;
    parts.push(`Result: ${entry.result.success ? "success" : "error"}`);
    if (sanitizedOutput) {
      parts.push(`Output:\n${outputPreview}`);
    }
    if (entry.result.error) {
      parts.push(`Error: ${sanitizeSecrets(entry.result.error)}`);
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

  // Normalize common LLM mistake: {"action":"done","params":{"result":{...}}} → {"action":"done","result":{...}}
  const normalized = normalizeDoneAction(json);

  const result = AgentActionSchema.safeParse(normalized);
  return result.success ? result.data : null;
}

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

// ── Observability Callbacks ──────────────────────────────────────────────────

/** Emit action trace callback if configured. */
function emitActionCallback(
  callbacks: AgentLoopCallbacks | undefined,
  action: AgentAction,
  result: ActionResult,
  durationMs: number,
  iteration: number,
): void {
  if (!callbacks?.onActionComplete) {
    return;
  }
  const params = "params" in action ? action.params : {};
  callbacks.onActionComplete({
    action_type: action.action,
    action_params: JSON.stringify(params),
    result_success: result.success,
    result_output: sanitizeSecrets(result.output),
    result_error: result.error ? sanitizeSecrets(result.error) : null,
    duration_ms: durationMs,
    iteration,
  });
}

/** Emit LLM trace callback if configured. Passes raw content for blob storage. */
function emitLlmCallback(
  callbacks: AgentLoopCallbacks | undefined,
  completion: CompletionResult,
  prompt: string,
  latencyMs: number,
  iteration: number,
): void {
  if (!callbacks?.onLlmComplete) {
    return;
  }
  callbacks.onLlmComplete({
    prompt_length: prompt.length,
    response_length: completion.content.length,
    tokens_in: completion.usage.tokens_in,
    tokens_out: completion.usage.tokens_out,
    spend_usd: completion.usage.spend_usd,
    latency_ms: latencyMs,
    iteration,
    prompt_ref: null,
    response_ref: null,
    prompt_content: prompt,
    response_content: sanitizeSecrets(completion.content),
  });
}
