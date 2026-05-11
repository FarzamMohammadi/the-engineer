import { AlertTriangle } from "lucide-react";
import { EmptyState } from "../../components/shared/empty-state";

export function ErrorsPage(): React.JSX.Element {
  return (
    <div className="space-y-6">
      <h1 className="text-lg font-semibold">Errors</h1>
      <EmptyState
        icon={<AlertTriangle size={32} />}
        title="Error viewer coming in Session 7"
        description="Consolidated error view with task click-through"
      />
    </div>
  );
}
