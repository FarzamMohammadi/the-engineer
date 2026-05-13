import { useEffect, useRef } from "react";
import { Link } from "react-router";
import { Badge } from "../../components/ui/badge";
import { ScrollArea } from "../../components/ui/scroll-area";
import { cn } from "../../lib/cn";
import { OBSERVATION_TYPE_LABELS } from "../../lib/constants";
import { formatTimestamp } from "../../lib/formatters";
import { ROUTES } from "../../lib/routes";
import type { ActivityItem, ObservationType } from "../../types/api";

interface ActivityFeedProps {
  items: ActivityItem[];
  autoScroll: boolean;
}

export function ActivityFeed({ items, autoScroll }: ActivityFeedProps): React.JSX.Element {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (autoScroll) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [items.length, autoScroll]);

  return (
    <ScrollArea className="h-[calc(100vh-220px)]">
      <div className="space-y-0.5 pr-4">
        {items.map((item) => (
          <ActivityRow key={getItemId(item)} item={item} />
        ))}
        <div ref={bottomRef} />
      </div>
    </ScrollArea>
  );
}

function ActivityRow({ item }: { item: ActivityItem }): React.JSX.Element {
  if (item.source === "observation") {
    const obs = item.data;
    return (
      <div className="flex items-center gap-3 rounded-md px-2 py-1.5 text-xs transition-colors hover:bg-accent">
        <span className="w-16 shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
          {formatTimestamp(obs.start_time)}
        </span>
        <Badge variant="outline" className="w-16 justify-center text-[10px]">
          {OBSERVATION_TYPE_LABELS[obs.type as ObservationType] ?? obs.type}
        </Badge>
        <span className="min-w-0 flex-1 truncate text-foreground">{obs.name}</span>
        {obs.task_id && (
          <Link
            to={ROUTES.taskDetail(obs.task_id)}
            className="shrink-0 truncate text-[10px] text-primary hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            {obs.task_id.slice(0, 8)}
          </Link>
        )}
        <LevelDot level={obs.level} />
      </div>
    );
  }

  const evt = item.data;
  return (
    <div className="flex items-center gap-3 rounded-md px-2 py-1.5 text-xs transition-colors hover:bg-accent">
      <span className="w-16 shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
        {formatTimestamp(evt.timestamp)}
      </span>
      <Badge variant="secondary" className="w-16 justify-center text-[10px]">
        Event
      </Badge>
      <span className="min-w-0 flex-1 truncate text-foreground">{evt.type}</span>
      {evt.task_id && (
        <Link
          to={ROUTES.taskDetail(evt.task_id)}
          className="shrink-0 truncate text-[10px] text-primary hover:underline"
          onClick={(e) => e.stopPropagation()}
        >
          {evt.task_id.slice(0, 8)}
        </Link>
      )}
      <LevelDot level="info" />
    </div>
  );
}

function LevelDot({ level }: { level: string }): React.JSX.Element {
  return (
    <span
      className={cn(
        "h-1.5 w-1.5 shrink-0 rounded-full",
        level === "error" && "bg-red-400",
        level === "warn" && "bg-amber-400",
        level === "info" && "bg-blue-400",
        level === "debug" && "bg-zinc-500",
      )}
      title={level}
    />
  );
}

function getItemId(item: ActivityItem): string {
  return item.source === "observation" ? `obs-${item.data.id}` : `evt-${item.data.id}`;
}
