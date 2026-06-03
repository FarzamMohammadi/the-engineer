import { Trash2 } from "lucide-react";
import { EmptyState } from "../../components/shared/empty-state";
import { TimeAgo } from "../../components/shared/time-ago";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { Skeleton } from "../../components/ui/skeleton";
import { useEvents } from "../../hooks/use-events";
import type { DomainEvent } from "../../types/api";

/** The reaper sweep summary, read out of a `system.reap_completed` event payload (mirrors `ReapStats`). */
interface ReapSummary {
  scanned: number;
  reaped: number;
  skipped_in_flight: number;
  deferred: number;
  failed: number;
  duration_ms: number;
}

/** Narrow a reap event's opaque payload into the summary numbers, defaulting any absent field to 0. */
function readReapSummary(event: DomainEvent): ReapSummary {
  const p = event.payload;
  const num = (key: string): number => (typeof p[key] === "number" ? (p[key] as number) : 0);
  return {
    scanned: num("scanned"),
    reaped: num("reaped"),
    skipped_in_flight: num("skipped_in_flight"),
    deferred: num("deferred"),
    failed: num("failed"),
    duration_ms: num("duration_ms"),
  };
}

/**
 * Recent workspace-cleanup sweeps. The reaper's in-memory `getLastRun()` lives in the daemon process and is
 * unreachable from the dashboard's separate process, so each sweep publishes a durable `system.reap_completed`
 * event — this card reads them back. Most sweeps are no-ops (nothing terminal to reap), so it leads with the
 * latest sweep and surfaces a failed count prominently (a persistently-failing reap is the silent-rot case).
 */
export function CleanupCard(): React.JSX.Element {
  const { data: events, isLoading } = useEvents({ type: "system.reap_completed", limit: 5 });

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Cleanup</CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-16 w-full" />
        </CardContent>
      </Card>
    );
  }

  const sweeps = events ?? [];
  const latest = sweeps[0];
  const hasFailures = latest ? readReapSummary(latest).failed > 0 : false;

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle>
          <span className="flex items-center gap-1.5">
            <Trash2 size={14} className="text-muted-foreground" />
            Cleanup
          </span>
        </CardTitle>
        {latest && <TimeAgo timestamp={latest.timestamp} />}
      </CardHeader>
      <CardContent>
        {latest ? (
          <div className="space-y-3">
            <SweepSummary summary={readReapSummary(latest)} highlightFailures={hasFailures} />
            {sweeps.length > 1 && (
              <div className="space-y-1 border-t border-border pt-2">
                {sweeps.slice(1).map((sweep) => (
                  <PastSweepRow key={sweep.id} event={sweep} />
                ))}
              </div>
            )}
          </div>
        ) : (
          <EmptyState title="No sweeps yet" description="The reaper records each cleanup sweep here" />
        )}
      </CardContent>
    </Card>
  );
}

function SweepSummary({
  summary,
  highlightFailures,
}: {
  summary: ReapSummary;
  highlightFailures: boolean;
}): React.JSX.Element {
  return (
    <div className="grid grid-cols-3 gap-2 text-center">
      <Stat label="Reaped" value={summary.reaped} />
      <Stat label="Deferred" value={summary.deferred} />
      <Stat label="Failed" value={summary.failed} danger={highlightFailures} />
    </div>
  );
}

function Stat({ label, value, danger = false }: { label: string; value: number; danger?: boolean }): React.JSX.Element {
  return (
    <div>
      <p className={`font-mono text-lg tabular-nums ${danger ? "text-red-400" : "text-foreground"}`}>{value}</p>
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground/60">{label}</p>
    </div>
  );
}

function PastSweepRow({ event }: { event: DomainEvent }): React.JSX.Element {
  const s = readReapSummary(event);
  return (
    <div className="flex items-center justify-between text-[11px] text-muted-foreground">
      <span>
        {s.reaped} reaped{s.failed > 0 ? <span className="text-red-400">, {s.failed} failed</span> : null}
      </span>
      <TimeAgo timestamp={event.timestamp} />
    </div>
  );
}
