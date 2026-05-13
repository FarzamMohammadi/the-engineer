import { Activity, BookOpen, GitCommitHorizontal } from "lucide-react";
import { EmptyState } from "../../components/shared/empty-state";
import { JsonViewer } from "../../components/shared/json-viewer";
import { TimeAgo } from "../../components/shared/time-ago";
import { Badge } from "../../components/ui/badge";
import { Skeleton } from "../../components/ui/skeleton";
import { useTaskTimeline } from "../../hooks/use-tasks";
import { cn } from "../../lib/cn";
import { formatTimestamp } from "../../lib/formatters";
import type { TimelineItem } from "../../types/api";

interface TaskTimelineTabProps {
  taskId: string;
}

/** Unified chronological feed of state changes, journal entries, and tool executions. */
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

  return (
    <div className="relative space-y-0">
      <div className="absolute left-4 top-2 bottom-2 w-px bg-border" />
      {timeline.map((item) => (
        <TimelineEntry key={`${item.kind}-${item.timestamp}-${String(item.data["id"] ?? "")}`} item={item} />
      ))}
    </div>
  );
}

function TimelineEntry({ item }: { item: TimelineItem }): React.JSX.Element {
  const { icon, color } = kindMeta(item.kind);

  return (
    <div className="relative flex gap-3 py-2 pl-1">
      <div className={cn("z-10 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border", color)}>
        {icon}
      </div>
      <div className="flex-1 min-w-0 pt-0.5">
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="text-[10px] uppercase">
            {item.kind}
          </Badge>
          {"type" in item.data && <span className="text-xs text-muted-foreground">{String(item.data["type"])}</span>}
          {"entry_type" in item.data && (
            <span className="text-xs text-muted-foreground">{String(item.data["entry_type"])}</span>
          )}
          <span className="ml-auto text-[11px] text-muted-foreground/70 tabular-nums">
            {formatTimestamp(item.timestamp)}
          </span>
          <TimeAgo timestamp={item.timestamp} />
        </div>
        {"content" in item.data && <p className="mt-1 text-sm text-foreground/80">{String(item.data["content"])}</p>}
        {"name" in item.data && item.kind === "action" && (
          <p className="mt-1 text-sm text-foreground/80 font-mono">{String(item.data["name"])}</p>
        )}
        {"payload" in item.data && (
          <div className="mt-1">
            <JsonViewer data={item.data["payload"]} label="payload" />
          </div>
        )}
      </div>
    </div>
  );
}

function kindMeta(kind: string): { icon: React.JSX.Element; color: string } {
  switch (kind) {
    case "event":
      return {
        icon: <GitCommitHorizontal size={14} />,
        color: "border-blue-500/40 bg-blue-500/10 text-blue-400",
      };
    case "journal":
      return {
        icon: <BookOpen size={14} />,
        color: "border-emerald-500/40 bg-emerald-500/10 text-emerald-400",
      };
    case "action":
      return {
        icon: <Activity size={14} />,
        color: "border-purple-500/40 bg-purple-500/10 text-purple-400",
      };
    default:
      return {
        icon: <Activity size={14} />,
        color: "border-border bg-muted text-muted-foreground",
      };
  }
}
