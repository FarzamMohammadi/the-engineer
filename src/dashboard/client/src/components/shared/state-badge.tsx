import { cn } from "../../lib/cn";
import { STATE_COLORS, STATE_DOT_COLORS, STATE_LABELS } from "../../lib/constants";
import type { TaskState } from "../../types/api";

interface StateBadgeProps {
  state: TaskState;
  showDot?: boolean;
  className?: string;
}

/** Color-coded badge showing task lifecycle state. */
export function StateBadge({ state, showDot = true, className }: StateBadgeProps): React.JSX.Element {
  const colors = STATE_COLORS[state] ?? STATE_COLORS.queued;
  const dotColor = STATE_DOT_COLORS[state] ?? STATE_DOT_COLORS.queued;
  const label = STATE_LABELS[state] ?? state;

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-medium",
        colors,
        className,
      )}
    >
      {showDot && <span className={cn("h-1.5 w-1.5 rounded-full", dotColor)} />}
      {label}
    </span>
  );
}
