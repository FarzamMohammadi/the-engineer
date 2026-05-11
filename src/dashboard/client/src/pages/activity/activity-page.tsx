import { Activity } from "lucide-react";
import { EmptyState } from "../../components/shared/empty-state";

export function ActivityPage(): React.JSX.Element {
  return (
    <div className="space-y-6">
      <h1 className="text-lg font-semibold">Activity</h1>
      <EmptyState
        icon={<Activity size={32} />}
        title="Activity feed coming in Session 7"
        description="Real-time SSE stream viewer with filtering"
      />
    </div>
  );
}
