import { BrainCircuit, ChevronDown } from "lucide-react";
import { useState } from "react";
import { CostDisplay } from "../../components/shared/cost-display";
import { EmptyState } from "../../components/shared/empty-state";
import { JsonViewer } from "../../components/shared/json-viewer";
import { Badge } from "../../components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../../components/ui/collapsible";
import { Skeleton } from "../../components/ui/skeleton";
import { useTaskLlmTraces } from "../../hooks/use-tasks";
import { cn } from "../../lib/cn";
import { formatDuration, formatTimestamp, formatTokens } from "../../lib/formatters";
import type { Observation } from "../../types/api";

interface TaskLlmTabProps {
  taskId: string;
}

export function TaskLlmTab({ taskId }: TaskLlmTabProps): React.JSX.Element {
  const { data: traces, isLoading } = useTaskLlmTraces(taskId);

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
    return <EmptyState icon={<BrainCircuit size={32} />} title="No LLM calls recorded" />;
  }

  const totalCost = traces.reduce((sum, t) => {
    const meta = t.metadata as Record<string, unknown> | null;
    return sum + (typeof meta?.["cost_usd"] === "number" ? meta["cost_usd"] : 0);
  }, 0);
  const totalTokens = traces.reduce((sum, t) => {
    const meta = t.metadata as Record<string, unknown> | null;
    return sum + (typeof meta?.["total_tokens"] === "number" ? meta["total_tokens"] : 0);
  }, 0);

  return (
    <div className="space-y-4">
      <div className="flex gap-4 text-sm text-muted-foreground">
        <span>{traces.length} calls</span>
        <span>
          Total: <CostDisplay amount={totalCost} size="sm" />
        </span>
        <span>{formatTokens(totalTokens)} tokens</span>
      </div>
      <div className="space-y-2">
        {traces.map((trace) => (
          <LlmTraceRow key={trace.id} trace={trace} />
        ))}
      </div>
    </div>
  );
}

interface ParsedLlmMeta {
  model: string;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  raw: Record<string, unknown>;
}

function parseLlmMeta(trace: Observation): ParsedLlmMeta {
  const raw = (trace.metadata ?? {}) as Record<string, unknown>;
  return {
    model: String(raw["model"] ?? trace.name ?? "unknown"),
    costUsd: typeof raw["cost_usd"] === "number" ? raw["cost_usd"] : null,
    inputTokens: typeof raw["input_tokens"] === "number" ? raw["input_tokens"] : null,
    outputTokens: typeof raw["output_tokens"] === "number" ? raw["output_tokens"] : null,
    raw,
  };
}

function LlmTraceRow({ trace }: { trace: Observation }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const meta = parseLlmMeta(trace);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className={cn(
            "flex w-full items-center gap-3 rounded-md border border-border px-3 py-2 text-left transition-colors",
            "hover:bg-muted/50",
            trace.status === "error" && "border-destructive/30 bg-destructive/5",
          )}
        >
          <BrainCircuit size={14} className="shrink-0 text-primary" />
          <LlmTraceHeader trace={trace} meta={meta} />
          <ChevronDown
            size={14}
            className={cn("shrink-0 transition-transform text-muted-foreground", open && "rotate-180")}
          />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mx-3 border-x border-b border-border rounded-b-md p-3 space-y-3 bg-muted/20">
          {trace.error_message && <div className="text-sm text-destructive">{trace.error_message}</div>}
          {trace.input && <JsonViewer data={trace.input} label="Input" />}
          {trace.output && <JsonViewer data={trace.output} label="Output" />}
          {Object.keys(meta.raw).length > 0 && <JsonViewer data={meta.raw} label="Metadata" />}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function LlmTraceHeader({ trace, meta }: { trace: Observation; meta: ParsedLlmMeta }): React.JSX.Element {
  return (
    <div className="flex-1 min-w-0">
      <div className="flex items-center gap-2">
        <span className="truncate text-sm font-medium">{meta.model}</span>
        <Badge variant={trace.status === "error" ? "destructive" : "secondary"} className="text-[10px]">
          {trace.status}
        </Badge>
        {trace.phase && <span className="text-[10px] text-muted-foreground">{trace.phase}</span>}
      </div>
      <div className="flex items-center gap-3 text-xs text-muted-foreground mt-0.5">
        <span className="tabular-nums">{formatTimestamp(trace.start_time)}</span>
        <span>{formatDuration(trace.duration_ms)}</span>
        {meta.inputTokens != null && <span>{formatTokens(meta.inputTokens)} in</span>}
        {meta.outputTokens != null && <span>{formatTokens(meta.outputTokens)} out</span>}
        {meta.costUsd != null && <CostDisplay amount={meta.costUsd} size="sm" />}
      </div>
    </div>
  );
}
