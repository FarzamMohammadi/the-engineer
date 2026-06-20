import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../lib/api-client";
import { queryKeys } from "../lib/query-keys";
import type { Observation, ObservationListResponse } from "../types/api";
import { LIVE_REFETCH_MS } from "./use-tasks";

interface ObservationFilters {
  type?: string;
  task_id?: string;
  level?: string;
  limit?: number;
  /** Poll while a task is running so newly-emitted observations appear within one cadence; off by default. */
  active?: boolean;
}

/** Fetch and cache observations from /api/observations with optional type, task, level, and limit filters. */
export function useObservations(filters: ObservationFilters = {}): ReturnType<typeof useQuery<Observation[]>> {
  const params = new URLSearchParams();
  if (filters.type) {
    params.set("type", filters.type);
  }
  if (filters.task_id) {
    params.set("task_id", filters.task_id);
  }
  if (filters.level) {
    params.set("level", filters.level);
  }
  if (filters.limit) {
    params.set("limit", String(filters.limit));
  }

  const queryString = params.toString();
  const path = queryString ? `/observations?${queryString}` : "/observations";

  return useQuery({
    queryKey: queryKeys.observations(Object.fromEntries(params)),
    queryFn: async () => {
      const response = await apiFetch<ObservationListResponse>(path);
      return response.observations;
    },
    refetchInterval: filters.active ? LIVE_REFETCH_MS : false,
  });
}
