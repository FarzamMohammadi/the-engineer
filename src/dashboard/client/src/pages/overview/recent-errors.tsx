import { AlertCircle } from "lucide-react";
import { EmptyState } from "../../components/shared/empty-state";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { Skeleton } from "../../components/ui/skeleton";
import { useObservations } from "../../hooks/use-observations";
import { cn } from "../../lib/cn";
import { formatTimeAgo } from "../../lib/formatters";

export function RecentErrors(): React.JSX.Element {
  const { data: errors, isLoading } = useObservations({ level: "error", limit: 5 });

  const hasErrors = (errors?.length ?? 0) > 0;

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Recent Errors</CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-16 w-full" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className={cn(hasErrors && "border-red-500/20")}>
      <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className={cn(hasErrors && "text-red-400")}>Recent Errors</CardTitle>
        <span
          className={cn(
            "text-xs font-mono tabular-nums",
            hasErrors ? "text-red-400 font-medium" : "text-muted-foreground",
          )}
        >
          {errors?.length ?? 0}
        </span>
      </CardHeader>
      <CardContent>
        {hasErrors ? (
          <div className="space-y-2">
            {errors?.map((error) => (
              <div
                key={error.id}
                className="flex items-start gap-2 rounded-md border border-red-500/10 bg-red-500/5 p-2"
              >
                <AlertCircle size={12} className="mt-0.5 shrink-0 text-red-400" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-medium">{error.name}</p>
                  {error.error_message && (
                    <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{error.error_message}</p>
                  )}
                </div>
                <span className="shrink-0 text-[10px] text-muted-foreground">{formatTimeAgo(error.start_time)}</span>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState title="No errors" description="System healthy" />
        )}
      </CardContent>
    </Card>
  );
}
