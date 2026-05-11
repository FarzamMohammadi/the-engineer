import { Radio } from "lucide-react";
import { EmptyState } from "../../components/shared/empty-state";
import { Badge } from "../../components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { Skeleton } from "../../components/ui/skeleton";
import { useObservations } from "../../hooks/use-observations";
import { cn } from "../../lib/cn";
import { OBSERVATION_TYPE_LABELS } from "../../lib/constants";
import { formatTimestamp } from "../../lib/formatters";
import type { ObservationType } from "../../types/api";

export function ActivitySnapshot(): React.JSX.Element {
  const { data: observations, isLoading } = useObservations({ limit: 10 });

  if (isLoading) {
    return (
      <Card className="col-span-full">
        <CardHeader>
          <CardTitle>Recent Activity</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <Skeleton className="h-6 w-full" />
          <Skeleton className="h-6 w-full" />
          <Skeleton className="h-6 w-full" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="col-span-full">
      <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle>Recent Activity</CardTitle>
        <Radio size={16} className="text-muted-foreground" />
      </CardHeader>
      <CardContent>
        {observations?.length ? (
          <div className="space-y-1">
            {observations.map((obs) => (
              <div
                key={obs.id}
                className="flex items-center gap-3 rounded-md px-2 py-1.5 text-xs transition-colors hover:bg-accent"
              >
                <span className="w-16 shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
                  {formatTimestamp(obs.start_time)}
                </span>
                <Badge variant="outline" className="w-16 justify-center text-[10px]">
                  {OBSERVATION_TYPE_LABELS[obs.type as ObservationType] ?? obs.type}
                </Badge>
                <span className="min-w-0 flex-1 truncate text-foreground">{obs.name}</span>
                <LevelDot level={obs.level} />
              </div>
            ))}
          </div>
        ) : (
          <EmptyState title="No activity yet" description="Observations will appear here as the daemon runs" />
        )}
      </CardContent>
    </Card>
  );
}

function LevelDot({ level }: { level: string }): React.JSX.Element {
  return (
    <span
      className={cn(
        "h-1.5 w-1.5 rounded-full",
        level === "error" && "bg-red-400",
        level === "warn" && "bg-amber-400",
        level === "info" && "bg-blue-400",
        level === "debug" && "bg-zinc-500",
      )}
      title={level}
    />
  );
}
