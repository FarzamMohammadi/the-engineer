import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../lib/api-client";
import { STALE_TIMES } from "../lib/constants";
import { queryKeys } from "../lib/query-keys";
import type { CostMetrics, QuotaStatus } from "../types/api";

/** Fetch and cache aggregated LLM cost metrics from /api/metrics/cost. */
export function useCostMetrics(): ReturnType<typeof useQuery<CostMetrics>> {
  return useQuery({
    queryKey: queryKeys.metrics.cost,
    queryFn: () => apiFetch<CostMetrics>("/metrics/cost"),
    staleTime: STALE_TIMES.metrics,
  });
}

/** Fetch and cache current quota/rate-limit status from /api/metrics/quota. */
export function useQuotaStatus(): ReturnType<typeof useQuery<QuotaStatus>> {
  return useQuery({
    queryKey: queryKeys.metrics.quota,
    queryFn: () => apiFetch<QuotaStatus>("/metrics/quota"),
    staleTime: STALE_TIMES.metrics,
  });
}
