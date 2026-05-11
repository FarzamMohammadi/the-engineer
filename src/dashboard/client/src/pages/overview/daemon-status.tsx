import { Server } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { Skeleton } from "../../components/ui/skeleton";
import { useSystemStatus } from "../../hooks/use-system-status";
import { cn } from "../../lib/cn";

export function DaemonStatus(): React.JSX.Element {
  const { data: status, isLoading } = useSystemStatus();

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Daemon</CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-8 w-full" />
        </CardContent>
      </Card>
    );
  }

  const running = status?.daemon_running ?? false;

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle>Daemon</CardTitle>
        <Server size={16} className="text-muted-foreground" />
      </CardHeader>
      <CardContent>
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "h-2.5 w-2.5 rounded-full",
              running ? "bg-emerald-400 shadow-[0_0_8px] shadow-emerald-400/50" : "bg-red-400",
            )}
          />
          <span className="text-lg font-semibold">{running ? "Running" : "Stopped"}</span>
        </div>
        {status?.daemon_pid && (
          <p className="mt-1 text-xs text-muted-foreground">
            PID {status.daemon_pid}
            {status.llm_provider && <> &middot; {status.llm_provider}</>}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
