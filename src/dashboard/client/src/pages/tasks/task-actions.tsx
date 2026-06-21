import { Ban, RotateCcw } from "lucide-react";
import { Button } from "../../components/ui/button";
import { useCancelTask, useRerunTask, useRetryTask } from "../../hooks/use-tasks";
import type { TaskDetail, TaskState } from "../../types/api";

/** Task states a task can be cancelled from — mirrors CANCELLABLE_STATES (src/schemas/task.ts). */
const CANCELLABLE_STATES: ReadonlySet<TaskState> = new Set<TaskState>([
  "requirements_gathering",
  "queued",
  "active",
  "blocked",
]);

/**
 * The retry/resume affordance for a task, or null when neither applies. Mirrors retryTask's accepted states
 * (src/schemas/task.ts): a `failed`/`blocked` task is retried; a `cancelled` task is resumed only while its
 * work survives (`reaped_at` null) — once reaped, the server rejects resume and the task is re-run from source.
 */
function retryActionFor(task: TaskDetail): { label: string } | null {
  if (task.state === "failed" || task.state === "blocked") {
    return { label: "Retry" };
  }
  if (task.state === "cancelled" && task.reaped_at === null) {
    return { label: "Resume" };
  }
  return null;
}

/**
 * The state-aware action buttons for a task: Retry/Resume (re-queue), Re-run (clone a reaped cancelled task),
 * and Cancel. Each renders only when its action applies; all share the detail page's header row.
 */
export function TaskActions({ task }: { task: TaskDetail }): React.JSX.Element {
  const cancelMutation = useCancelTask(task.id);
  const retryMutation = useRetryTask(task.id);
  const rerunMutation = useRerunTask(task.id);

  const isCancellable = CANCELLABLE_STATES.has(task.state);
  const retryAction = retryActionFor(task);
  // A reaped cancelled task cannot be resumed (its work is gone) — offer a fresh re-run from source instead.
  const canRerun = task.state === "cancelled" && task.reaped_at !== null;

  return (
    <>
      {retryAction && (
        <Button variant="outline" size="sm" onClick={() => retryMutation.mutate()} disabled={retryMutation.isPending}>
          <RotateCcw size={14} />
          {retryAction.label}
        </Button>
      )}
      {canRerun && (
        <Button variant="outline" size="sm" onClick={() => rerunMutation.mutate()} disabled={rerunMutation.isPending}>
          <RotateCcw size={14} />
          Re-run
        </Button>
      )}
      {isCancellable && (
        <Button
          variant="destructive"
          size="sm"
          onClick={() => cancelMutation.mutate()}
          disabled={cancelMutation.isPending}
        >
          <Ban size={14} />
          Cancel
        </Button>
      )}
    </>
  );
}
