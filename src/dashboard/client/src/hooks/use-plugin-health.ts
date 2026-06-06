import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../lib/api-client";
import { STALE_TIMES } from "../lib/constants";
import { queryKeys } from "../lib/query-keys";
import type { PluginHealthResponse } from "../types/api";

/**
 * Poll and cache current per-plugin health from /api/system/plugin-health. The records are advisory
 * (selection never reads them), so this drives a display-only card. Polled on the system-status cadence
 * so the owner sees a recovery flip back to healthy without a manual refresh.
 */
export function usePluginHealth(): ReturnType<typeof useQuery<PluginHealthResponse>> {
  return useQuery({
    queryKey: queryKeys.pluginHealth,
    queryFn: () => apiFetch<PluginHealthResponse>("/system/plugin-health"),
    staleTime: STALE_TIMES.systemStatus,
    refetchInterval: STALE_TIMES.systemStatus,
  });
}
