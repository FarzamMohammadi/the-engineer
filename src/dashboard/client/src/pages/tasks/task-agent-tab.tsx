import { ArrowDown, Brain, BrainCircuit, ChevronDown, ChevronRight, MessageSquare, Radio, Wrench } from "lucide-react";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { BlobViewer } from "../../components/shared/blob-viewer";
import { CostDisplay } from "../../components/shared/cost-display";
import { EmptyState } from "../../components/shared/empty-state";
import { Badge } from "../../components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../../components/ui/collapsible";
import { Skeleton } from "../../components/ui/skeleton";
import { useEvents } from "../../hooks/use-events";
import { useSseSubscription } from "../../hooks/use-sse";
import { useTaskAgentActivity, useTaskAgentTraces } from "../../hooks/use-tasks";
import { cn } from "../../lib/cn";
import { modelsFromCostEvents } from "../../lib/cost-events";
import { formatDuration, formatTimestamp, formatTokens } from "../../lib/formatters";
import {
  type AgentActivityShape,
  type AgentCallShape,
  readAgentActivity,
  readAgentCall,
} from "../../lib/observation-shapes";
import type { Observation } from "../../types/api";

interface TaskAgentTabProps {
  taskId: string;
  /** True while the task is actively executing — only then can an open `agent_call` be streaming live. */
  taskActive: boolean;
}

/**
 * Agent call inspector. Each `agent_call` span carries its cost, tokens, and blob refs in `output` (never in
 * `metadata`, which the observer never writes), so totals and per-call figures read from there. The model id
 * is NOT on the span — it rides the task's `cost.incurred` events, joined at the task level and shown as
 * header context rather than mislabeling each step name as a model. Expanding a row reveals the agent's
 * conversation — assistant messages, thinking, tool calls and their results — reconstructed from the
 * `agent_activity` children: live while the call's span is open and the task runs, re-watchable once it closes.
 */
export function TaskAgentTab({ taskId, taskActive }: TaskAgentTabProps): React.JSX.Element {
  const { data: traces, isLoading } = useTaskAgentTraces(taskId);
  const { data: costEvents } = useEvents({ type: "cost.incurred", task_id: taskId, limit: 500 });

  if (isLoading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={`sk-${String(i)}`} className="h-20 w-full" />
        ))}
      </div>
    );
  }

  if (!traces || traces.length === 0) {
    return <EmptyState icon={<BrainCircuit size={32} />} title="No agent calls recorded" />;
  }

  const calls = traces.map((trace) => ({ trace, call: readAgentCall(trace) }));
  const totalCost = calls.reduce((sum, { call }) => sum + (call?.costUsd ?? 0), 0);
  const hasCost = calls.some(({ call }) => call?.costUsd != null);
  const totalTokens = calls.reduce((sum, { call }) => sum + (call ? call.tokensIn + call.tokensOut : 0), 0);
  const models = modelsFromCostEvents(costEvents ?? []);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
        <span>{traces.length} calls</span>
        <span className="flex items-center gap-1">
          Total: {hasCost ? <CostDisplay amount={totalCost} size="sm" /> : <span className="text-xs">no pricing</span>}
        </span>
        <span>{formatTokens(totalTokens)} tokens</span>
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
      <div className="space-y-2">
        {calls.map(({ trace, call }) => (
          <AgentTraceRow key={trace.id} trace={trace} call={call} taskId={taskId} taskActive={taskActive} />
        ))}
      </div>
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
  // this span. Fall back to the span name so a malformed row still reads as something.
  const label = call?.step || trace.name || "agent call";
  return (
    <div className="min-w-0 flex-1">
      <div className="flex items-center gap-2">
        <span className="truncate text-sm font-medium">{label}</span>
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
        {call && call.cacheReadTokens > 0 && <span>{formatTokens(call.cacheReadTokens)} cache</span>}
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
  return (
    <div className="flex gap-2">
      <MessageSquare size={13} className="mt-0.5 shrink-0 text-primary/80" />
      <div className="min-w-0 flex-1">
        <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground/90">{activity.text}</p>
        {activity.truncated && <BlobViewer blobRef={activity.textBlob} label="Full message" className="mt-1" />}
      </div>
    </div>
  );
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
