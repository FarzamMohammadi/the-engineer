import { Activity, BookOpen, BrainCircuit, GitCommitHorizontal, Layers, Terminal } from "lucide-react";
import { BlobViewer } from "../../components/shared/blob-viewer";
import { CostDisplay } from "../../components/shared/cost-display";
import { DecisionCard } from "../../components/shared/decision-card";
import { EmptyState } from "../../components/shared/empty-state";
import { JsonViewer } from "../../components/shared/json-viewer";
import { TimeAgo } from "../../components/shared/time-ago";
import { VerdictPanel } from "../../components/shared/verdict-badge";
import { Badge } from "../../components/ui/badge";
import { Skeleton } from "../../components/ui/skeleton";
import { useTaskTimeline } from "../../hooks/use-tasks";
import { cn } from "../../lib/cn";
import { formatDuration, formatTimestamp, formatTokens } from "../../lib/formatters";
import { type AgentCallShape, readAgentCall } from "../../lib/observation-shapes";
import type { Observation, TimelineItem } from "../../types/api";

interface TaskTimelineTabProps {
  taskId: string;
}

/**
 * Unified chronological feed of state-change events, journal entries, and rich observations. Each observation
 * type renders in its own legible form — decisions as DecisionCards, verdicts as pass/fail gate panels, agent
 * calls with their cost and prompt/result/transcript blob drill-down — never a raw JSON dump. Where a new
 * dispatch begins (a fresh `trace_id` / a `task_execution` root span) a divider marks the boundary, so a
 * re-dispatched task reads as distinct runs rather than one merged stream.
 */
export function TaskTimelineTab({ taskId }: TaskTimelineTabProps): React.JSX.Element {
  const { data: timeline, isLoading } = useTaskTimeline(taskId);

  if (isLoading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={`sk-${String(i)}`} className="h-16 w-full" />
        ))}
      </div>
    );
  }

  if (!timeline || timeline.length === 0) {
    return <EmptyState icon={<Activity size={32} />} title="No timeline entries yet" />;
  }

  let dispatchTrace: string | null = null;
  let dispatchIndex = 0;

  return (
    <div className="relative space-y-0">
      <div className="absolute bottom-2 left-4 top-2 w-px bg-border" />
      {timeline.map((item, index) => {
        const boundary = dispatchBoundary(item, dispatchTrace);
        if (boundary.isNew) {
          dispatchTrace = boundary.traceId;
          dispatchIndex += 1;
        }
        return (
          <div key={timelineKey(item, index)}>
            {boundary.isNew && dispatchIndex > 1 && <DispatchDivider index={dispatchIndex} />}
            <TimelineEntry item={item} />
          </div>
        );
      })}
    </div>
  );
}

/** A boundary marker between dispatches — a re-dispatch mints a new trace, starting a fresh run. */
function DispatchDivider({ index }: { index: number }): React.JSX.Element {
  return (
    <div className="relative my-2 flex items-center gap-2 pl-1">
      <div className="z-10 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-primary/40 bg-primary/10 text-primary">
        <Layers size={13} />
      </div>
      <span className="text-xs font-medium text-primary">Dispatch {index}</span>
      <div className="h-px flex-1 bg-primary/20" />
    </div>
  );
}

/**
 * Decide whether this item opens a new dispatch. A dispatch is one trace; the first observation of a new
 * `trace_id` (or a `task_execution` root span) starts a new run. Events/journal carry no trace, so they never
 * trigger a boundary on their own.
 */
function dispatchBoundary(item: TimelineItem, currentTrace: string | null): { isNew: boolean; traceId: string } {
  if (item.kind !== "observation") {
    return { isNew: false, traceId: currentTrace ?? "" };
  }
  const traceId = typeof item.data["trace_id"] === "string" ? item.data["trace_id"] : "";
  if (!traceId) {
    return { isNew: false, traceId: currentTrace ?? "" };
  }
  return { isNew: traceId !== currentTrace, traceId };
}

function timelineKey(item: TimelineItem, index: number): string {
  return `${item.kind}-${item.timestamp}-${String(item.data["id"] ?? index)}`;
}

function TimelineEntry({ item }: { item: TimelineItem }): React.JSX.Element {
  const { icon, color } = kindMeta(item);

  return (
    <div className="relative flex gap-3 py-2 pl-1">
      <div className={cn("z-10 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border", color)}>
        {icon}
      </div>
      <div className="min-w-0 flex-1 pt-0.5">
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="text-[10px] uppercase">
            {entryLabel(item)}
          </Badge>
          {"type" in item.data && <span className="text-xs text-muted-foreground">{String(item.data["type"])}</span>}
          {"entry_type" in item.data && (
            <span className="text-xs text-muted-foreground">{String(item.data["entry_type"])}</span>
          )}
          <span className="ml-auto text-[11px] tabular-nums text-muted-foreground/70">
            {formatTimestamp(item.timestamp)}
          </span>
          <TimeAgo timestamp={item.timestamp} />
        </div>
        <TimelineBody item={item} />
      </div>
    </div>
  );
}

/** The body of a timeline entry — observations render type-specific, events/journal render their text/payload. */
function TimelineBody({ item }: { item: TimelineItem }): React.JSX.Element | null {
  if (item.kind === "observation") {
    return <ObservationBody observation={item.data as unknown as Observation} />;
  }
  return (
    <>
      {"content" in item.data && <p className="mt-1 text-sm text-foreground/80">{String(item.data["content"])}</p>}
      {"payload" in item.data && (
        <div className="mt-1">
          <JsonViewer data={item.data["payload"]} label="payload" />
        </div>
      )}
    </>
  );
}

/** Render an observation in its richest legible form by type — never a bare JSON dump where a card fits. */
function ObservationBody({ observation }: { observation: Observation }): React.JSX.Element {
  switch (observation.type) {
    case "decision_point":
      return <DecisionBody observation={observation} />;
    case "safety_verdict":
      return <VerdictPanel observation={observation} className="mt-1.5" />;
    case "agent_call":
      return <AgentCallBody observation={observation} call={readAgentCall(observation)} />;
    default:
      return <GenericObservationBody observation={observation} />;
  }
}

/** A decision renders as the full card; loop counters have no options so they read as a one-line note. */
function DecisionBody({ observation }: { observation: Observation }): React.JSX.Element {
  if (observation.name.startsWith("loop_")) {
    const count = typeof observation.input?.["count"] === "number" ? observation.input["count"] : null;
    return (
      <p className="mt-1 text-sm text-amber-400">
        {observation.name === "loop_jump" ? "Jumped back" : "Repeated phase"}
        {count !== null && ` (×${String(count)})`}
      </p>
    );
  }
  return <DecisionCard observation={observation} className="mt-1.5" />;
}

function AgentCallBody({
  observation,
  call,
}: {
  observation: Observation;
  call: AgentCallShape | null;
}): React.JSX.Element {
  return (
    <div className="mt-1.5 space-y-1.5">
      <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        <span className="font-mono text-foreground/80">{call?.step || observation.name}</span>
        <span>{formatDuration(observation.duration_ms)}</span>
        {call && call.tokensIn + call.tokensOut > 0 && (
          <span>{formatTokens(call.tokensIn + call.tokensOut)} tokens</span>
        )}
        {call?.costUsd != null && <CostDisplay amount={call.costUsd} size="sm" />}
      </div>
      {call?.summary && <p className="text-sm text-foreground/80">{call.summary}</p>}
      {observation.error_message && <p className="text-sm text-destructive">{observation.error_message}</p>}
      <BlobViewer blobRef={call?.promptBlob} label="Prompt" />
      <BlobViewer blobRef={call?.resultBlob} label="Result" />
      <BlobViewer blobRef={call?.transcriptBlob} label="Transcript" />
    </div>
  );
}

/** A state_transition / tool_execution / other observation — its name plus input/output for drill-down. */
function GenericObservationBody({ observation }: { observation: Observation }): React.JSX.Element {
  return (
    <>
      <p className="mt-1 font-mono text-sm text-foreground/80">{observation.name}</p>
      {observation.error_message && <p className="mt-1 text-sm text-destructive">{observation.error_message}</p>}
      {(observation.input || observation.output) && (
        <div className="mt-1 space-y-1">
          {observation.input && <JsonViewer data={observation.input} label="input" />}
          {observation.output && <JsonViewer data={observation.output} label="output" />}
        </div>
      )}
    </>
  );
}

/** The short label for a timeline entry — the observation type for observations, the kind otherwise. */
function entryLabel(item: TimelineItem): string {
  if (item.kind === "observation" && typeof item.data["type"] === "string") {
    return String(item.data["type"]);
  }
  return item.kind;
}

function kindMeta(item: TimelineItem): { icon: React.JSX.Element; color: string } {
  if (item.kind === "observation") {
    return observationMeta(typeof item.data["type"] === "string" ? item.data["type"] : "");
  }
  if (item.kind === "event") {
    return { icon: <GitCommitHorizontal size={14} />, color: "border-blue-500/40 bg-blue-500/10 text-blue-400" };
  }
  return { icon: <BookOpen size={14} />, color: "border-emerald-500/40 bg-emerald-500/10 text-emerald-400" };
}

function observationMeta(type: string): { icon: React.JSX.Element; color: string } {
  switch (type) {
    case "agent_call":
      return { icon: <BrainCircuit size={14} />, color: "border-primary/40 bg-primary/10 text-primary" };
    case "tool_execution":
      return { icon: <Terminal size={14} />, color: "border-zinc-500/40 bg-zinc-500/10 text-zinc-400" };
    case "decision_point":
      return { icon: <GitCommitHorizontal size={14} />, color: "border-amber-500/40 bg-amber-500/10 text-amber-400" };
    default:
      return { icon: <Activity size={14} />, color: "border-purple-500/40 bg-purple-500/10 text-purple-400" };
  }
}
