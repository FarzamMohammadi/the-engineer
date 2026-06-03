import { ListTodo } from "lucide-react";
import { useMemo, useState } from "react";
import { EmptyState } from "../../components/shared/empty-state";
import { Skeleton } from "../../components/ui/skeleton";
import { useTaskList } from "../../hooks/use-tasks";
import type { BlockReason } from "../../types/api";
import { TaskFilters } from "./task-filters";
import { TaskTable } from "./task-table";

/** Task list page with state-based filtering and sortable table. */
export function TasksPage(): React.JSX.Element {
  const [stateFilter, setStateFilter] = useState<string | undefined>(undefined);
  const [blockReasonFilter, setBlockReasonFilter] = useState<BlockReason | undefined>(undefined);
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

  // Per-reason counts among blocked tasks — drives the secondary block-reason chip row.
  const blockReasonCounts = useMemo(() => {
    const map: Record<string, number> = {};
    if (tasks) {
      for (const t of tasks) {
        if (t.state === "blocked" && t.block_reason) {
          map[t.block_reason] = (map[t.block_reason] ?? 0) + 1;
        }
      }
    }
    return map;
  }, [tasks]);

  const filtered = useMemo(() => {
    if (!tasks) {
      return [];
    }
    return tasks.filter((t) => {
      if (stateFilter && t.state !== stateFilter) {
        return false;
      }
      // The block-reason cut only narrows blocked tasks; it never hides tasks in other states.
      if (blockReasonFilter && t.state === "blocked" && t.block_reason !== blockReasonFilter) {
        return false;
      }
      return true;
    });
  }, [tasks, stateFilter, blockReasonFilter]);

  function handleSelectState(state: string | undefined): void {
    setStateFilter(state);
    // Leaving the blocked view drops a reason cut that would otherwise silently apply to nothing.
    if (state !== "blocked") {
      setBlockReasonFilter(undefined);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Tasks</h1>
      </div>
      <TaskFilters
        selected={stateFilter}
        onSelect={handleSelectState}
        counts={counts}
        blockReason={blockReasonFilter}
        onSelectBlockReason={setBlockReasonFilter}
        blockReasonCounts={blockReasonCounts}
      />
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
