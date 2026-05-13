import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { EmptyState } from "../../components/shared/empty-state";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { CHART_COLORS, ChartContainer, ChartTooltip } from "../../components/ui/chart";
import { Skeleton } from "../../components/ui/skeleton";

interface CostByTaskProps {
  data: Array<{ id: string; title: string; llm_cost_usd: number }>;
  isLoading: boolean;
}

/** Horizontal bar chart showing top 15 tasks by LLM cost. */
export function CostByTask({ data, isLoading }: CostByTaskProps): React.JSX.Element {
  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Cost by Task</CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-[300px] w-full" />
        </CardContent>
      </Card>
    );
  }

  if (data.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Cost by Task</CardTitle>
        </CardHeader>
        <CardContent>
          <EmptyState title="No task cost data" />
        </CardContent>
      </Card>
    );
  }

  const chartData = data.slice(0, 15).map((t) => ({
    name: t.title.length > 30 ? `${t.title.slice(0, 30)}…` : t.title,
    cost: t.llm_cost_usd,
  }));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Cost by Task (top {chartData.length})</CardTitle>
      </CardHeader>
      <CardContent>
        <ChartContainer height={Math.max(200, chartData.length * 32)}>
          <BarChart data={chartData} layout="vertical" margin={{ top: 5, right: 10, left: 10, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="oklch(0.25 0 0)" horizontal={false} />
            <XAxis
              type="number"
              tick={{ fill: "oklch(0.556 0 0)", fontSize: 10 }}
              tickFormatter={(v: number) => `$${String(v)}`}
              axisLine={{ stroke: "oklch(0.3 0 0)" }}
            />
            <YAxis
              type="category"
              dataKey="name"
              tick={{ fill: "oklch(0.556 0 0)", fontSize: 10 }}
              axisLine={{ stroke: "oklch(0.3 0 0)" }}
              width={180}
            />
            <ChartTooltip formatter={(value: number) => [`$${value.toFixed(4)}`, "Cost"]} />
            <Bar dataKey="cost" fill={CHART_COLORS[1]} radius={[0, 3, 3, 0]} />
          </BarChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}
