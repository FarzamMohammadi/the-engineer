import { BarChart3 } from "lucide-react";
import { EmptyState } from "../../components/shared/empty-state";

export function MetricsPage(): React.JSX.Element {
  return (
    <div className="space-y-6">
      <h1 className="text-lg font-semibold">Metrics</h1>
      <EmptyState
        icon={<BarChart3 size={32} />}
        title="Metrics & cost charts coming in Session 7"
        description="Cost trends, token usage, phase performance, and quota status"
      />
    </div>
  );
}
