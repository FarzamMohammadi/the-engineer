import { Database } from "lucide-react";
import { EmptyState } from "../../components/shared/empty-state";
import { TimeAgo } from "../../components/shared/time-ago";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { Skeleton } from "../../components/ui/skeleton";
import { useEvents } from "../../hooks/use-events";
import type { DomainEvent } from "../../types/api";

/** One pruned table's tally, read out of a `system.cleanup_completed` payload (mirrors `CleanupStats`). */
interface TableTally {
  name: string;
  deleted: number;
  remaining: number;
}

/** The data-lifecycle sweep summary, read out of a `system.cleanup_completed` event payload. */
interface CleanupSummary {
  tables: TableTally[];
  totalDeleted: number;
  blobsDeleted: number;
  vacuumRan: boolean;
  durationMs: number;
}

/** Narrow a cleanup event's opaque payload into the summary numbers, defaulting any absent field to 0. */
function readCleanupSummary(event: DomainEvent): CleanupSummary {
  const p = event.payload;
  const num = (value: unknown): number => (typeof value === "number" ? value : 0);

  const rawTables = (p["tables"] ?? {}) as Record<string, { deleted?: unknown; remaining?: unknown }>;
  const tables: TableTally[] = Object.entries(rawTables).map(([name, tally]) => ({
    name,
    deleted: num(tally.deleted),
    remaining: num(tally.remaining),
  }));
  const totalDeleted = tables.reduce((sum, t) => sum + t.deleted, 0);

  return {
    tables,
    totalDeleted,
    blobsDeleted: num(p["blobs_deleted"]),
    vacuumRan: p["vacuum_ran"] === true,
    durationMs: num(p["duration_ms"]),
  };
}

/**
 * Recent data-lifecycle retention sweeps. The manager's in-memory `getLastRun()` lives in the daemon process
 * and is unreachable from the dashboard's separate process, so each sweep publishes a durable
 * `system.cleanup_completed` event — this card reads them back. It is the sibling of the workspace-reaper
 * `CleanupCard`: that one reaps git branches, this one prunes aged SQLite rows and orphaned blobs. Most sweeps
 * prune nothing, but a 0-row sweep still emits — proof the service is alive and the retention floor is holding.
 */
export function DataLifecycleCard(): React.JSX.Element {
  const { data: events, isLoading } = useEvents({ type: "system.cleanup_completed", limit: 5 });

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Data Lifecycle</CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-16 w-full" />
        </CardContent>
      </Card>
    );
  }

  const sweeps = events ?? [];
  const latest = sweeps[0];

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle>
          <span className="flex items-center gap-1.5">
            <Database size={14} className="text-muted-foreground" />
            Data Lifecycle
          </span>
        </CardTitle>
        {latest && <TimeAgo timestamp={latest.timestamp} />}
      </CardHeader>
      <CardContent>
        {latest ? (
          <div className="space-y-3">
            <SweepSummary summary={readCleanupSummary(latest)} />
            {sweeps.length > 1 && (
              <div className="space-y-1 border-t border-border pt-2">
                {sweeps.slice(1).map((sweep) => (
                  <PastSweepRow key={sweep.id} event={sweep} />
                ))}
              </div>
            )}
          </div>
        ) : (
          <EmptyState title="No sweeps yet" description="The retention sweep records each cleanup here" />
        )}
      </CardContent>
    </Card>
  );
}

function SweepSummary({ summary }: { summary: CleanupSummary }): React.JSX.Element {
  return (
    <div className="space-y-2">
      <p className="text-[11px] text-muted-foreground">
        {summary.blobsDeleted} blobs · vacuum {summary.vacuumRan ? "ran" : "skipped"} · {summary.durationMs}ms
      </p>
      <div className="space-y-1">
        {summary.tables.map((table) => (
          <TableRow key={table.name} tally={table} />
        ))}
      </div>
    </div>
  );
}

function TableRow({ tally }: { tally: TableTally }): React.JSX.Element {
  return (
    <div className="flex items-center justify-between text-[11px]">
      <span className="text-muted-foreground">{tally.name}</span>
      <span className="font-mono tabular-nums text-foreground">
        {tally.deleted} deleted
        <span className="text-muted-foreground/60"> · {tally.remaining} kept</span>
      </span>
    </div>
  );
}

function PastSweepRow({ event }: { event: DomainEvent }): React.JSX.Element {
  const s = readCleanupSummary(event);
  return (
    <div className="flex items-center justify-between text-[11px] text-muted-foreground">
      <span>
        {s.totalDeleted} rows deleted{s.blobsDeleted > 0 ? `, ${String(s.blobsDeleted)} blobs` : null}
      </span>
      <TimeAgo timestamp={event.timestamp} />
    </div>
  );
}
