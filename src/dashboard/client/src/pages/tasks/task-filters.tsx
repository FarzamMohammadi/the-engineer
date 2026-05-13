import { cn } from "../../lib/cn";
import { STATE_DOT_COLORS, STATE_LABELS } from "../../lib/constants";
import type { TaskState } from "../../types/api";

const FILTER_STATES: TaskState[] = [
  "active",
  "blocked",
  "queued",
  "requirements_gathering",
  "review_pending",
  "completed",
  "failed",
];

interface TaskFiltersProps {
  selected: string | undefined;
  onSelect: (state: string | undefined) => void;
  counts: Record<string, number>;
}

/** Horizontal chip bar for filtering the task list by state. */
export function TaskFilters({ selected, onSelect, counts }: TaskFiltersProps): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <FilterChip label="All" count={totalCount(counts)} active={!selected} onClick={() => onSelect(undefined)} />
      {FILTER_STATES.map((state) => (
        <FilterChip
          key={state}
          label={STATE_LABELS[state]}
          count={counts[state] ?? 0}
          active={selected === state}
          onClick={() => onSelect(selected === state ? undefined : state)}
          dotColor={STATE_DOT_COLORS[state]}
        />
      ))}
    </div>
  );
}

interface FilterChipProps {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
  dotColor?: string;
}

function FilterChip({ label, count, active, onClick, dotColor }: FilterChipProps): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors",
        active
          ? "border-primary/40 bg-primary/10 text-primary"
          : "border-border bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      {dotColor && <span className={cn("h-1.5 w-1.5 rounded-full", dotColor)} />}
      {label}
      {count > 0 && <span className="text-[10px] tabular-nums opacity-70">{count}</span>}
    </button>
  );
}

function totalCount(counts: Record<string, number>): number {
  let sum = 0;
  for (const v of Object.values(counts)) {
    sum += v;
  }
  return sum;
}
