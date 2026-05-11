import { AlertTriangle } from "lucide-react";
import { Link } from "react-router";
import { EmptyState } from "../../components/shared/empty-state";
import { TimeAgo } from "../../components/shared/time-ago";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { Skeleton } from "../../components/ui/skeleton";
import { useTaskList } from "../../hooks/use-tasks";
import { cn } from "../../lib/cn";
import { ROUTES } from "../../lib/routes";

export function BlockedTasksCard(): React.JSX.Element {
  const { data: tasks, isLoading } = useTaskList("blocked");

  const hasBlocked = (tasks?.length ?? 0) > 0;

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Blocked Tasks</CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-12 w-full" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className={cn(hasBlocked && "border-amber-500/30 bg-amber-500/5")}>
      <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className={cn(hasBlocked && "text-amber-400")}>
          <span className="flex items-center gap-1.5">
            {hasBlocked && <AlertTriangle size={14} />}
            Blocked Tasks
          </span>
        </CardTitle>
        <span
          className={cn(
            "text-xs font-mono tabular-nums",
            hasBlocked ? "text-amber-400 font-medium" : "text-muted-foreground",
          )}
        >
          {tasks?.length ?? 0}
        </span>
      </CardHeader>
      <CardContent>
        {hasBlocked ? (
          <div className="space-y-2">
            {tasks?.map((task) => (
              <Link
                key={task.id}
                to={ROUTES.taskDetail(task.id)}
                className="flex items-start gap-3 rounded-md border border-amber-500/20 bg-amber-500/5 p-2.5 transition-colors hover:bg-amber-500/10"
              >
                <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-400" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{task.title}</p>
                  {task.blocked_reason && (
                    <p className="mt-0.5 truncate text-xs text-amber-400/80">{task.blocked_reason}</p>
                  )}
                </div>
                <TimeAgo timestamp={task.last_transition_at} />
              </Link>
            ))}
          </div>
        ) : (
          <EmptyState title="No blocked tasks" description="All clear" />
        )}
      </CardContent>
    </Card>
  );
}
