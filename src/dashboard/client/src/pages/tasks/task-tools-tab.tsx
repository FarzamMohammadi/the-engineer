import { ChevronDown, Terminal } from "lucide-react";
import { useState } from "react";
import { EmptyState } from "../../components/shared/empty-state";
import { JsonViewer } from "../../components/shared/json-viewer";
import { Badge } from "../../components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../../components/ui/collapsible";
import { Skeleton } from "../../components/ui/skeleton";
import { useTaskToolTraces } from "../../hooks/use-tasks";
import { cn } from "../../lib/cn";
import { formatDuration, formatTimestamp } from "../../lib/formatters";
import type { Observation } from "../../types/api";

interface TaskToolsTabProps {
  taskId: string;
}

export function TaskToolsTab({ taskId }: TaskToolsTabProps): React.JSX.Element {
  const { data: traces, isLoading } = useTaskToolTraces(taskId);

  if (isLoading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={`sk-${String(i)}`} className="h-16 w-full" />
        ))}
      </div>
    );
  }

  if (!traces || traces.length === 0) {
    return <EmptyState icon={<Terminal size={32} />} title="No tool executions recorded" />;
  }

  const errorCount = traces.filter((t) => t.status === "error").length;

  return (
    <div className="space-y-4">
      <div className="flex gap-4 text-sm text-muted-foreground">
        <span>{traces.length} executions</span>
        {errorCount > 0 && <span className="text-destructive">{errorCount} errors</span>}
      </div>
      <div className="space-y-2">
        {traces.map((trace) => (
          <ToolTraceRow key={trace.id} trace={trace} />
        ))}
      </div>
    </div>
  );
}

function ToolTraceRow({ trace }: { trace: Observation }): React.JSX.Element {
  const [open, setOpen] = useState(false);

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
          <Terminal size={14} className="shrink-0 text-muted-foreground" />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-medium font-mono">{trace.name}</span>
              <Badge variant={trace.status === "error" ? "destructive" : "secondary"} className="text-[10px]">
                {trace.status}
              </Badge>
              {trace.phase && <span className="text-[10px] text-muted-foreground">{trace.phase}</span>}
            </div>
            <div className="flex items-center gap-3 text-xs text-muted-foreground mt-0.5">
              <span className="tabular-nums">{formatTimestamp(trace.start_time)}</span>
              <span>{formatDuration(trace.duration_ms)}</span>
            </div>
          </div>
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
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
