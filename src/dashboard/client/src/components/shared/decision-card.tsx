import { CheckCircle2, Circle, GitBranch } from "lucide-react";
import { cn } from "../../lib/cn";
import { formatTimestamp } from "../../lib/formatters";
import { type DecisionShape, readDecision } from "../../lib/observation-shapes";
import type { Observation } from "../../types/api";

interface ConfidenceMeterProps {
  /** 0–1 model-reported confidence. */
  value: number;
}

/** Inline confidence bar plus percentage — green when high, amber mid, red when the engine was unsure. */
function ConfidenceMeter({ value }: ConfidenceMeterProps): React.JSX.Element {
  const clamped = Math.max(0, Math.min(1, value));
  const pct = Math.round(clamped * 100);
  const tone = clamped >= 0.75 ? "bg-emerald-400" : clamped >= 0.5 ? "bg-amber-400" : "bg-red-400";
  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Confidence</span>
      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
        <div className={cn("h-full rounded-full", tone)} style={{ width: `${String(pct)}%` }} />
      </div>
      <span className="font-mono text-xs tabular-nums text-foreground/80">{pct}%</span>
    </div>
  );
}

interface OptionRowProps {
  description: string;
  chosen: boolean;
}

/** One alternative — the chosen path is highlighted; the roads not taken are dimmed but still legible. */
function OptionRow({ description, chosen }: OptionRowProps): React.JSX.Element {
  return (
    <li
      className={cn(
        "flex items-start gap-2 rounded-md border px-2.5 py-1.5 text-xs",
        chosen
          ? "border-emerald-500/30 bg-emerald-500/10 text-foreground"
          : "border-border/60 bg-muted/20 text-muted-foreground",
      )}
    >
      {chosen ? (
        <CheckCircle2 size={13} className="mt-0.5 shrink-0 text-emerald-400" />
      ) : (
        <Circle size={13} className="mt-0.5 shrink-0 text-muted-foreground/50" />
      )}
      <span className={cn(chosen && "font-medium")}>{description}</span>
    </li>
  );
}

interface DecisionCardProps {
  observation: Observation;
  className?: string;
}

/**
 * Legible renderer for one `decision_point` observation — the heart of "why did it do that". Shows the
 * context, every option weighed with the chosen one highlighted among the alternatives, the reasoning, and a
 * confidence indicator. Returns null for any non-decision observation so callers can map it over a mixed
 * list. This deliberately does NOT dump JSON: the road not taken and the reasoning are the product.
 */
export function DecisionCard({ observation, className }: DecisionCardProps): React.JSX.Element | null {
  const decision = readDecision(observation);
  if (decision === null) {
    return null;
  }
  return (
    <DecisionCardBody
      decision={decision}
      name={observation.name}
      timestamp={observation.start_time}
      className={className}
    />
  );
}

interface DecisionCardBodyProps {
  decision: DecisionShape;
  /** The decision name (e.g. "route:verify", "skip:research", "merge_readiness"). */
  name: string;
  timestamp: string;
  className?: string;
}

function DecisionCardBody({ decision, name, timestamp, className }: DecisionCardBodyProps): React.JSX.Element {
  // The chosen id may match an option's id; fall back to comparing against its description so a chosen value
  // recorded as either form still highlights the right row.
  const isChosen = (option: { id: string; description: string }): boolean =>
    decision.chosen.length > 0 && (option.id === decision.chosen || option.description === decision.chosen);

  return (
    <div className={cn("space-y-2.5 rounded-lg border border-border bg-card p-3", className)}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
          <GitBranch size={13} className="text-primary" />
          <span className="font-mono">{name}</span>
        </div>
        <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{formatTimestamp(timestamp)}</span>
      </div>

      {decision.context && <p className="text-xs leading-relaxed text-muted-foreground">{decision.context}</p>}

      {decision.options.length > 0 && (
        <ul className="space-y-1">
          {decision.options.map((option) => (
            <OptionRow
              key={option.id || option.description}
              description={option.description}
              chosen={isChosen(option)}
            />
          ))}
        </ul>
      )}

      {decision.reasoning && (
        <div className="rounded-md bg-muted/40 px-2.5 py-1.5">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Reasoning</p>
          <p className="mt-0.5 text-xs leading-relaxed text-foreground/90">{decision.reasoning}</p>
        </div>
      )}

      {decision.confidence !== null && <ConfidenceMeter value={decision.confidence} />}
    </div>
  );
}
