import { EmptyState } from "../../components/shared/empty-state";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { Skeleton } from "../../components/ui/skeleton";
import { formatCurrency, formatDuration } from "../../lib/formatters";

interface PhasePerformanceProps {
  data: Array<{
    phase: string;
    spend_usd: number;
    duration_ms: number;
    llm_iterations: number;
    executions: number;
  }>;
  isLoading: boolean;
}

/** Average cost, duration, and execution count per pipeline phase. */
export function PhasePerformance({ data, isLoading }: PhasePerformanceProps): React.JSX.Element {
  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Phase Performance</CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-[200px] w-full" />
        </CardContent>
      </Card>
    );
  }

  if (data.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Phase Performance</CardTitle>
        </CardHeader>
        <CardContent>
          <EmptyState title="No phase data" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Phase Performance</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          {data.map((phase) => {
            const avgCost = phase.executions > 0 ? phase.spend_usd / phase.executions : 0;
            const avgDuration = phase.executions > 0 ? phase.duration_ms / phase.executions : 0;
            return (
              <div key={phase.phase} className="flex items-center justify-between rounded-md border border-border p-3">
                <div>
                  <p className="text-sm font-medium capitalize">{phase.phase.replace(/_/g, " ")}</p>
                  <p className="text-xs text-muted-foreground">
                    {phase.executions} run{phase.executions !== 1 ? "s" : ""} · {phase.llm_iterations} LLM calls
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-sm font-mono tabular-nums">{formatCurrency(avgCost)} avg</p>
                  <p className="text-xs text-muted-foreground font-mono tabular-nums">
                    {formatDuration(avgDuration)} avg
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
