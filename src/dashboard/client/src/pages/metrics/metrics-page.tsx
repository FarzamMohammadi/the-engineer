import { BarChart3 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { useCostMetrics, useQuotaStatus } from "../../hooks/use-metrics";
import { formatCurrency } from "../../lib/formatters";
import { CostByPhase } from "./cost-by-phase";
import { CostByTask } from "./cost-by-task";
import { CostTrendChart } from "./cost-trend-chart";
import { PhasePerformance } from "./phase-performance";
import { QuotaStatus } from "./quota-status";
import { TokenUsage } from "./token-usage";

/** Metrics dashboard with spend cards, cost charts, token stats, and quota status. */
export function MetricsPage(): React.JSX.Element {
  const { data: cost, isLoading: costLoading } = useCostMetrics();
  const { data: quota, isLoading: quotaLoading } = useQuotaStatus();

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <h1 className="text-lg font-semibold">Metrics</h1>
        <BarChart3 size={18} className="text-muted-foreground" />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <SpendCard label="Today" value={cost?.today_spend_usd} isLoading={costLoading} />
        <SpendCard label="This Month" value={cost?.month_spend_usd} isLoading={costLoading} />
      </div>

      <TokenUsage data={cost?.token_totals} isLoading={costLoading} />
      <CostTrendChart data={cost?.per_day ?? []} isLoading={costLoading} />

      <div className="grid gap-4 lg:grid-cols-2">
        <CostByTask data={cost?.per_task ?? []} isLoading={costLoading} />
        <CostByPhase data={cost?.per_phase ?? []} isLoading={costLoading} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <PhasePerformance data={cost?.per_phase ?? []} isLoading={costLoading} />
        <QuotaStatus data={quota} isLoading={quotaLoading} />
      </div>
    </div>
  );
}

function SpendCard({
  label,
  value,
  isLoading,
}: { label: string; value: number | undefined; isLoading: boolean }): React.JSX.Element {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle>{label}</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="h-8 w-20 animate-pulse rounded bg-muted" />
        ) : (
          <span className="text-2xl font-bold font-mono tabular-nums">{formatCurrency(value)}</span>
        )}
      </CardContent>
    </Card>
  );
}
