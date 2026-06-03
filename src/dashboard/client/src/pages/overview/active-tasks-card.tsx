import { Play } from "lucide-react";
import { Link } from "react-router";
import { EmptyState } from "../../components/shared/empty-state";
import { PhasePipeline } from "../../components/shared/phase-pipeline";
import { StateBadge } from "../../components/shared/state-badge";
import { TimeAgo } from "../../components/shared/time-ago";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { Skeleton } from "../../components/ui/skeleton";
import { useTaskList } from "../../hooks/use-tasks";
import { ROUTES } from "../../lib/routes";

/** Card listing currently active tasks with state badges and phase pipelines. */
export function ActiveTasksCard(): React.JSX.Element {
  const { data: tasks, isLoading } = useTaskList("active");

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Active Tasks</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle>Active Tasks</CardTitle>
        <span className="text-xs font-mono tabular-nums text-muted-foreground">{tasks?.length ?? 0}</span>
      </CardHeader>
      <CardContent>
        {tasks?.length > 0 ? (
          <div className="space-y-2">
            {tasks.map((task) => (
              <Link
                key={task.id}
                to={ROUTES.taskDetail(task.id)}
                className="flex items-center gap-3 rounded-md border border-border p-2.5 transition-colors hover:bg-accent"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{task.title}</p>
                  <div className="mt-1 flex items-center gap-2">
                    <StateBadge state={task.state} />
                    <PhasePipeline
                      currentPhase={task.phase}
                      phasesRan={task.phases_ran}
                      compact={true}
                      lettersOnly={true}
                    />
                  </div>
                </div>
                <TimeAgo timestamp={task.last_transition_at} />
              </Link>
            ))}
          </div>
        ) : (
          <EmptyState icon={<Play size={24} />} title="No active tasks" />
        )}
      </CardContent>
    </Card>
  );
}
