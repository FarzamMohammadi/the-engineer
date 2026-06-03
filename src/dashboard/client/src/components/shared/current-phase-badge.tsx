import { ChevronRight } from "lucide-react";
import { cn } from "../../lib/cn";
import { PHASE_LABELS, SUB_PHASE_LABELS } from "../../lib/constants";
import type { Phase } from "../../types/api";

interface CurrentPhaseBadgeProps {
  /** The phase the task is in right now; the badge renders nothing when null (no current phase). */
  phase: Phase | null;
  /** The sub-phase running inside that phase, shown after a chevron; omitted when absent. */
  subPhase?: string | null;
  /** Whether the task is actively executing this phase now — drives the live pulse on the dot. */
  live?: boolean;
}

/**
 * The "you are here" indicator: a single primary-tinted pill naming the current phase and its running
 * sub-phase, meant to sit beside the state badge — deliberately apart from the full PhasePipeline journey
 * map so the two do not read as one block. The leading dot pulses while the task is live.
 */
export function CurrentPhaseBadge({ phase, subPhase, live = false }: CurrentPhaseBadgeProps): React.JSX.Element | null {
  if (!phase) {
    return null;
  }
  const phaseLabel = PHASE_LABELS[phase] ?? phase;
  const subPhaseLabel = subPhase ? (SUB_PHASE_LABELS[subPhase] ?? subPhase) : null;

  return (
    <span className="inline-flex items-center gap-1.5 rounded-md bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary ring-1 ring-primary/20">
      <span className={cn("size-1.5 shrink-0 rounded-full bg-primary", live && "motion-safe:animate-pulse")} />
      <span>{phaseLabel}</span>
      {subPhaseLabel && (
        <>
          <ChevronRight size={12} className="opacity-50" />
          <span className="text-primary/80">{subPhaseLabel}</span>
        </>
      )}
    </span>
  );
}
