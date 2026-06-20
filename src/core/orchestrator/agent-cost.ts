import type { AgentRunResult } from "../../schemas/adapters.js";
import type { IEventBus, PublishInput } from "../interfaces/event-bus.interface.js";
import type { ITaskEngine } from "../interfaces/task-engine.interface.js";

// ── Agent-Run Cost Emission ──────────────────────────────────────────────────
// The single source of the `cost.incurred` event shape. Every agent run — the
// pipeline's agentStep and the orchestrator's self-unblock diagnosis — emits
// through here, so the payload and the task-tracking update never drift apart.

/** What an agent run costs, plus the identity to attribute it to. */
export interface AgentCostInput {
  readonly taskId: string;
  readonly repo: string;
  /** The real agent plugin id (the cost's provider), e.g. from `agent.manifest.id`. */
  readonly providerId: string;
  /** What the run was for, e.g. "agent_step" or "self_unblock". */
  readonly operation: string;
  readonly result: AgentRunResult;
}

/** Publish `cost.incurred` for one agent run and fold its tokens/cost/duration into the task's totals. */
export function emitAgentCost(eventBus: IEventBus, taskEngine: ITaskEngine, input: AgentCostInput): void {
  const { taskId, repo, providerId, operation, result } = input;
  const usage = result.usage;
  eventBus.publish({
    type: "cost.incurred",
    source: "orchestrator",
    task_id: taskId,
    payload: {
      task_id: taskId,
      repo,
      provider_id: providerId,
      operation,
      spend_usd: result.cost_usd,
      duration_ms: result.duration_ms,
      input_tokens: usage?.tokens.input_tokens ?? null,
      output_tokens: usage?.tokens.output_tokens ?? null,
      total_tokens: usage?.tokens.total_tokens ?? null,
      cache_read_tokens: usage?.tokens.cache_read_tokens ?? null,
      cache_creation_tokens: usage?.tokens.cache_creation_tokens ?? null,
      model_id: usage?.model_id ?? null,
    },
  } satisfies PublishInput<"cost.incurred">);
  taskEngine.updateTracking(taskId, usage?.tokens.total_tokens ?? 0, result.cost_usd ?? 0, result.duration_ms);
}
