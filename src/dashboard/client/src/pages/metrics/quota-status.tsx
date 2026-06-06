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

/** Agent quota progress bars showing each window's live usage percentage. */
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
          <EmptyState title="No quota data" description="Quota tracking activates after the first agent run" />
        </CardContent>
      </Card>
    );
  }

  const live = data.live;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Quota Status</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">{live && <QuotaLiveStatus quota={live} />}</CardContent>
    </Card>
  );
}

// The live payload is the agent's QuotaStatus: { windows: [{ window_type, used_percentage, is_exhausted, resets_at }],
// is_rate_limited, ... } plus the observed_at the /quota reader stamps on. Render each window's real usage — never a
// synthesized used/limit ratio (those fields are not on the contract).
function QuotaLiveStatus({ quota }: { quota: Record<string, unknown> }): React.JSX.Element {
  const windows = Array.isArray(quota["windows"]) ? (quota["windows"] as Record<string, unknown>[]) : [];
  const isRateLimited = quota["is_rate_limited"] === true;
  const observedAt = typeof quota["observed_at"] === "string" ? quota["observed_at"] : null;

  return (
    <div className="space-y-3">
      {isRateLimited && (
        <div className="rounded-md border border-red-500/30 bg-red-500/10 px-2 py-1">
          <p className="text-xs font-medium text-red-400">Rate limited — waiting for a window to reset</p>
        </div>
      )}
      {windows.length === 0 ? (
        <p className="text-xs text-muted-foreground">No active quota windows reported</p>
      ) : (
        windows.map((window, i) => <QuotaWindowBar key={`win-${String(i)}`} window={window} />)
      )}
      {observedAt && <p className="text-[10px] text-muted-foreground">Last checked: {formatTimeAgo(observedAt)}</p>}
    </div>
  );
}

/** One quota window's usage bar. `used_percentage` may be null when the provider does not report it. */
function QuotaWindowBar({ window }: { window: Record<string, unknown> }): React.JSX.Element {
  const label = typeof window["window_type"] === "string" ? window["window_type"] : "Quota window";
  const isExhausted = window["is_exhausted"] === true;
  const percentage =
    typeof window["used_percentage"] === "number" ? Math.min(100, Math.max(0, window["used_percentage"])) : null;
  const isHigh = isExhausted || (percentage !== null && percentage > 80);

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">{label}</span>
        <span className={cn("text-xs font-mono tabular-nums", isHigh ? "text-amber-400" : "text-foreground")}>
          {percentage === null ? "—" : `${percentage.toFixed(0)}%`}
        </span>
      </div>
      <Progress value={percentage ?? 0} className={cn(isHigh && "[&>div]:bg-amber-400")} />
    </div>
  );
}
