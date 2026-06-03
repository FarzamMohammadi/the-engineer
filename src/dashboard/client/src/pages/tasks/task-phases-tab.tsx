import { ArrowRight, CheckCircle2, Layers, RotateCcw, SkipForward, XCircle } from "lucide-react";
import { CostDisplay } from "../../components/shared/cost-display";
import { DecisionCard } from "../../components/shared/decision-card";
import { EmptyState } from "../../components/shared/empty-state";
import { Badge } from "../../components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { Skeleton } from "../../components/ui/skeleton";
import { useObservations } from "../../hooks/use-observations";
import { useTaskAgentTraces, useTaskPhases } from "../../hooks/use-tasks";
import { PHASE_LABELS, PHASE_ORDER, SUB_PHASE_LABELS } from "../../lib/constants";
import { formatDuration } from "../../lib/formatters";
import { type PhaseTransitionShape, readAgentCall, readPhaseTransition } from "../../lib/observation-shapes";
import type { Observation, Phase } from "../../types/api";

interface TaskPhasesTabProps {
  taskId: string;
}

/** A sub-phase's run within a phase: when it started, its result outcome, and the one-line summary. */
interface SubPhaseRun {
  readonly subPhase: string;
  readonly outcome: string;
  readonly summary: string;
  readonly status: "ok" | "error" | "pending";
}

/** Everything that happened inside one real pipeline phase, assembled from the task's observations. */
interface PhaseGroup {
  readonly phase: Phase;
  readonly subPhases: readonly SubPhaseRun[];
  /** route:/skip:/loop_* decision observations recorded while in this phase, chronological. */
  readonly decisions: readonly Observation[];
  readonly entries: number;
  readonly costUsd: number;
  readonly hasCost: boolean;
  readonly durationMs: number;
}

/**
 * The per-phase breakdown, rebuilt on the engine's real shape. Phase_transition observations are grouped by
 * `input.phase` (NOT the observation `name`, which holds the event — phase_entered/sub_phase_started/
 * sub_phase_result), rendered in pipeline order. Each phase shows its sub-phase sequence with outcomes, the
 * routing/skip/loop decisions taken inside it, and its cost + agent-call duration aggregated from that
 * phase's `agent_call` spans (cost read from span `output`, never from the always-null `metadata`).
 */
export function TaskPhasesTab({ taskId }: TaskPhasesTabProps): React.JSX.Element {
  const { data: phases, isLoading } = useTaskPhases(taskId);
  const { data: decisions } = useObservations({ type: "decision_point", task_id: taskId, limit: 500 });
  const { data: agentTraces } = useTaskAgentTraces(taskId);

  if (isLoading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 3 }, (_, i) => (
          <Skeleton key={`sk-${String(i)}`} className="h-40 w-full" />
        ))}
      </div>
    );
  }

  if (!phases || phases.length === 0) {
    return <EmptyState icon={<Layers size={32} />} title="No phases executed yet" />;
  }

  const groups = buildPhaseGroups(phases, decisions ?? [], agentTraces ?? []);

  if (groups.length === 0) {
    return <EmptyState icon={<Layers size={32} />} title="No phases executed yet" />;
  }

  return (
    <div className="space-y-3">
      {groups.map((group) => (
        <PhaseCard key={group.phase} group={group} />
      ))}
    </div>
  );
}

function PhaseCard({ group }: { group: PhaseGroup }): React.JSX.Element {
  const hasError = group.subPhases.some((sp) => sp.status === "error");

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2">
            {PHASE_LABELS[group.phase] ?? group.phase}
            {hasError && (
              <Badge variant="destructive" className="text-[10px]">
                error
              </Badge>
            )}
          </CardTitle>
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span>{formatDuration(group.durationMs)}</span>
            {group.hasCost && <CostDisplay amount={group.costUsd} size="sm" />}
            <span>
              {group.entries} agent {group.entries === 1 ? "call" : "calls"}
            </span>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {group.subPhases.length > 0 && (
          <ol className="space-y-1">
            {group.subPhases.map((sp, index) => (
              <SubPhaseRow key={`${sp.subPhase}-${String(index)}`} run={sp} />
            ))}
          </ol>
        )}
        {group.decisions.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Decisions</p>
            {group.decisions.map((decision) => (
              <PhaseDecision key={decision.id} decision={decision} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function SubPhaseRow({ run }: { run: SubPhaseRun }): React.JSX.Element {
  const label = SUB_PHASE_LABELS[run.subPhase] ?? run.subPhase;
  return (
    <li className="flex items-start gap-2 text-sm">
      <span className="mt-0.5 shrink-0">
        {run.status === "error" ? (
          <XCircle size={13} className="text-red-400" />
        ) : run.status === "pending" ? (
          <ArrowRight size={13} className="text-primary" />
        ) : (
          <CheckCircle2 size={13} className="text-emerald-400" />
        )}
      </span>
      <span className="min-w-0">
        <span className="font-medium">{label}</span>
        {run.outcome && <span className="ml-2 text-xs text-muted-foreground">{run.outcome}</span>}
        {run.summary && <span className="block text-xs leading-relaxed text-muted-foreground/90">{run.summary}</span>}
      </span>
    </li>
  );
}

/**
 * A routing/skip/loop decision inside a phase. route:/skip: forks render as the full DecisionCard (they carry
 * options + reasoning); loop_repeat/loop_jump are bare counters with no options, so they render as a compact
 * inline line rather than an empty card.
 */
function PhaseDecision({ decision }: { decision: Observation }): React.JSX.Element {
  if (decision.name.startsWith("loop_")) {
    const count = typeof decision.input?.["count"] === "number" ? decision.input["count"] : null;
    const kind = decision.name === "loop_jump" ? "Jumped back" : "Repeated phase";
    return (
      <div className="flex items-center gap-1.5 text-xs text-amber-400">
        <RotateCcw size={12} />
        <span>
          {kind}
          {count !== null && ` (×${String(count)})`}
        </span>
      </div>
    );
  }
  if (decision.name.startsWith("skip:")) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <SkipForward size={12} />
        <span className="font-mono">{decision.name}</span>
      </div>
    );
  }
  return <DecisionCard observation={decision} />;
}

/**
 * Assemble per-phase groups in pipeline order. Phase_transitions are grouped by `input.phase`; the
 * sub-phase sequence is reconstructed from sub_phase_started/sub_phase_result events. Decisions and
 * agent_call spans are attributed to a phase by their `phase` column (set by the runner's traceScope).
 */
function buildPhaseGroups(
  transitions: readonly Observation[],
  decisions: readonly Observation[],
  agentTraces: readonly Observation[],
): PhaseGroup[] {
  const subPhasesByPhase = new Map<string, SubPhaseRun[]>();
  const seen = new Set<string>();
  const order: string[] = [];

  for (const obs of transitions) {
    const shape = readPhaseTransition(obs);
    if (!isRealPhase(shape.phase)) {
      continue;
    }
    if (!seen.has(shape.phase)) {
      seen.add(shape.phase);
      order.push(shape.phase);
    }
    recordSubPhase(subPhasesByPhase, shape);
  }

  const decisionsByPhase = groupByPhaseColumn(decisions);
  const costByPhase = aggregateAgentSpend(agentTraces);

  const ordered = [...order].sort((a, b) => PHASE_ORDER.indexOf(a as Phase) - PHASE_ORDER.indexOf(b as Phase));
  return ordered.map((phase) => {
    const spend = costByPhase.get(phase) ?? { costUsd: 0, hasCost: false, durationMs: 0, entries: 0 };
    return {
      phase: phase as Phase,
      subPhases: subPhasesByPhase.get(phase) ?? [],
      decisions: decisionsByPhase.get(phase) ?? [],
      entries: spend.entries,
      costUsd: spend.costUsd,
      hasCost: spend.hasCost,
      durationMs: spend.durationMs,
    };
  });
}

function isRealPhase(phase: string): phase is Phase {
  return (PHASE_ORDER as readonly string[]).includes(phase);
}

/**
 * Fold one phase_transition into its phase's sub-phase list. A started event opens a pending row; the matching
 * result event resolves the latest pending row of that sub-phase to its outcome (started without a result
 * stays pending — the phase is mid-flight).
 */
function recordSubPhase(map: Map<string, SubPhaseRun[]>, shape: PhaseTransitionShape): void {
  if (!shape.subPhase) {
    return;
  }
  const list = map.get(shape.phase) ?? [];
  if (shape.event === "sub_phase_started") {
    list.push({ subPhase: shape.subPhase, outcome: "", summary: "", status: "pending" });
  } else if (shape.event === "sub_phase_result") {
    const pending = [...list].reverse().find((sp) => sp.subPhase === shape.subPhase && sp.status === "pending");
    const resolved: SubPhaseRun = {
      subPhase: shape.subPhase,
      outcome: shape.outcome,
      summary: shape.summary,
      status: shape.outcome === "error" ? "error" : "ok",
    };
    if (pending) {
      list[list.indexOf(pending)] = resolved;
    } else {
      list.push(resolved);
    }
  }
  map.set(shape.phase, list);
}

function groupByPhaseColumn(observations: readonly Observation[]): Map<string, Observation[]> {
  const map = new Map<string, Observation[]>();
  // Oldest-first so each phase's decision trail reads in the order it was made.
  const chronological = [...observations].sort((a, b) => a.start_time.localeCompare(b.start_time));
  for (const obs of chronological) {
    if (!obs.phase) {
      continue;
    }
    const list = map.get(obs.phase) ?? [];
    list.push(obs);
    map.set(obs.phase, list);
  }
  return map;
}

interface PhaseSpend {
  costUsd: number;
  hasCost: boolean;
  durationMs: number;
  entries: number;
}

/** Sum each phase's agent_call cost (from span output) and duration — the same source as the metrics page. */
function aggregateAgentSpend(agentTraces: readonly Observation[]): Map<string, PhaseSpend> {
  const map = new Map<string, PhaseSpend>();
  for (const trace of agentTraces) {
    const call = readAgentCall(trace);
    if (call === null || !trace.phase) {
      continue;
    }
    const entry = map.get(trace.phase) ?? { costUsd: 0, hasCost: false, durationMs: 0, entries: 0 };
    entry.costUsd += call.costUsd ?? 0;
    entry.hasCost = entry.hasCost || call.costUsd != null;
    entry.durationMs += trace.duration_ms ?? 0;
    entry.entries += 1;
    map.set(trace.phase, entry);
  }
  return map;
}
