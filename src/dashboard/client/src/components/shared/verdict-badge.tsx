import { CheckCircle2, XCircle } from "lucide-react";
import { cn } from "../../lib/cn";
import { type VerdictShape, readVerdict } from "../../lib/observation-shapes";
import type { Observation } from "../../types/api";

interface VerdictBadgeProps {
  passed: boolean;
  /** Optional gate tally appended to the label (e.g. "5/6 gates"); omitted when not provided. */
  summary?: string;
  className?: string;
}

/** Compact pass/fail pill for a verify verdict — green check on pass, red cross on fail. */
export function VerdictBadge({ passed, summary, className }: VerdictBadgeProps): React.JSX.Element {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium",
        passed
          ? "border-emerald-500/30 bg-emerald-500/15 text-emerald-400"
          : "border-red-500/30 bg-red-500/15 text-red-400",
        className,
      )}
    >
      {passed ? <CheckCircle2 size={12} /> : <XCircle size={12} />}
      {passed ? "Passed" : "Failed"}
      {summary && <span className="font-normal text-muted-foreground">· {summary}</span>}
    </span>
  );
}

interface GateListProps {
  gates: VerdictShape["gates"];
  className?: string;
}

/** Per-gate pass/fail list — each `{ name, passed }` from a verify verdict on its own row. */
export function GateList({ gates, className }: GateListProps): React.JSX.Element | null {
  if (gates.length === 0) {
    return null;
  }
  return (
    <ul className={cn("space-y-1", className)}>
      {gates.map((gate) => (
        <li key={gate.name} className="flex items-center gap-2 text-xs">
          {gate.passed ? (
            <CheckCircle2 size={12} className="shrink-0 text-emerald-400" />
          ) : (
            <XCircle size={12} className="shrink-0 text-red-400" />
          )}
          <span className={cn("font-mono", gate.passed ? "text-foreground/80" : "text-red-400")}>{gate.name}</span>
        </li>
      ))}
    </ul>
  );
}

interface VerdictPanelProps {
  observation: Observation;
  className?: string;
}

/**
 * Full verify-verdict renderer: the overall pass/fail badge with a gate tally, then the per-gate breakdown.
 * Returns null for any non-`safety_verdict` observation or a malformed payload, so a caller can map it over a
 * mixed observation list without guarding each row.
 */
export function VerdictPanel({ observation, className }: VerdictPanelProps): React.JSX.Element | null {
  const verdict = readVerdict(observation);
  if (verdict === null) {
    return null;
  }
  const passedCount = verdict.gates.filter((gate) => gate.passed).length;
  const total = verdict.gateCount > 0 ? verdict.gateCount : verdict.gates.length;
  const summary = total > 0 ? `${String(passedCount)}/${String(total)} gates` : undefined;

  return (
    <div className={cn("space-y-2", className)}>
      <VerdictBadge passed={verdict.passed} summary={summary} />
      <GateList gates={verdict.gates} />
    </div>
  );
}
