import { RelatedTypes, TaskStates } from "../../schemas/task.js";
import { sanitizeErrorMessage } from "../../utils/sanitize.js";
import type { CreateTaskInput, ITaskEngine } from "../interfaces/task-engine.interface.js";
import type { IObserver } from "../observer/index.js";

// ── Types ──────────────────────────────────────────────────────────────────────

/** Dependencies for re-running a cancelled task as a fresh clone. */
export interface RerunHandlerDeps {
  taskEngine: ITaskEngine;
  observer: IObserver;
}

// ── Handler ──────────────────────────────────────────────────────────────────────

/**
 * Re-run a cancelled task as a brand-new task cloned from its source — the daemon side of the dashboard's
 * "Re-run" action (for a cancelled task whose work was already reaped, so it cannot be resumed). Runs in the
 * daemon, not the dashboard, because creating a task must publish `task.created` through the event bus (the
 * audit trail); a raw insert from the dashboard would skip it.
 *
 * The clone reuses the source's `idempotency_key`, so it refuses if a live task already holds it (cancel
 * freed the key, so the trigger may already have re-created the task) — never two live tasks on one source.
 * The new task starts fresh at `requirements_gathering` and links back to the cancelled one as a
 * previous_attempt. Never throws into the poll loop: every early exit logs and returns.
 */
export function handleRerunRequest(deps: RerunHandlerDeps, sourceTaskId: string): void {
  const { taskEngine, observer } = deps;

  const source = taskEngine.getTask(sourceTaskId);
  if (!source) {
    observer.warn("Re-run ignored — source task not found", { sourceTaskId });
    return;
  }
  if (source.state !== TaskStates.cancelled) {
    observer.warn("Re-run ignored — source task is not cancelled", { sourceTaskId, state: source.state });
    return;
  }
  if (!source.repo) {
    observer.warn("Re-run ignored — source task has no repo to clone into", { sourceTaskId });
    return;
  }

  // Cancel freed the key; if a live task already holds it (a re-trigger, or a prior re-run), the source is
  // already represented — cloning again would duplicate it. Refuse, naming the holder.
  const holder = taskEngine.findKeyHolder(source.idempotency_key);
  if (holder) {
    observer.warn("Re-run skipped — a live task already holds the source's idempotency key", {
      sourceTaskId,
      holderId: holder.id,
      holderState: holder.state,
    });
    return;
  }

  const input: CreateTaskInput = {
    title: source.title,
    repo: source.repo,
    source: "rerun",
    idempotency_key: source.idempotency_key,
    external_ref: source.external_ref,
    description: source.description,
    source_text: source.source_text,
    acceptance_criteria: source.acceptance_criteria,
    priority: source.priority,
    clone_url: source.clone_url,
    thoughts_id: source.thoughts_id,
  };
  try {
    const created = taskEngine.createTask(input);
    // Provenance: the fresh task records that it is a re-run of the cancelled one.
    taskEngine.updateTaskField(created.id, "related", [
      { type: RelatedTypes.previous_attempt, ref: sourceTaskId, relevance: "Re-run of a cancelled task" },
    ]);
    observer.info("Re-ran a cancelled task as a fresh task", { sourceTaskId, newTaskId: created.id });
  } catch (err) {
    // The key check above is not atomic with the insert: a trigger can clone the freed key in between, and
    // the partial unique index then rejects this insert. Degrade gracefully — never throw into the poll loop.
    observer.warn("Re-run failed to create the fresh task (the source may have just been re-created)", {
      sourceTaskId,
      error: sanitizeErrorMessage(err),
    });
  }
}
