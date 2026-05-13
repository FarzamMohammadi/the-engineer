import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { EmptyState } from "../../components/shared/empty-state";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { CHART_COLORS, ChartContainer, ChartTooltip } from "../../components/ui/chart";
import { Skeleton } from "../../components/ui/skeleton";

interface CostByPhaseProps {
  data: Array<{ phase: string; spend_usd: number; executions: number }>;
  isLoading: boolean;
}

export function CostByPhase({ data, isLoading }: CostByPhaseProps): React.JSX.Element {
  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Cost by Phase</CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-[250px] w-full" />
        </CardContent>
      </Card>
    );
  }

  if (data.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Cost by Phase</CardTitle>
        </CardHeader>
        <CardContent>
          <EmptyState title="No phase cost data" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Cost by Phase</CardTitle>
      </CardHeader>
      <CardContent>
        <ChartContainer height={250}>
          <BarChart data={data} margin={{ top: 5, right: 10, left: 10, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="oklch(0.25 0 0)" />
            <XAxis
              dataKey="phase"
              tick={{ fill: "oklch(0.556 0 0)", fontSize: 10 }}
              axisLine={{ stroke: "oklch(0.3 0 0)" }}
            />
            <YAxis
              tick={{ fill: "oklch(0.556 0 0)", fontSize: 10 }}
              tickFormatter={(v: number) => `$${String(v)}`}
              axisLine={{ stroke: "oklch(0.3 0 0)" }}
              width={50}
            />
            <ChartTooltip
              formatter={(value: number, name: string) => [
                name === "spend_usd" ? `$${value.toFixed(4)}` : String(value),
                name === "spend_usd" ? "Cost" : "Executions",
              ]}
            />
            <Bar dataKey="spend_usd" fill={CHART_COLORS[2]} radius={[3, 3, 0, 0]} />
          </BarChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}
