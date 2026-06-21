import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../lib/api-client";
import { STALE_TIMES } from "../lib/constants";
import { queryKeys } from "../lib/query-keys";
import type {
  Observation,
  TaskDetail,
  TaskDetailResponse,
  TaskListItem,
  TaskListResponse,
  TimelineItem,
  TimelineResponse,
} from "../types/api";

/** Poll cadence for an actively-running task — keeps `end_time`/state fresh so live UI (the agent
 *  conversation's streaming indicator) stops on its own when a span closes, without waiting for a refresh.
 *  Exported as the single source of this cadence; the generic observations hook reuses it for its live mode. */
export const LIVE_REFETCH_MS = 2500;
const LIVE_TASK_STATES: ReadonlySet<string> = new Set(["active"]);

/** Whether a task state means work is in flight (so its detail/traces should keep polling for changes). */
function isLiveTaskState(state: string | undefined): boolean {
  return state !== undefined && LIVE_TASK_STATES.has(state);
}

/** Fetch and cache the task list from /api/tasks with an optional state filter. */
export function useTaskList(state?: string): ReturnType<typeof useQuery<TaskListItem[]>> {
  const params = state ? `?state=${state}` : "";
  return useQuery({
    queryKey: queryKeys.tasks.list(state),
    queryFn: async () => {
      const response = await apiFetch<TaskListResponse>(`/tasks${params}`);
      return response.tasks;
    },
    staleTime: STALE_TIMES.taskList,
  });
}

/** Fetch and cache a single task's full detail from /api/tasks/:id. */
export function useTaskDetail(taskId: string | undefined): ReturnType<typeof useQuery<TaskDetail>> {
  return useQuery({
    queryKey: queryKeys.tasks.detail(taskId ?? ""),
    queryFn: async () => {
      const response = await apiFetch<TaskDetailResponse>(`/tasks/${taskId}`);
      return response.task;
    },
    enabled: !!taskId,
    staleTime: STALE_TIMES.taskDetail,
    // While the task is running, keep its state fresh so `taskActive` flips the moment it finishes.
    refetchInterval: (query) => (isLiveTaskState(query.state.data?.state) ? LIVE_REFETCH_MS : false),
  });
}

/** Fetch and cache the chronological timeline entries for a task from /api/tasks/:id/timeline. */
export function useTaskTimeline(taskId: string | undefined): ReturnType<typeof useQuery<TimelineItem[]>> {
  return useQuery({
    queryKey: queryKeys.tasks.timeline(taskId ?? ""),
    queryFn: async () => {
      const response = await apiFetch<TimelineResponse>(`/tasks/${taskId}/timeline`);
      return response.timeline;
    },
    enabled: !!taskId,
    staleTime: STALE_TIMES.taskDetail,
  });
}

/** Fetch and cache RRPIR phase observations for a task from /api/tasks/:id/phases. */
export function useTaskPhases(taskId: string | undefined): ReturnType<typeof useQuery<Observation[]>> {
  return useQuery({
    queryKey: queryKeys.tasks.phases(taskId ?? ""),
    queryFn: async () => {
      const response = await apiFetch<{ phases: Observation[] }>(`/tasks/${taskId}/phases`);
      return response.phases;
    },
    enabled: !!taskId,
    staleTime: STALE_TIMES.taskDetail,
  });
}

/** Fetch and cache agent call traces for a task. While `active`, polls so a span's close (and the task's
 *  completion) are picked up promptly — the streaming indicator must stop on its own, not wait for a refresh. */
export function useTaskAgentTraces(
  taskId: string | undefined,
  active = false,
): ReturnType<typeof useQuery<Observation[]>> {
  return useQuery({
    queryKey: queryKeys.tasks.agentTraces(taskId ?? ""),
    queryFn: async () => {
      const response = await apiFetch<{ traces: Observation[] }>(`/tasks/${taskId}/agent-traces`);
      return response.traces;
    },
    enabled: !!taskId,
    staleTime: STALE_TIMES.taskDetail,
    refetchInterval: active ? LIVE_REFETCH_MS : false,
  });
}

/**
 * Fetch one agent_call's recorded conversation (its `agent_activity` children) from
 * /api/tasks/:id/agent-activity?call=:callId. Used for the retroactive re-watch of a closed call; an open
 * call streams live over SSE instead, so callers gate this with `enabled` to avoid a redundant fetch.
 */
export function useTaskAgentActivity(
  taskId: string,
  callId: string,
  enabled: boolean,
): ReturnType<typeof useQuery<Observation[]>> {
  return useQuery({
    queryKey: queryKeys.tasks.agentActivity(taskId, callId),
    queryFn: async () => {
      const response = await apiFetch<{ activities: Observation[] }>(
        `/tasks/${taskId}/agent-activity?call=${encodeURIComponent(callId)}`,
      );
      return response.activities;
    },
    enabled: enabled && !!taskId && !!callId,
    staleTime: STALE_TIMES.taskDetail,
  });
}

/** Fetch and cache tool execution traces for a task from /api/tasks/:id/traces. */
export function useTaskToolTraces(taskId: string | undefined): ReturnType<typeof useQuery<Observation[]>> {
  return useQuery({
    queryKey: queryKeys.tasks.traces(taskId ?? ""),
    queryFn: async () => {
      const response = await apiFetch<{ traces: Observation[] }>(`/tasks/${taskId}/traces`);
      return response.traces;
    },
    enabled: !!taskId,
    staleTime: STALE_TIMES.taskDetail,
  });
}

/** Send a human response to a blocked task via POST /api/messages/:id/respond and invalidate task caches. */
export function useRespondToTask(
  taskId: string,
): ReturnType<typeof useMutation<{ success: boolean; eventId: string }, Error, string>> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (content: string) =>
      apiFetch<{ success: boolean; eventId: string }>(`/messages/${taskId}/respond`, {
        method: "POST",
        body: JSON.stringify({ content }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.detail(taskId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all });
    },
  });
}

/** Cancel a running task via POST /api/tasks/:id/cancel and invalidate task caches. */
export function useCancelTask(taskId: string): ReturnType<typeof useMutation<{ success: boolean }, Error>> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<{ success: boolean }>(`/tasks/${taskId}/cancel`, {
        method: "POST",
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.detail(taskId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all });
    },
  });
}

/** Retry a failed or blocked task, or resume a cancelled one, via POST /api/tasks/:id/retry. */
export function useRetryTask(taskId: string): ReturnType<typeof useMutation<{ success: boolean }, Error>> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<{ success: boolean }>(`/tasks/${taskId}/retry`, {
        method: "POST",
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.detail(taskId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all });
    },
  });
}

/** Re-run a reaped cancelled task as a fresh clone via POST /api/tasks/:id/rerun and invalidate task caches. */
export function useRerunTask(taskId: string): ReturnType<typeof useMutation<{ success: boolean }, Error>> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<{ success: boolean }>(`/tasks/${taskId}/rerun`, {
        method: "POST",
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all });
    },
  });
}
