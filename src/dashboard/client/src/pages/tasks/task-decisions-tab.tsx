import { GitBranch } from "lucide-react";
import { DecisionCard } from "../../components/shared/decision-card";
import { EmptyState } from "../../components/shared/empty-state";
import { Skeleton } from "../../components/ui/skeleton";
import { useObservations } from "../../hooks/use-observations";

interface TaskDecisionsTabProps {
  taskId: string;
}

/**
 * Every `decision_point` the engine recorded for this task, in chronological order — the "why did it do
 * that" view. Each fork (route/skip/auto-unblock/merge-readiness/cost-check/loop) renders as a DecisionCard:
 * the context, every option weighed with the chosen one highlighted among the roads not taken, the reasoning,
 * and the model's confidence. This is the single richest thing the engine emits; here it is first-class
 * rather than a raw JSON line in the timeline.
 */
export function TaskDecisionsTab({ taskId }: TaskDecisionsTabProps): React.JSX.Element {
  const { data: decisions, isLoading } = useObservations({ type: "decision_point", task_id: taskId, limit: 500 });

  if (isLoading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={`sk-${String(i)}`} className="h-28 w-full" />
        ))}
      </div>
    );
  }

  if (!decisions || decisions.length === 0) {
    return <EmptyState icon={<GitBranch size={32} />} title="No decisions recorded yet" />;
  }

  // The query returns newest-first; the decision trail reads best oldest-first (the order they were made).
  const chronological = [...decisions].sort((a, b) => a.start_time.localeCompare(b.start_time));

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">{chronological.length} decisions</p>
      <div className="space-y-2.5">
        {chronological.map((decision) => (
          <DecisionCard key={decision.id} observation={decision} />
        ))}
      </div>
    </div>
  );
}
