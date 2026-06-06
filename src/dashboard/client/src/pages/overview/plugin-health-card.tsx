import { HeartPulse } from "lucide-react";
import { EmptyState } from "../../components/shared/empty-state";
import { TimeAgo } from "../../components/shared/time-ago";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { Skeleton } from "../../components/ui/skeleton";
import { usePluginHealth } from "../../hooks/use-plugin-health";
import { cn } from "../../lib/cn";
import type { PluginHealthRecord, PluginHealthState } from "../../types/api";

/** Tailwind badge classes per health state. `failed` reads as an alarm; `healthy` is quiet. */
const HEALTH_STATE_BADGE: Record<PluginHealthState, string> = {
  healthy: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",
  unhealthy: "bg-amber-500/20 text-amber-400 border-amber-500/30",
  failed: "bg-red-500/20 text-red-400 border-red-500/30",
};

const HEALTH_STATE_DOT: Record<PluginHealthState, string> = {
  healthy: "bg-emerald-400",
  unhealthy: "bg-amber-400",
  failed: "bg-red-400",
};

/**
 * Current health of every registered plugin (advisory — selection never reads it; this is a signal to the
 * owner, not a gate). The registry caches a current-state snapshot in the `_meta` table every health-check
 * cycle (its in-memory state is unreachable from the dashboard's separate process), and
 * `/api/system/plugin-health` reads it back. Plugin-agnostic: it renders whatever manifest identity is
 * registered — it never hardcodes a plugin name or type (Plugin Opacity). A failed→healthy flip shows here as
 * the state returns to healthy. The sibling of the event-stream `/health` view: that shows the trail of
 * changes; this shows the always-current state.
 */
export function PluginHealthCard(): React.JSX.Element {
  const { data, isLoading } = usePluginHealth();

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Plugin Health</CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-16 w-full" />
        </CardContent>
      </Card>
    );
  }

  const records = data?.records ?? [];
  // Surface failed/unhealthy plugins first so a degradation is the first thing the owner sees.
  const sorted = [...records].sort((a, b) => stateWeight(b.state) - stateWeight(a.state));

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle>
          <span className="flex items-center gap-1.5">
            <HeartPulse size={14} className="text-muted-foreground" />
            Plugin Health
          </span>
        </CardTitle>
        {data?.checked_at && <TimeAgo timestamp={data.checked_at} />}
      </CardHeader>
      <CardContent>
        {sorted.length > 0 ? (
          <div className="space-y-2">
            {sorted.map((record) => (
              <PluginHealthRow key={record.plugin_id} record={record} />
            ))}
          </div>
        ) : (
          <EmptyState
            title="No plugins reporting"
            description="Plugin health appears after the daemon's first health-check cycle"
          />
        )}
      </CardContent>
    </Card>
  );
}

function PluginHealthRow({ record }: { record: PluginHealthRecord }): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-2 text-[11px]">
      <span className="truncate font-mono text-foreground" title={record.plugin_id}>
        {record.plugin_id}
      </span>
      <span className="flex shrink-0 items-center gap-2">
        {record.consecutive_failures > 0 && (
          <span className="text-muted-foreground/70">{record.consecutive_failures} fail</span>
        )}
        {record.last_check_at && <TimeAgo timestamp={record.last_check_at} className="text-[10px]" />}
        <HealthBadge state={record.state} />
      </span>
    </div>
  );
}

function HealthBadge({ state }: { state: PluginHealthState }): React.JSX.Element {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-medium",
        HEALTH_STATE_BADGE[state] ?? HEALTH_STATE_BADGE.unhealthy,
      )}
    >
      <span className={cn("h-1.5 w-1.5 rounded-full", HEALTH_STATE_DOT[state] ?? HEALTH_STATE_DOT.unhealthy)} />
      {state}
    </span>
  );
}

/** Sort weight so failed > unhealthy > healthy — degradations float to the top of the card. */
function stateWeight(state: PluginHealthState): number {
  if (state === "failed") {
    return 2;
  }
  if (state === "unhealthy") {
    return 1;
  }
  return 0;
}
