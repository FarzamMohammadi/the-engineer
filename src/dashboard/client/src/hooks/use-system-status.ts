import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../lib/api-client";
import { STALE_TIMES } from "../lib/constants";
import { queryKeys } from "../lib/query-keys";
import type { SystemStatus } from "../types/api";

export function useSystemStatus(): ReturnType<typeof useQuery<SystemStatus>> {
  return useQuery({
    queryKey: queryKeys.systemStatus,
    queryFn: () => apiFetch<SystemStatus>("/system/status"),
    staleTime: STALE_TIMES.systemStatus,
    refetchInterval: STALE_TIMES.systemStatus,
  });
}
