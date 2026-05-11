import { ListTodo } from "lucide-react";
import { EmptyState } from "../../components/shared/empty-state";

export function TasksPage(): React.JSX.Element {
  return (
    <div className="space-y-6">
      <h1 className="text-lg font-semibold">Tasks</h1>
      <EmptyState
        icon={<ListTodo size={32} />}
        title="Task list coming in Session 6"
        description="Full task table with filtering, sorting, and immersive detail view"
      />
    </div>
  );
}
