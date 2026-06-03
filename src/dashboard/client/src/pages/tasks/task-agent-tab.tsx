import { BrainCircuit, ChevronDown } from "lucide-react";
import { useState } from "react";
import { BlobViewer } from "../../components/shared/blob-viewer";
import { CostDisplay } from "../../components/shared/cost-display";
import { EmptyState } from "../../components/shared/empty-state";
import { Badge } from "../../components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../../components/ui/collapsible";
import { Skeleton } from "../../components/ui/skeleton";
import { useEvents } from "../../hooks/use-events";
import { useTaskAgentTraces } from "../../hooks/use-tasks";
import { cn } from "../../lib/cn";
import { modelsFromCostEvents } from "../../lib/cost-events";
import { formatDuration, formatTimestamp, formatTokens } from "../../lib/formatters";
import { type AgentCallShape, readAgentCall } from "../../lib/observation-shapes";
import type { Observation } from "../../types/api";

interface TaskAgentTabProps {
  taskId: string;
}

/**
 * Agent call inspector. Each `agent_call` span carries its cost, tokens, and blob refs in `output` (never in
 * `metadata`, which the observer never writes), so totals and per-call figures read from there. The model id
 * is NOT on the span — it rides the task's `cost.incurred` events, joined at the task level and shown as
 * header context rather than mislabeling each step name as a model. Prompt, result, and transcript blobs
 * drill down via the lazy BlobViewer so the owner can read exactly what the agent was asked and answered.
 */
export function TaskAgentTab({ taskId }: TaskAgentTabProps): React.JSX.Element {
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
          <AgentTraceRow key={trace.id} trace={trace} call={call} />
        ))}
      </div>
    </div>
  );
}

function AgentTraceRow({ trace, call }: { trace: Observation; call: AgentCallShape | null }): React.JSX.Element {
  const [open, setOpen] = useState(false);

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
          <AgentTraceHeader trace={trace} call={call} />
          <ChevronDown
            size={14}
            className={cn("shrink-0 transition-transform text-muted-foreground", open && "rotate-180")}
          />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mx-3 space-y-2 rounded-b-md border-x border-b border-border bg-muted/20 p-3">
          {trace.error_message && <div className="text-sm text-destructive">{trace.error_message}</div>}
          {call?.summary && <p className="text-sm text-foreground/80">{call.summary}</p>}
          <BlobViewer blobRef={call?.promptBlob} label="Prompt" />
          <BlobViewer blobRef={call?.resultBlob} label="Result" />
          <BlobViewer blobRef={call?.transcriptBlob} label="Transcript" />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function AgentTraceHeader({ trace, call }: { trace: Observation; call: AgentCallShape | null }): React.JSX.Element {
  // The honest row label is the step the agent ran (e.g. "implement"), NOT a model id — the model is not on
  // this span. Fall back to the span name so a malformed row still reads as something.
  const label = call?.step || trace.name || "agent call";
  return (
    <div className="min-w-0 flex-1">
      <div className="flex items-center gap-2">
        <span className="truncate text-sm font-medium">{label}</span>
        <Badge variant={trace.status === "error" ? "destructive" : "secondary"} className="text-[10px]">
          {trace.status}
        </Badge>
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
