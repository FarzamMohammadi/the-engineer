import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../lib/api-client";
import { queryKeys } from "../lib/query-keys";
import type { DomainEvent, EventListResponse } from "../types/api";

interface EventFilters {
  type?: string;
  task_id?: string;
  limit?: number;
}

export function useEvents(filters: EventFilters = {}): ReturnType<typeof useQuery<DomainEvent[]>> {
  const params = new URLSearchParams();
  if (filters.type) params.set("type", filters.type);
  if (filters.task_id) params.set("task_id", filters.task_id);
  if (filters.limit) params.set("limit", String(filters.limit));

  const queryString = params.toString();
  const path = queryString ? `/events?${queryString}` : "/events";

  return useQuery({
    queryKey: queryKeys.events(Object.fromEntries(params)),
    queryFn: async () => {
      const res = await apiFetch<EventListResponse>(path);
      return res.events;
    },
  });
}
