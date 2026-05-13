import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../lib/api-client";
import { queryKeys } from "../lib/query-keys";
import type { ErrorEntry, ErrorListResponse } from "../types/api";

interface ErrorFilters {
  level?: "error" | "warn";
  limit?: number;
}

/** Fetch and cache the consolidated error list from /api/errors with optional level/limit filters. */
export function useErrors(filters: ErrorFilters = {}): ReturnType<typeof useQuery<ErrorEntry[]>> {
  const params = new URLSearchParams();
  if (filters.level) {
    params.set("level", filters.level);
  }
  if (filters.limit) {
    params.set("limit", String(filters.limit));
  }

  const queryString = params.toString();
  const path = queryString ? `/errors?${queryString}` : "/errors";

  return useQuery({
    queryKey: queryKeys.errors,
    queryFn: async () => {
      const response = await apiFetch<ErrorListResponse>(path);
      return response.errors;
    },
    staleTime: 10_000,
  });
}
