/**
 * Readers for the `cost.incurred` event — the only place the agent's model id is recorded.
 *
 * The `agent_call` span carries cost/tokens but NOT the model id; the model rides the `cost.incurred`
 * event payload (`agent-cost.ts`, `events.ts`). The dashboard joins them at the task level: every agent run
 * for a task publishes one `cost.incurred`, so the distinct `model_id` values across a task's cost events are
 * the model(s) that task ran on. We surface that honestly as task-level context rather than mislabeling each
 * span's step name as a model (the step is not a model).
 *
 * The reader takes only the structural `{ type, payload }` slice it needs (any `DomainEvent` satisfies it)
 * rather than importing `types/api` — keeping it dependency-free for the NodeNext test compiler, which does
 * not resolve the client's extensionless import chain.
 */

/** The structural slice this reader needs — any `DomainEvent` is assignable. */
export interface CostEventLike {
  readonly type: string;
  readonly payload: Record<string, unknown>;
}

/** The distinct model ids a task ran on, derived from its `cost.incurred` events, in first-seen order. */
export function modelsFromCostEvents(events: readonly CostEventLike[]): readonly string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const event of events) {
    if (event.type !== "cost.incurred") {
      continue;
    }
    const modelId = event.payload["model_id"];
    if (typeof modelId === "string" && modelId.length > 0 && !seen.has(modelId)) {
      seen.add(modelId);
      ordered.push(modelId);
    }
  }
  return ordered;
}
