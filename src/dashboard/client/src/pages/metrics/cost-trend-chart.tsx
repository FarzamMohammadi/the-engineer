import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { CHART_COLORS, ChartContainer, ChartTooltip } from "../../components/ui/chart";
import { Skeleton } from "../../components/ui/skeleton";

interface CostTrendChartProps {
  data: Array<{ day: string; spend_usd: number }>;
  isLoading: boolean;
}

export function CostTrendChart({ data, isLoading }: CostTrendChartProps): React.JSX.Element {
  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Cost Trend</CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-[300px] w-full" />
        </CardContent>
      </Card>
    );
  }

  const sorted = [...data].sort((a, b) => a.day.localeCompare(b.day));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Cost Trend (last 30 days)</CardTitle>
      </CardHeader>
      <CardContent>
        <ChartContainer>
          <BarChart data={sorted} margin={{ top: 5, right: 10, left: 10, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="oklch(0.25 0 0)" />
            <XAxis
              dataKey="day"
              tick={{ fill: "oklch(0.556 0 0)", fontSize: 10 }}
              tickFormatter={(v: string) => v.slice(5)}
              axisLine={{ stroke: "oklch(0.3 0 0)" }}
            />
            <YAxis
              tick={{ fill: "oklch(0.556 0 0)", fontSize: 10 }}
              tickFormatter={(v: number) => `$${String(v)}`}
              axisLine={{ stroke: "oklch(0.3 0 0)" }}
              width={50}
            />
            <ChartTooltip formatter={(value: number) => [`$${value.toFixed(4)}`, "Spend"]} />
            <Bar dataKey="spend_usd" fill={CHART_COLORS[0]} radius={[3, 3, 0, 0]} />
          </BarChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}
