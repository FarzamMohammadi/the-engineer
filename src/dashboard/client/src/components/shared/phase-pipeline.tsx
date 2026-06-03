import { cn } from "../../lib/cn";
import { PHASE_LABELS, PHASE_ORDER, SUB_PHASE_LABELS } from "../../lib/constants";
import type { Phase } from "../../types/api";

interface PhasePipelineProps {
  /** The phase the task is currently in; null when not yet started or already finished. */
  currentPhase: Phase | null;
  /** The distinct real phases the task has run (derived from `input.phase`), used to mark completed steps. */
  phasesRan?: readonly Phase[];
  /** The current sub-phase (e.g. "verify", "create-pr"); shown as a tag under the active phase. */
  subPhase?: string | null;
  /** Intra-phase repeat count for the current phase; surfaced as an "iter N" affordance when > 1. */
  phaseIteration?: number;
  /** Inter-phase rework (backward-jump) count for the dispatch; surfaced as "reworks N" when > 0. */
  totalReworks?: number;
  /** Compact mode for dense list rows: smaller chips, with a tight sub-phase/iteration line when present. */
  compact?: boolean;
  /**
   * Letters-only mode for the overview glance: each phase is a single-letter chip and the secondary
   * sub-phase/counter line is dropped, so six phases fit one tight row without wrapping. The full phase
   * name stays on the chip's `title` tooltip, and position + highlight still disambiguate the repeated R's.
   */
  lettersOnly?: boolean;
  className?: string;
}

/**
 * The six-phase pipeline (requirements → research → planning → execution → review → delivery), highlighting
 * the current phase and marking completed phases from the real `phasesRan` list. In full mode it also shows
 * the active sub-phase and the iteration/rework counters — the at-a-glance answer to "where is this task and
 * has it looped?". `compact` renders just the chips for dense list rows.
 */
export function PhasePipeline({
  currentPhase,
  phasesRan = [],
  subPhase,
  phaseIteration,
  totalReworks,
  compact = false,
  lettersOnly = false,
  className,
}: PhasePipelineProps): React.JSX.Element {
  const ran = new Set<Phase>(phasesRan);
  const currentIndex = currentPhase ? PHASE_ORDER.indexOf(currentPhase) : -1;
  // The sub-phase / loop affordance is meaningful in both modes — a list reader wants to see "Execution ·
  // Verify · iter 2" without opening the task. It only renders when there is something to show.
  const showCounters = (phaseIteration ?? 0) > 1 || (totalReworks ?? 0) > 0;
  const subPhaseLabel = subPhase ? (SUB_PHASE_LABELS[subPhase] ?? subPhase) : null;

  return (
    <div className={cn(compact ? "space-y-0.5" : "space-y-1", className)}>
      <div className="flex flex-wrap items-center gap-x-1 gap-y-1">
        {PHASE_ORDER.map((phase, index) => {
          const isCurrent = phase === currentPhase;
          // A phase counts as completed if the task ran it and has since moved past it (or it is not the
          // current phase) — so a re-entered phase shows as current, not stuck-completed.
          const isCompleted = !isCurrent && (ran.has(phase) || (currentIndex >= 0 && index < currentIndex));

          return (
            <div key={phase} className="flex items-center gap-1">
              {index > 0 && (
                <div className={cn("h-px w-2.5", isCompleted || isCurrent ? "bg-primary/40" : "bg-border")} />
              )}
              <span
                className={cn(
                  "rounded px-1.5 py-0.5 text-[10px] font-medium leading-tight transition-colors",
                  lettersOnly && "w-5 text-center",
                  isCurrent && "bg-primary/20 text-primary ring-1 ring-primary/30",
                  isCompleted && "bg-emerald-500/15 text-emerald-400",
                  !(isCurrent || isCompleted) && "bg-muted text-muted-foreground/50",
                )}
                title={PHASE_LABELS[phase]}
              >
                {lettersOnly ? PHASE_LABELS[phase].charAt(0) : PHASE_LABELS[phase]}
              </span>
            </div>
          );
        })}
      </div>

      {!lettersOnly && (subPhaseLabel || showCounters) && (
        <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
          {subPhaseLabel && (
            <span className="rounded bg-muted px-1.5 py-0.5 font-medium text-muted-foreground/90">{subPhaseLabel}</span>
          )}
          {(phaseIteration ?? 0) > 1 && <span>iter {phaseIteration}</span>}
          {(totalReworks ?? 0) > 0 && <span>reworks {totalReworks}</span>}
        </div>
      )}
    </div>
  );
}
