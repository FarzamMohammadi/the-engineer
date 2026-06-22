import {
  ArrowDown,
  ArrowRight,
  Brain,
  BrainCircuit,
  ChevronDown,
  ChevronRight,
  Cog,
  MessageSquare,
  PauseCircle,
  Play,
  Radio,
  RotateCcw,
  Terminal,
  Wrench,
} from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { BlobViewer } from "../../components/shared/blob-viewer";
import { CostDisplay } from "../../components/shared/cost-display";
import { DecisionCard } from "../../components/shared/decision-card";
import { EmptyState } from "../../components/shared/empty-state";
import { JsonViewer } from "../../components/shared/json-viewer";
import { Markdown } from "../../components/shared/markdown";
import { VerdictBadge, VerdictPanel } from "../../components/shared/verdict-badge";
import { Badge } from "../../components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../../components/ui/collapsible";
import { Skeleton } from "../../components/ui/skeleton";
import { useEvents } from "../../hooks/use-events";
import { useObservations } from "../../hooks/use-observations";
import { useSseSubscription } from "../../hooks/use-sse";
import { useTaskAgentActivity, useTaskAgentTraces } from "../../hooks/use-tasks";
import { fetchBlob, isBlobRef } from "../../lib/blob";
import { cn } from "../../lib/cn";
import { BLOCK_CATEGORY_LABELS, SUB_PHASE_LABELS } from "../../lib/constants";
import { modelsFromCostEvents } from "../../lib/cost-events";
import { formatDuration, formatTimestamp, formatTokens } from "../../lib/formatters";
import {
  type AgentActivityShape,
  type AgentCallShape,
  type EnrichedStep,
  type StepBlock,
  buildStepFeed,
  readAgentActivity,
  readAgentCall,
  readBlock,
  readGate,
  readVerdict,
} from "../../lib/observation-shapes";
import type { Observation } from "../../types/api";

interface TaskAgentTabProps {
  taskId: string;
  /** True while the task is actively executing — only then can an open `agent_call` be streaming live. */
  taskActive: boolean;
}

/**
 * Step feed — one row per sub-phase the engine actually ran, in true executed order (e.g. implement → verify →
 * implement), not just the LLM calls. LLM steps render as the {@link AgentTraceRow} with their full cost/tokens/
 * blob/live-conversation drill-in; non-LLM steps (verify, the delivery git/PR steps) render as a visually
 * distinct {@link StepRow} that drills into what they did and produced — verify's gates and verdict, every
 * step's `route:`/`loop_*` routing decision — so an observer never sees an unexplained gap (e.g. two `implement`
 * rows with the `verify` that looped them back hidden between).
 *
 * The rows are correlated client-side by {@link buildStepFeed}: runs come from `phase_transition` observations,
 * and each run LOOKS UP its `agent_call`/`safety_verdict`/`tool_execution`/`decision_point` enrichments by the
 * run's id — every observation a sub-phase emits parents on that run's `sub_phase_started` id (the Core
 * correlation fix), so there is no phase/trace/time-window guessing. A step that ended in a block (e.g. an
 * autonomy escalation) renders a distinct {@link BlockMarker} beneath it — the explained block → resume that
 * removes the "two implements with nothing between" gap. Each `agent_call` still carries its cost/tokens/blob
 * refs in `output` (never `metadata`); the model id is not on the span, so it rides the task's `cost.incurred`
 * events and shows as header context, not a per-step label.
 */
export function TaskAgentTab({ taskId, taskActive }: TaskAgentTabProps): React.JSX.Element {
  const { steps, isLoading } = useStepFeed(taskId, taskActive);
  const { data: costEvents } = useEvents({ type: "cost.incurred", task_id: taskId, limit: 500 });

  if (isLoading) {
    return <StepFeedSkeleton />;
  }

  if (steps.length === 0) {
    return <EmptyState icon={<BrainCircuit size={32} />} title="No steps recorded" />;
  }

  return (
    <div className="space-y-4">
      <StepFeedHeader steps={steps} models={modelsFromCostEvents(costEvents ?? [])} />
      <div className="space-y-2">
        {steps.map((step, index) => (
          <div key={stepKey(step, index)} className="space-y-2">
            <StepFeedRow step={step} taskId={taskId} taskActive={taskActive} />
            {step.block && <BlockMarker block={step.block} hasResume={index < steps.length - 1} />}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Fetch the feed's sources and assemble the ordered step feed — every sub-phase run with what it owns. */
function useStepFeed(taskId: string, taskActive: boolean): { steps: EnrichedStep<Observation>[]; isLoading: boolean } {
  // A run's LLM/non-LLM classification depends on the agent traces, so the feed waits for BOTH the run
  // skeleton (phase_transition) AND the traces before first paint — otherwise an LLM step would flash as a
  // generic non-LLM step row for one tick until the traces arrive, briefly breaking the distinct treatment.
  const { data: agentTraces, isLoading: tracesLoading } = useTaskAgentTraces(taskId, taskActive);
  const { data: phaseTransitions, isLoading: transitionsLoading } = useObservations({
    type: "phase_transition",
    task_id: taskId,
    limit: 1000,
    active: taskActive,
  });
  const { data: verdicts } = useObservations({
    type: "safety_verdict",
    task_id: taskId,
    limit: 1000,
    active: taskActive,
  });
  const { data: toolExecs } = useObservations({
    type: "tool_execution",
    task_id: taskId,
    limit: 1000,
    active: taskActive,
  });
  const { data: decisions } = useObservations({
    type: "decision_point",
    task_id: taskId,
    limit: 1000,
    active: taskActive,
  });
  // state_transition rows carry the `task_blocked` markers, so a step that ended in a block (e.g. an autonomy
  // escalation) renders an explained block → resume between it and the next step — no unexplained gap.
  const { data: stateTransitions } = useObservations({
    type: "state_transition",
    task_id: taskId,
    limit: 1000,
    active: taskActive,
  });

  const steps = useMemo(
    () =>
      buildStepFeed(
        phaseTransitions ?? [],
        agentTraces ?? [],
        verdicts ?? [],
        toolExecs ?? [],
        decisions ?? [],
        stateTransitions ?? [],
      ),
    [phaseTransitions, agentTraces, verdicts, toolExecs, decisions, stateTransitions],
  );
  return { steps, isLoading: transitionsLoading || tracesLoading };
}

/** A stable React key for a feed row: the LLM call's span id, or the run's identity for a non-LLM step. */
function stepKey(step: EnrichedStep<Observation>, index: number): string {
  return step.agentCall?.id ?? `${step.subPhase}-${step.startTime}-${String(index)}`;
}

/** Dispatch a feed row to the LLM trace renderer or the non-LLM step renderer by its kind. */
function StepFeedRow({
  step,
  taskId,
  taskActive,
}: {
  step: EnrichedStep<Observation>;
  taskId: string;
  taskActive: boolean;
}): React.JSX.Element {
  if (step.kind === "llm" && step.agentCall) {
    return (
      <AgentTraceRow
        trace={step.agentCall}
        call={readAgentCall(step.agentCall)}
        taskId={taskId}
        taskActive={taskActive}
      />
    );
  }
  return <StepRow step={step} />;
}

/** The spend across a feed's LLM steps — cost read from each span's `output`, to match the metrics page. */
function llmSpend(steps: readonly EnrichedStep<Observation>[]): {
  count: number;
  totalCost: number;
  hasCost: boolean;
  totalTokens: number;
} {
  const calls = steps.flatMap((step) => {
    const call = step.agentCall ? readAgentCall(step.agentCall) : null;
    return call ? [call] : [];
  });
  return {
    count: calls.length,
    totalCost: calls.reduce((sum, call) => sum + (call.costUsd ?? 0), 0),
    hasCost: calls.some((call) => call.costUsd != null),
    totalTokens: calls.reduce((sum, call) => sum + call.tokensIn + call.tokensOut, 0),
  };
}

/** The feed's summary line: step and agent-call counts, total spend/tokens, and the models the task ran on. */
function StepFeedHeader({
  steps,
  models,
}: {
  steps: readonly EnrichedStep<Observation>[];
  models: readonly string[];
}): React.JSX.Element {
  const spend = llmSpend(steps);
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
      <span>{steps.length} steps</span>
      <span>
        {spend.count} agent {spend.count === 1 ? "call" : "calls"}
      </span>
      <span className="flex items-center gap-1">
        Total:{" "}
        {spend.hasCost ? (
          <CostDisplay amount={spend.totalCost} size="sm" />
        ) : (
          <span className="text-xs">no pricing</span>
        )}
      </span>
      <span>{formatTokens(spend.totalTokens)} tokens</span>
      {models.length > 0 && (
        <span className="flex items-center gap-1">
          Model:{" "}
          {models.map((model) => (
            <Badge key={model} variant="outline" className="font-mono text-[10px]">
              {model}
            </Badge>
          ))}
        </span>
      )}
    </div>
  );
}

/** The loading placeholder for the step feed — a few row-height skeletons. */
function StepFeedSkeleton(): React.JSX.Element {
  return (
    <div className="space-y-3">
      {Array.from({ length: 4 }, (_, i) => (
        <Skeleton key={`sk-${String(i)}`} className="h-20 w-full" />
      ))}
    </div>
  );
}

/**
 * One non-LLM step (verify, push, create-pr, await-review, auto-merge). Mirrors {@link AgentTraceRow}'s
 * collapsible shell but is visually distinct — a gear icon and a neutral "System" badge instead of the LLM brain
 * — so it never reads as an agent call. Expanding it drills into what the step did and produced, rendering only
 * what was actually correlated: verify's verdict + per-gate output, any tool spans (verify gates, delivery
 * git/PR calls), the structured result data, and the `route:`/`loop_*` decision the step led to.
 */
function StepRow({ step }: { step: EnrichedStep<Observation> }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild={true}>
        <button
          type="button"
          className={cn(
            "flex w-full items-center gap-3 rounded-md border border-border px-3 py-2 text-left transition-colors",
            "hover:bg-muted/50",
            step.status === "error" && "border-destructive/30 bg-destructive/5",
          )}
        >
          <Cog size={14} className="shrink-0 text-muted-foreground" />
          <StepRowHeader step={step} />
          <ChevronDown
            size={14}
            className={cn("shrink-0 transition-transform text-muted-foreground", open && "rotate-180")}
          />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mx-3 space-y-3 rounded-b-md border-x border-b border-border bg-muted/20 p-3">
          <StepDetail step={step} />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** The collapsed-row line for a non-LLM step: its label, a neutral "System" badge, status, phase, and time. */
function StepRowHeader({ step }: { step: EnrichedStep<Observation> }): React.JSX.Element {
  const label = SUB_PHASE_LABELS[step.subPhase] ?? step.subPhase;
  const verdict = step.verdict ? readVerdict(step.verdict) : null;
  return (
    <div className="min-w-0 flex-1">
      <div className="flex items-center gap-2">
        <span className="truncate text-sm font-medium">{label}</span>
        <Badge variant="outline" className="text-[10px]">
          System
        </Badge>
        <StepStatusBadge step={step} />
        {step.phase && <span className="text-[10px] text-muted-foreground">{step.phase}</span>}
      </div>
      <div className="mt-0.5 flex items-center gap-3 text-xs text-muted-foreground">
        <span className="tabular-nums">{formatTimestamp(step.startTime)}</span>
        {verdict && <VerdictBadge passed={verdict.passed} className="text-[10px]" />}
      </div>
    </div>
  );
}

/** A non-LLM step's status pill: a pulsing "running" while pending, else its outcome (destructive on error). */
function StepStatusBadge({ step }: { step: EnrichedStep<Observation> }): React.JSX.Element {
  if (step.status === "pending") {
    return (
      <Badge variant="secondary" className="gap-1 text-[10px]">
        <ArrowRight size={10} className="animate-pulse" />
        running
      </Badge>
    );
  }
  return (
    <Badge variant={step.status === "error" ? "destructive" : "secondary"} className="text-[10px]">
      {step.outcome || step.status}
    </Badge>
  );
}

/**
 * The expanded drill-in for a non-LLM step — only what was actually correlated: the result summary, verify's
 * verdict, the tool spans it produced, its structured result data, and the routing decision it led to. When the
 * step recorded none of these (e.g. an `await-review` park), it says so rather than showing an empty panel.
 */
function StepDetail({ step }: { step: EnrichedStep<Observation> }): React.JSX.Element {
  const hasResultData = step.data !== null && Object.keys(step.data).length > 0;
  const hasDetail =
    Boolean(step.summary) ||
    step.verdict !== null ||
    step.tools.length > 0 ||
    step.decisions.length > 0 ||
    hasResultData;
  return (
    <>
      {step.summary && <p className="text-sm text-foreground/80">{step.summary}</p>}
      {step.verdict && <VerdictPanel observation={step.verdict} />}
      {step.tools.map((tool) => (
        <StepToolBlock key={tool.id} tool={tool} />
      ))}
      {!step.verdict && hasResultData && step.data && <JsonViewer data={step.data} label="Result" />}
      {step.decisions.map((decision) => (
        <StepDecision key={decision.id} decision={decision} />
      ))}
      {!hasDetail && (
        <p className="text-xs text-muted-foreground/70">No additional detail was recorded for this step.</p>
      )}
    </>
  );
}

/**
 * One `tool_execution` a non-LLM step produced. A verify `gate:*` span renders as a pass/fail pill over its
 * captured command output (the "which gate failed and why"); any other span (a delivery git/PR call) renders
 * its status and raw input/output. Mirrors the Tools tab's gate-output block.
 */
function StepToolBlock({ tool }: { tool: Observation }): React.JSX.Element {
  const gate = readGate(tool);
  if (gate) {
    return (
      <div className="space-y-1.5">
        <div className="flex items-center gap-2 text-xs">
          <Terminal size={12} className="shrink-0 text-muted-foreground" />
          <span className="font-mono text-foreground/90">{gate.name}</span>
          <VerdictBadge passed={gate.passed} className="text-[10px]" />
        </div>
        {gate.output && (
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border/60 bg-background/60 p-2.5 font-mono text-[11px] leading-relaxed text-foreground/90">
            {gate.output}
          </pre>
        )}
      </div>
    );
  }
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2 text-xs">
        <Terminal size={12} className="shrink-0 text-muted-foreground" />
        <span className="font-mono text-foreground/90">{tool.name}</span>
        <Badge variant={tool.status === "error" ? "destructive" : "secondary"} className="text-[10px]">
          {tool.status}
        </Badge>
      </div>
      {tool.input && <JsonViewer data={tool.input} label="Input" />}
      {tool.output && <JsonViewer data={tool.output} label="Output" />}
    </div>
  );
}

/**
 * The routing decision a step led to — the "why it advanced or looped". A `route:*` fork renders as the full
 * {@link DecisionCard} (options + reasoning); a bare `loop_repeat`/`loop_jump` counter renders as a compact
 * inline note (mirrors the Phases tab). The feed only attaches `route:`/`loop_*` decisions, so those are all
 * this sees.
 */
function StepDecision({ decision }: { decision: Observation }): React.JSX.Element {
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
  return <DecisionCard observation={decision} />;
}

/**
 * The block → resume marker between two steps. When a step ended in a block — most tellingly an autonomy
 * escalation that paused the task awaiting the owner's decision — this is what turns the "implement, implement"
 * gap into an explained boundary: the run blocked, someone unblocked it, and the next step is the resume. It
 * drills into the reason/category (from the `task_blocked` transition) and the question asked (from the
 * `autonomy_policy` decision), bringing the Steps tab to parity with the Timeline. `hasResume` is false for a
 * block that is still the task's last step (waiting now), so the marker says "waiting" instead of "resumed".
 */
function BlockMarker({ block, hasResume }: { block: StepBlock<Observation>; hasResume: boolean }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const reason = readBlock(block.transition);
  const category = reason?.category ?? "";
  // `||` not `??` for the final fallback: an empty-string category is falsy but not nullish, so `??` would
  // keep "" and render an empty badge — `||` falls through to "Blocked".
  const label = BLOCK_CATEGORY_LABELS[category as keyof typeof BLOCK_CATEGORY_LABELS] || category || "Blocked";
  return (
    <div className="mx-3 rounded-md border border-amber-500/30 bg-amber-500/5">
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger asChild={true}>
          <button
            type="button"
            className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-amber-300 transition-colors hover:bg-amber-500/10"
          >
            <PauseCircle size={14} className="shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">Blocked</span>
                <Badge variant="outline" className="border-amber-500/40 text-amber-300 text-[10px]">
                  {label}
                </Badge>
                {hasResume ? (
                  <span className="flex items-center gap-1 text-[11px] text-emerald-400">
                    <Play size={10} />
                    resumed below
                  </span>
                ) : (
                  <span className="flex items-center gap-1 text-[11px] text-amber-400/80">
                    <ArrowRight size={10} className="animate-pulse" />
                    waiting
                  </span>
                )}
              </div>
              {reason?.needed && <p className="mt-0.5 truncate text-xs text-amber-200/70">{reason.needed}</p>}
            </div>
            <ChevronDown size={14} className={cn("shrink-0 transition-transform", open && "rotate-180")} />
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="space-y-2.5 border-t border-amber-500/20 px-3 py-2.5">
            {reason?.needed && <p className="text-sm text-foreground/80">{reason.needed}</p>}
            {block.policy && <DecisionCard observation={block.policy} />}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

function AgentTraceRow({
  trace,
  call,
  taskId,
  taskActive,
}: {
  trace: Observation;
  call: AgentCallShape | null;
  taskId: string;
  taskActive: boolean;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  // An open `agent_call` span (no end_time) on a running task is the call streaming right now — its
  // conversation should follow live. A closed span is replayed from its recorded rows.
  const isLive = taskActive && trace.end_time === null;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild={true}>
        <button
          type="button"
          className={cn(
            "flex w-full items-center gap-3 rounded-md border border-border px-3 py-2 text-left transition-colors",
            "hover:bg-muted/50",
            trace.status === "error" && "border-destructive/30 bg-destructive/5",
          )}
        >
          <BrainCircuit size={14} className="shrink-0 text-primary" />
          <AgentTraceHeader trace={trace} call={call} isLive={isLive} />
          <ChevronDown
            size={14}
            className={cn("shrink-0 transition-transform text-muted-foreground", open && "rotate-180")}
          />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mx-3 space-y-3 rounded-b-md border-x border-b border-border bg-muted/20 p-3">
          {trace.error_message && <div className="text-sm text-destructive">{trace.error_message}</div>}
          {call?.summary && <p className="text-sm text-foreground/80">{call.summary}</p>}
          {open && <AgentConversation taskId={taskId} callId={trace.id} live={isLive} />}
          <div className="space-y-1.5 border-t border-border/50 pt-2.5">
            <BlobViewer blobRef={call?.promptBlob} label="Prompt" />
            <BlobViewer blobRef={call?.resultBlob} label="Result" />
            <BlobViewer blobRef={call?.transcriptBlob} label="Transcript" />
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function AgentTraceHeader({
  trace,
  call,
  isLive,
}: {
  trace: Observation;
  call: AgentCallShape | null;
  isLive: boolean;
}): React.JSX.Element {
  // The honest row label is the step the agent ran (e.g. "implement"), NOT a model id — the model is not on
  // this span. Fall back to the span name so a malformed row still reads as something, then route the raw
  // sub-phase through SUB_PHASE_LABELS (mirroring StepRowHeader) so it reads human-readably — "Implement",
  // "Self Review", "PR Description" — with the raw name as a legible fallback for any unmapped sub-phase.
  const rawStep = call?.step || trace.name || "agent call";
  const label = SUB_PHASE_LABELS[rawStep] ?? rawStep;
  return (
    <div className="min-w-0 flex-1">
      <div className="flex items-center gap-2">
        <span className="truncate text-sm font-medium">{label}</span>
        <Badge variant="outline" className="text-[10px]">
          Agent
        </Badge>
        {isLive ? (
          <Badge variant="default" className="gap-1 text-[10px]">
            <Radio size={10} className="animate-pulse" />
            live
          </Badge>
        ) : (
          <Badge variant={trace.status === "error" ? "destructive" : "secondary"} className="text-[10px]">
            {trace.status}
          </Badge>
        )}
        {trace.phase && <span className="text-[10px] text-muted-foreground">{trace.phase}</span>}
      </div>
      <div className="mt-0.5 flex items-center gap-3 text-xs text-muted-foreground">
        <span className="tabular-nums">{formatTimestamp(trace.start_time)}</span>
        <span>{formatDuration(trace.duration_ms)}</span>
        {call && call.tokensIn > 0 && <span>{formatTokens(call.tokensIn)} in</span>}
        {call && call.tokensOut > 0 && <span>{formatTokens(call.tokensOut)} out</span>}
        {call && call.cacheReadTokens > 0 && <span>{formatTokens(call.cacheReadTokens)} cache read</span>}
        {call && call.cacheCreationTokens > 0 && <span>{formatTokens(call.cacheCreationTokens)} cache write</span>}
        {call?.costUsd != null && <CostDisplay amount={call.costUsd} size="sm" />}
      </div>
    </div>
  );
}

/**
 * One agent_call's conversation, reconstructed from its `agent_activity` children and rendered as a
 * chat-style feed inside its own scroll pane. The recorded backlog is fetched once on expand; when the call
 * is live, new rows also arrive over SSE and are appended, deduped by id — so a call that began before the
 * tab opened still shows its history, then keeps streaming. A tool result is paired beneath its tool call by
 * `tool_call_id`; an unpaired result renders on its own line. The pane lands at the latest line and
 * *follows* the bottom as content streams in (see {@link useStickToBottom}) — unless the reader scrolls up
 * to read back, which pins the view and surfaces a jump-to-latest control, exactly like a chat.
 */
function AgentConversation({
  taskId,
  callId,
  live,
}: {
  taskId: string;
  callId: string;
  live: boolean;
}): React.JSX.Element {
  // The recorded backlog. Closed calls fetch and stop; live calls fetch the history then layer SSE on top.
  const { data: recorded, isLoading } = useTaskAgentActivity(taskId, callId, true);
  const [streamed, setStreamed] = useState<Observation[]>([]);

  useSseSubscription("observation", (data) => {
    if (!live) {
      return;
    }
    const obs = data as Observation;
    if (obs.type !== "agent_activity" || obs.parent_observation_id !== callId) {
      return;
    }
    setStreamed((prev) => (prev.some((o) => o.id === obs.id) ? prev : [...prev, obs]));
  });

  const lines = useMemo(() => buildConversation(recorded ?? [], streamed), [recorded, streamed]);
  const tail = useStickToBottom(lines.length);

  if (isLoading) {
    return <Skeleton className="h-16 w-full" />;
  }
  if (lines.length === 0) {
    return (
      <p className="text-xs text-muted-foreground/70">
        {live ? "Waiting for the agent's first message…" : "No conversation was recorded for this call."}
      </p>
    );
  }

  return (
    <div className="relative">
      <div
        ref={tail.ref}
        onScroll={tail.onScroll}
        className="max-h-[26rem] space-y-2 overflow-y-auto overscroll-contain rounded-md border border-border/40 bg-background/30 px-3 py-2.5"
      >
        {lines.map((line) => (
          <ConversationLineRow key={line.key} line={line} />
        ))}
        {live && <StreamingPulse />}
      </div>
      {tail.adrift && (
        <button
          type="button"
          onClick={tail.toLatest}
          className="absolute inset-x-0 bottom-2 mx-auto flex w-fit items-center gap-1 rounded-full border border-border bg-background/95 px-2.5 py-1 text-[11px] font-medium text-muted-foreground shadow-sm backdrop-blur transition-colors hover:text-foreground"
        >
          <ArrowDown size={11} />
          Jump to latest
        </button>
      )}
    </div>
  );
}

/**
 * Chat-style "stick to the bottom" for a scroll pane. It lands at the end and *follows* new content as it
 * streams in; the moment the reader scrolls up it stops following (reading back is never yanked) and reports
 * `adrift` so a jump-to-latest control can surface. The follow runs in a layout effect — synchronously,
 * before paint — so the tail never flickers. `signal` is the value that changes when new content arrives
 * (the line count); the refs it touches are stable, so they are intentionally not effect dependencies.
 */
function useStickToBottom(signal: number): {
  ref: React.RefObject<HTMLDivElement | null>;
  onScroll: () => void;
  adrift: boolean;
  toLatest: () => void;
} {
  const ref = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const [adrift, setAdrift] = useState(false);

  function onScroll(): void {
    const el = ref.current;
    if (!el) {
      return;
    }
    // A little slack so a near-bottom position still counts as "following".
    following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    setAdrift(!following.current);
  }

  function toLatest(): void {
    const el = ref.current;
    if (!el) {
      return;
    }
    el.scrollTop = el.scrollHeight;
    following.current = true;
    setAdrift(false);
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-pin to the bottom whenever new content arrives (the line-count signal); the refs are stable and need no dependency.
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && following.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [signal]);

  return { ref, onScroll, adrift, toLatest };
}

/** A calm three-dot pulse at the tail of a live conversation — a quiet sign the agent is still working. */
function StreamingPulse(): React.JSX.Element {
  return (
    <div className="flex items-center gap-1.5 pt-0.5 text-[11px] text-muted-foreground/60">
      <span className="flex gap-0.5">
        <span className="h-1 w-1 animate-pulse rounded-full bg-primary/70" />
        <span className="h-1 w-1 animate-pulse rounded-full bg-primary/70 [animation-delay:200ms]" />
        <span className="h-1 w-1 animate-pulse rounded-full bg-primary/70 [animation-delay:400ms]" />
      </span>
      streaming
    </div>
  );
}

// ── Conversation reconstruction ─────────────────────────────────────────────────

/** A rendered conversation line: a text/thinking block, a tool call (with its paired result), or a lone result. */
interface ConversationLine {
  readonly key: string;
  readonly activity: AgentActivityShape;
  /** For a `tool_use` line, its paired `tool_result` (by tool_call_id); null until/unless one arrives. */
  readonly result: AgentActivityShape | null;
}

/**
 * Merge the recorded and live-streamed `agent_activity` rows into ordered conversation lines. Rows are deduped
 * by id (a live row already in the backlog is dropped), kept in arrival order, and narrowed. Tool results are
 * folded under their matching tool call by `tool_call_id`; the model `session` markers are dropped (the model
 * already shows in the call header). A result whose call is not in this conversation renders on its own line,
 * so nothing is ever hidden. Two passes keep each line immutable: index the results first, then emit.
 */
function buildConversation(recorded: readonly Observation[], streamed: readonly Observation[]): ConversationLine[] {
  const activities = narrowActivities(dedupeById([...recorded, ...streamed]));
  const resultByCallId = indexResultsByCallId(activities);
  const claimed = new Set<AgentActivityShape>();
  const lines: ConversationLine[] = [];

  for (const { id, activity } of activities) {
    if (activity.kind === "session" || claimed.has(activity)) {
      continue;
    }
    const result = activity.kind === "tool_use" ? (resultByCallId.get(activity.toolCallId) ?? null) : null;
    if (result) {
      claimed.add(result);
    }
    lines.push({ key: id, activity, result });
  }
  return lines;
}

/** An activity row paired with the observation id that keys its React element. */
interface IdentifiedActivity {
  readonly id: string;
  readonly activity: AgentActivityShape;
}

/** Narrow each row to its activity shape in arrival order, dropping any that fail to read. */
function narrowActivities(rows: readonly Observation[]): IdentifiedActivity[] {
  return rows.flatMap((row) => {
    const activity = readAgentActivity(row);
    return activity === null ? [] : [{ id: row.id, activity }];
  });
}

/** Index every tool_result by its tool_call_id (the last one wins) so each tool call can claim its result. */
function indexResultsByCallId(activities: readonly IdentifiedActivity[]): Map<string, AgentActivityShape> {
  const map = new Map<string, AgentActivityShape>();
  for (const { activity } of activities) {
    if (activity.kind === "tool_result" && activity.toolCallId) {
      map.set(activity.toolCallId, activity);
    }
  }
  return map;
}

/** Drop rows sharing an id, keeping first arrival — a live SSE row already present in the fetched backlog. */
function dedupeById(rows: readonly Observation[]): Observation[] {
  const seen = new Set<string>();
  return rows.flatMap((row) => {
    if (seen.has(row.id)) {
      return [];
    }
    seen.add(row.id);
    return [row];
  });
}

// ── Line renderers ───────────────────────────────────────────────────────────

function ConversationLineRow({ line }: { line: ConversationLine }): React.JSX.Element {
  const { activity } = line;
  if (activity.kind === "assistant_text") {
    return <AssistantLine activity={activity} />;
  }
  if (activity.kind === "thinking") {
    return <ThinkingLine activity={activity} />;
  }
  // A lone `tool_result` (its `tool_use` never arrived in this conversation) renders as a result-only card so
  // it is never silently dropped; a normal `tool_use` renders the call header with its paired result beneath.
  if (activity.kind === "tool_result") {
    return <LoneResultLine result={activity} />;
  }
  return <ToolLine call={activity} result={line.result} />;
}

function AssistantLine({ activity }: { activity: AgentActivityShape }): React.JSX.Element {
  // The model's actual answer — what a reader scans for first. Wrapped in a blue card so it stands clearly
  // apart from thinking (muted) and tool cards (neutral): tools are the "dig deeper", this is the response.
  // It always shows in FULL — a truncated preview resolves its blob automatically — and renders as markdown.
  const text = useResolvedText(activity);
  return (
    <div className="flex gap-2.5 rounded-md border border-primary/30 bg-primary/10 px-3 py-2.5">
      <MessageSquare size={15} className="mt-0.5 shrink-0 text-primary" />
      <Markdown className="min-w-0 flex-1 font-medium text-foreground">{text}</Markdown>
    </div>
  );
}

/**
 * The full text of an activity: the inline preview when it fit, otherwise the blob-stored remainder fetched
 * on mount. Used for the model's answer so the whole response is always visible — the headline is never
 * truncated behind a click (bulky tool I/O still is). Falls back to the preview while the blob loads, or if it
 * cannot be fetched.
 */
function useResolvedText(activity: AgentActivityShape): string {
  const blobRef = activity.truncated ? activity.textBlob : "";
  const [full, setFull] = useState<string | null>(null);

  useEffect(() => {
    if (!isBlobRef(blobRef)) {
      return;
    }
    let live = true;
    fetchBlob(blobRef)
      .then((result) => {
        if (live && result.status === "loaded") {
          setFull(result.text);
        }
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [blobRef]);

  return full ?? activity.text;
}

function ThinkingLine({ activity }: { activity: AgentActivityShape }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild={true}>
        <button
          type="button"
          className="flex items-center gap-1.5 text-xs italic text-muted-foreground/70 hover:text-muted-foreground"
        >
          <ChevronRight size={12} className={cn("transition-transform", open && "rotate-90")} />
          <Brain size={12} />
          Thinking
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="ml-5 mt-1 border-l-2 border-border/60 pl-3">
          <p className="whitespace-pre-wrap break-words text-xs italic leading-relaxed text-muted-foreground/80">
            {activity.text}
          </p>
          {activity.truncated && <BlobViewer blobRef={activity.textBlob} label="Full reasoning" className="mt-1" />}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function ToolLine({
  call,
  result,
}: {
  call: AgentActivityShape;
  result: AgentActivityShape | null;
}): React.JSX.Element {
  const errored = result?.status === "error";
  return (
    <div
      className={cn(
        "rounded-md border border-border/70 bg-background/40",
        errored && "border-destructive/30 bg-destructive/5",
      )}
    >
      <div className="flex items-center gap-2 px-2.5 py-1.5">
        <Wrench size={12} className="shrink-0 text-muted-foreground" />
        <span className="truncate font-mono text-xs font-medium text-foreground/90">{call.toolName || "tool"}</span>
        {result && (
          <Badge variant={errored ? "destructive" : "secondary"} className="ml-auto text-[10px]">
            {result.status}
          </Badge>
        )}
      </div>
      {call.input && (
        <div className="px-2.5 pb-2">
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded border border-border/50 bg-muted/30 p-2 font-mono text-[11px] leading-relaxed text-foreground/80">
            {call.input}
          </pre>
          {call.truncated && <BlobViewer blobRef={call.inputBlob} label="Full input" className="mt-1" />}
        </div>
      )}
      {result && <ToolResultBody result={result} />}
    </div>
  );
}

function ToolResultBody({ result }: { result: AgentActivityShape }): React.JSX.Element {
  return (
    <div className="border-t border-border/50 px-2.5 py-2">
      {result.output ? (
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded border border-border/50 bg-muted/20 p-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
          {result.output}
        </pre>
      ) : (
        <p className="text-[11px] text-muted-foreground/60">No output.</p>
      )}
      {result.truncated && <BlobViewer blobRef={result.outputBlob} label="Full output" className="mt-1" />}
    </div>
  );
}

/** A tool result whose tool call never arrived in this conversation — shown standalone so it is never dropped. */
function LoneResultLine({ result }: { result: AgentActivityShape }): React.JSX.Element {
  const errored = result.status === "error";
  return (
    <div
      className={cn(
        "rounded-md border border-border/70 bg-background/40",
        errored && "border-destructive/30 bg-destructive/5",
      )}
    >
      <div className="flex items-center gap-2 px-2.5 py-1.5">
        <Wrench size={12} className="shrink-0 text-muted-foreground" />
        <span className="font-mono text-xs font-medium text-foreground/90">tool result</span>
        <Badge variant={errored ? "destructive" : "secondary"} className="ml-auto text-[10px]">
          {result.status}
        </Badge>
      </div>
      <ToolResultBody result={result} />
    </div>
  );
}
