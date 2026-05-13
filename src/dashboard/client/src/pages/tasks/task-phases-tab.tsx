import { Layers } from "lucide-react";
import { CostDisplay } from "../../components/shared/cost-display";
import { EmptyState } from "../../components/shared/empty-state";
import { Badge } from "../../components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { Skeleton } from "../../components/ui/skeleton";
import { useTaskPhases } from "../../hooks/use-tasks";
import { cn } from "../../lib/cn";
import { PHASE_LABELS, PHASE_ORDER } from "../../lib/constants";
import { formatDuration } from "../../lib/formatters";
import type { Observation, Phase } from "../../types/api";

interface TaskPhasesTabProps {
  taskId: string;
}

export function TaskPhasesTab({ taskId }: TaskPhasesTabProps): React.JSX.Element {
  const { data: phases, isLoading } = useTaskPhases(taskId);

  if (isLoading) {
    return (
      <div className="grid gap-3 md:grid-cols-2">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={`sk-${String(i)}`} className="h-32 w-full" />
        ))}
      </div>
    );
  }

  if (!phases || phases.length === 0) {
    return <EmptyState icon={<Layers size={32} />} title="No phases executed yet" />;
  }

  const phaseMap = groupByPhase(phases);
  const maxDuration = Math.max(...phases.map((p) => p.duration_ms ?? 0), 1);

  return (
    <div className="grid gap-3 md:grid-cols-2">
      {PHASE_ORDER.map((phaseName) => {
        const entries = phaseMap.get(phaseName);
        if (!entries) return null;
        return <PhaseCard key={phaseName} phaseName={phaseName} entries={entries} maxDuration={maxDuration} />;
      })}
    </div>
  );
}

interface PhaseCardProps {
  phaseName: Phase;
  entries: Observation[];
  maxDuration: number;
}

function PhaseCard({ phaseName, entries, maxDuration }: PhaseCardProps): React.JSX.Element {
  const totalDuration = entries.reduce((sum, e) => sum + (e.duration_ms ?? 0), 0);
  const totalCost = entries.reduce((sum, e) => {
    const meta = e.metadata as Record<string, unknown> | null;
    return sum + (typeof meta?.["cost_usd"] === "number" ? meta["cost_usd"] : 0);
  }, 0);
  const latestStatus = entries[entries.length - 1]?.status ?? "ok";
  const barWidth = maxDuration > 0 ? (totalDuration / maxDuration) * 100 : 0;

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle>{PHASE_LABELS[phaseName] ?? phaseName}</CardTitle>
          <Badge variant={latestStatus === "error" ? "destructive" : "secondary"} className="text-[10px]">
            {latestStatus}
          </Badge>
        </div>
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
            <div
              className={cn(
                "h-full rounded-full transition-all",
                latestStatus === "error" ? "bg-destructive" : "bg-primary",
              )}
              style={{ width: `${barWidth}%` }}
            />
          </div>
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>{formatDuration(totalDuration)}</span>
            <CostDisplay amount={totalCost} size="sm" />
          </div>
          <div className="text-xs text-muted-foreground">
            {entries.length} {entries.length === 1 ? "execution" : "executions"}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function groupByPhase(observations: Observation[]): Map<Phase, Observation[]> {
  const map = new Map<Phase, Observation[]>();
  for (const obs of observations) {
    const phase = obs.name as Phase;
    const arr = map.get(phase) ?? [];
    arr.push(obs);
    map.set(phase, arr);
  }
  return map;
}
