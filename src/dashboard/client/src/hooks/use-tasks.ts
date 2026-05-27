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

/** Fetch and cache agent call traces for a task from /api/tasks/:id/agent-traces. */
export function useTaskAgentTraces(taskId: string | undefined): ReturnType<typeof useQuery<Observation[]>> {
  return useQuery({
    queryKey: queryKeys.tasks.agentTraces(taskId ?? ""),
    queryFn: async () => {
      const response = await apiFetch<{ traces: Observation[] }>(`/tasks/${taskId}/agent-traces`);
      return response.traces;
    },
    enabled: !!taskId,
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
