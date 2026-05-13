import { DollarSign } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { Skeleton } from "../../components/ui/skeleton";
import { useCostMetrics } from "../../hooks/use-metrics";
import { formatCurrency } from "../../lib/formatters";

/** Card showing today's and this month's LLM spend in USD. */
export function CostTicker(): React.JSX.Element {
  const { data: metrics, isLoading } = useCostMetrics();

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Cost</CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-8 w-full" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle>Cost</CardTitle>
        <DollarSign size={16} className="text-muted-foreground" />
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          <CostRow label="Today" amount={metrics?.today_spend_usd ?? 0} />
          <CostRow label="This month" amount={metrics?.month_spend_usd ?? 0} />
        </div>
      </CardContent>
    </Card>
  );
}

function CostRow({ label, amount }: { label: string; amount: number }): React.JSX.Element {
  return (
    <div className="flex items-center justify-between">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="font-mono text-sm tabular-nums font-semibold">{formatCurrency(amount)}</span>
    </div>
  );
}
