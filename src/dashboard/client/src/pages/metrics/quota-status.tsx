import { EmptyState } from "../../components/shared/empty-state";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { Progress } from "../../components/ui/progress";
import { Skeleton } from "../../components/ui/skeleton";
import { cn } from "../../lib/cn";
import { formatTimeAgo } from "../../lib/formatters";
import type { QuotaStatus as QuotaStatusType } from "../../types/api";

interface QuotaStatusProps {
  data: QuotaStatusType | undefined;
  isLoading: boolean;
}

/** LLM quota progress bar with usage percentage and exhaustion event history. */
export function QuotaStatus({ data, isLoading }: QuotaStatusProps): React.JSX.Element {
  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Quota Status</CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-[120px] w-full" />
        </CardContent>
      </Card>
    );
  }

  if (!data?.available) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Quota Status</CardTitle>
        </CardHeader>
        <CardContent>
          <EmptyState title="No quota data" description="Quota tracking activates after the first LLM call" />
        </CardContent>
      </Card>
    );
  }

  const live = data.live as Record<string, unknown> | null;
  const exhaustionEvents = data.exhaustion_events;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Quota Status</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {live && <QuotaLiveStatus quota={live} />}

        {exhaustionEvents.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-medium text-red-400">Recent Exhaustion Events</p>
            {exhaustionEvents.slice(0, 3).map((event, i) => (
              <div key={`exh-${String(i)}`} className="rounded-md border border-red-500/20 bg-red-500/5 p-2">
                <p className="text-xs text-red-400">
                  {typeof event["reason"] === "string" ? event["reason"] : "Quota exhausted"}
                </p>
                <p className="text-[10px] text-muted-foreground">
                  {formatTimeAgo(typeof event["observed_at"] === "string" ? event["observed_at"] : null)}
                </p>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function QuotaLiveStatus({ quota }: { quota: Record<string, unknown> }): React.JSX.Element {
  const used = typeof quota["used"] === "number" ? quota["used"] : 0;
  const limit = typeof quota["limit"] === "number" ? quota["limit"] : 0;
  const percentage = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
  const isHigh = percentage > 80;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">Usage</span>
        <span className={cn("text-xs font-mono tabular-nums", isHigh ? "text-amber-400" : "text-foreground")}>
          {percentage.toFixed(0)}%
        </span>
      </div>
      <Progress value={percentage} className={cn(isHigh && "[&>div]:bg-amber-400")} />
      {typeof quota["observed_at"] === "string" && (
        <p className="text-[10px] text-muted-foreground">Last checked: {formatTimeAgo(quota["observed_at"])}</p>
      )}
    </div>
  );
}
