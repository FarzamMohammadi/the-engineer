import { cn } from "../../lib/cn";
import { PHASE_LABELS, PHASE_ORDER } from "../../lib/constants";
import type { Phase } from "../../types/api";

interface PhasePipelineProps {
  currentPhase: Phase | null;
  phasesRan?: string[];
  className?: string;
}

export function PhasePipeline({ currentPhase, phasesRan = [], className }: PhasePipelineProps): React.JSX.Element {
  return (
    <div className={cn("flex items-center gap-1", className)}>
      {PHASE_ORDER.map((phase, index) => {
        const isCurrent = phase === currentPhase;
        const isCompleted = phasesRan.includes(phase) && !isCurrent;

        return (
          <div key={phase} className="flex items-center gap-1">
            {index > 0 && <div className={cn("h-px w-3", isCompleted || isCurrent ? "bg-primary/50" : "bg-border")} />}
            <div
              className={cn(
                "rounded px-1.5 py-0.5 text-[10px] font-medium leading-tight transition-colors",
                isCurrent && "bg-primary/20 text-primary ring-1 ring-primary/30",
                isCompleted && "bg-emerald-500/15 text-emerald-400",
                !isCurrent && !isCompleted && "bg-muted text-muted-foreground/50",
              )}
              title={PHASE_LABELS[phase]}
            >
              {PHASE_LABELS[phase]?.[0]}
            </div>
          </div>
        );
      })}
    </div>
  );
}
