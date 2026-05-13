import { ListTodo } from "lucide-react";
import { useMemo, useState } from "react";
import { EmptyState } from "../../components/shared/empty-state";
import { Skeleton } from "../../components/ui/skeleton";
import { useTaskList } from "../../hooks/use-tasks";
import { TaskFilters } from "./task-filters";
import { TaskTable } from "./task-table";

/** Task list page with state-based filtering and sortable table. */
export function TasksPage(): React.JSX.Element {
  const [stateFilter, setStateFilter] = useState<string | undefined>(undefined);
  const { data: tasks, isLoading } = useTaskList();

  const counts = useMemo(() => {
    const map: Record<string, number> = {};
    if (tasks) {
      for (const t of tasks) {
        map[t.state] = (map[t.state] ?? 0) + 1;
      }
    }
    return map;
  }, [tasks]);

  const filtered = useMemo(() => {
    if (!tasks) {
      return [];
    }
    if (!stateFilter) {
      return tasks;
    }
    return tasks.filter((t) => t.state === stateFilter);
  }, [tasks, stateFilter]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Tasks</h1>
      </div>
      <TaskFilters selected={stateFilter} onSelect={setStateFilter} counts={counts} />
      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={`sk-${String(i)}`} className="h-12 w-full" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={<ListTodo size={32} />}
          title={stateFilter ? `No ${stateFilter} tasks` : "No tasks yet"}
          description="Tasks will appear here when The Engineer starts working"
        />
      ) : (
        <TaskTable tasks={filtered} />
      )}
    </div>
  );
}
