import { Activity } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { EmptyState } from "../../components/shared/empty-state";
import { Skeleton } from "../../components/ui/skeleton";
import { useEvents } from "../../hooks/use-events";
import { useObservations } from "../../hooks/use-observations";
import { useSseSubscription } from "../../hooks/use-sse";
import type { ActivityItem, DomainEvent, Observation, ObservationLevel, ObservationType } from "../../types/api";
import { ActivityFeed } from "./activity-feed";
import { ActivityFilters } from "./activity-filters";

const MAX_ITEMS = 500;

/** Real-time activity stream combining API backfill with live SSE events. */
export function ActivityPage(): React.JSX.Element {
  const [sseItems, setSseItems] = useState<ActivityItem[]>([]);
  const [autoScroll, setAutoScroll] = useState(true);
  const [selectedTypes, setSelectedTypes] = useState<Set<ObservationType>>(new Set());
  const [selectedLevels, setSelectedLevels] = useState<Set<ObservationLevel>>(new Set());

  const { data: observations, isLoading: obsLoading } = useObservations({ limit: 200 });
  const { data: events, isLoading: evtLoading } = useEvents({ limit: 100 });

  useSseSubscription(
    "observation",
    useCallback((data: unknown) => {
      const observation = data as Observation;
      setSseItems((prev) => [...prev, { source: "observation", data: observation }].slice(-MAX_ITEMS));
    }, []),
  );

  useSseSubscription(
    "event",
    useCallback((data: unknown) => {
      const domainEvent = data as DomainEvent;
      setSseItems((prev) => [...prev, { source: "event", data: domainEvent }].slice(-MAX_ITEMS));
    }, []),
  );

  const backfillItems = useMemo((): ActivityItem[] => {
    const items: ActivityItem[] = [];
    if (observations) {
      for (const obs of observations) {
        items.push({ source: "observation", data: observation });
      }
    }
    if (events) {
      for (const domainEvent of events) {
        items.push({ source: "event", data: domainEvent });
      }
    }
    items.sort((a, b) => {
      const aTime = a.source === "observation" ? a.data.start_time : a.data.timestamp;
      const bTime = b.source === "observation" ? b.data.start_time : b.data.timestamp;
      return aTime.localeCompare(bTime);
    });
    return items;
  }, [observations, events]);

  const allItems = useMemo((): ActivityItem[] => {
    const sseIds = new Set(sseItems.map((i) => (i.source === "observation" ? i.data.id : i.data.id)));
    const dedupedBackfill = backfillItems.filter((i) => {
      const id = i.source === "observation" ? i.data.id : i.data.id;
      return !sseIds.has(id);
    });
    return [...dedupedBackfill, ...sseItems].slice(-MAX_ITEMS);
  }, [backfillItems, sseItems]);

  const filtered = useMemo(
    () => filterActivityItems(allItems, selectedTypes, selectedLevels),
    [allItems, selectedTypes, selectedLevels],
  );

  const isLoading = obsLoading || evtLoading;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Activity</h1>
        <span className="text-xs text-muted-foreground">{filtered.length} items</span>
      </div>

      <ActivityFilters
        selectedTypes={selectedTypes}
        onToggleType={(type) =>
          setSelectedTypes((prev) => {
            const next = new Set(prev);
            if (next.has(type)) {
              next.delete(type);
            } else {
              next.add(type);
            }
            return next;
          })
        }
        selectedLevels={selectedLevels}
        onToggleLevel={(level) =>
          setSelectedLevels((prev) => {
            const next = new Set(prev);
            if (next.has(level)) {
              next.delete(level);
            } else {
              next.add(level);
            }
            return next;
          })
        }
        autoScroll={autoScroll}
        onToggleAutoScroll={() => setAutoScroll((v) => !v)}
      />

      {isLoading ? (
        <div className="space-y-1">
          {Array.from({ length: 15 }, (_, i) => (
            <Skeleton key={`sk-${String(i)}`} className="h-8 w-full" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={<Activity size={32} />}
          title="No activity yet"
          description="Observations and events will stream here as the daemon runs"
        />
      ) : (
        <ActivityFeed items={filtered} autoScroll={autoScroll} />
      )}
    </div>
  );
}

function matchesObservationFilters(
  item: ActivityItem & { source: "observation" },
  types: Set<ObservationType>,
  levels: Set<ObservationLevel>,
): boolean {
  if (types.size > 0 && !types.has(item.data.type as ObservationType)) {
    return false;
  }
  if (levels.size > 0 && !levels.has(item.data.level as ObservationLevel)) {
    return false;
  }
  return true;
}

function matchesEventFilters(types: Set<ObservationType>, levels: Set<ObservationLevel>): boolean {
  if (types.size > 0) {
    return false;
  }
  if (levels.size > 0 && !levels.has("info")) {
    return false;
  }
  return true;
}

function filterActivityItems(
  items: ActivityItem[],
  types: Set<ObservationType>,
  levels: Set<ObservationLevel>,
): ActivityItem[] {
  if (types.size === 0 && levels.size === 0) {
    return items;
  }
  return items.filter((item) =>
    item.source === "observation" ? matchesObservationFilters(item, types, levels) : matchesEventFilters(types, levels),
  );
}
