import { cn } from "../../lib/cn";
import { BLOCK_REASON_LABELS, STATE_DOT_COLORS, STATE_LABELS } from "../../lib/constants";
import { BLOCK_REASONS } from "../../lib/vocabulary";
import type { BlockReason, TaskState } from "../../types/api";

/** The full set of states a task can be filtered to, in lifecycle order — includes the terminal cancelled state. */
const FILTER_STATES: TaskState[] = [
  "active",
  "blocked",
  "queued",
  "requirements_gathering",
  "completed",
  "failed",
  "cancelled",
];

interface TaskFiltersProps {
  selected: string | undefined;
  onSelect: (state: string | undefined) => void;
  counts: Record<string, number>;
  /** The active block-reason filter (only meaningful while viewing blocked tasks); undefined = all reasons. */
  blockReason: BlockReason | undefined;
  onSelectBlockReason: (reason: BlockReason | undefined) => void;
  /** Per-reason counts among blocked tasks, for the secondary block-reason chip row. */
  blockReasonCounts: Record<string, number>;
}

/** Chip bar for filtering the task list by state, plus a block-reason sub-row when viewing blocked tasks. */
export function TaskFilters({
  selected,
  onSelect,
  counts,
  blockReason,
  onSelectBlockReason,
  blockReasonCounts,
}: TaskFiltersProps): React.JSX.Element {
  // The block-reason sub-row is only relevant when looking at blocked tasks: when the Blocked chip is active,
  // or when no state filter is set but blocked tasks exist (so the reason is a usable second cut).
  const showBlockReasons = selected === "blocked" || (!selected && (counts["blocked"] ?? 0) > 0);

  return (
    <div className="space-y-2">
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

      {showBlockReasons && (
        <div className="flex flex-wrap items-center gap-1.5 pl-0.5">
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground/60">Reason</span>
          <FilterChip
            label="Any"
            count={totalCount(blockReasonCounts)}
            active={!blockReason}
            onClick={() => onSelectBlockReason(undefined)}
          />
          {BLOCK_REASONS.map((reason) => (
            <FilterChip
              key={reason}
              label={BLOCK_REASON_LABELS[reason]}
              count={blockReasonCounts[reason] ?? 0}
              active={blockReason === reason}
              onClick={() => onSelectBlockReason(blockReason === reason ? undefined : reason)}
            />
          ))}
        </div>
      )}
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
