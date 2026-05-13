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

export function useTaskList(state?: string): ReturnType<typeof useQuery<TaskListItem[]>> {
  const params = state ? `?state=${state}` : "";
  return useQuery({
    queryKey: queryKeys.tasks.list(state),
    queryFn: async () => {
      const res = await apiFetch<TaskListResponse>(`/tasks${params}`);
      return res.tasks;
    },
    staleTime: STALE_TIMES.taskList,
  });
}

export function useTaskDetail(taskId: string | undefined): ReturnType<typeof useQuery<TaskDetail>> {
  return useQuery({
    queryKey: queryKeys.tasks.detail(taskId ?? ""),
    queryFn: async () => {
      const res = await apiFetch<TaskDetailResponse>(`/tasks/${taskId}`);
      return res.task;
    },
    enabled: !!taskId,
    staleTime: STALE_TIMES.taskDetail,
  });
}

export function useTaskTimeline(taskId: string | undefined): ReturnType<typeof useQuery<TimelineItem[]>> {
  return useQuery({
    queryKey: queryKeys.tasks.timeline(taskId ?? ""),
    queryFn: async () => {
      const res = await apiFetch<TimelineResponse>(`/tasks/${taskId}/timeline`);
      return res.timeline;
    },
    enabled: !!taskId,
    staleTime: STALE_TIMES.taskDetail,
  });
}

export function useTaskPhases(taskId: string | undefined): ReturnType<typeof useQuery<Observation[]>> {
  return useQuery({
    queryKey: queryKeys.tasks.phases(taskId ?? ""),
    queryFn: async () => {
      const res = await apiFetch<{ phases: Observation[] }>(`/tasks/${taskId}/phases`);
      return res.phases;
    },
    enabled: !!taskId,
    staleTime: STALE_TIMES.taskDetail,
  });
}

export function useTaskLlmTraces(taskId: string | undefined): ReturnType<typeof useQuery<Observation[]>> {
  return useQuery({
    queryKey: queryKeys.tasks.llmTraces(taskId ?? ""),
    queryFn: async () => {
      const res = await apiFetch<{ traces: Observation[] }>(`/tasks/${taskId}/llm-traces`);
      return res.traces;
    },
    enabled: !!taskId,
    staleTime: STALE_TIMES.taskDetail,
  });
}

export function useTaskToolTraces(taskId: string | undefined): ReturnType<typeof useQuery<Observation[]>> {
  return useQuery({
    queryKey: queryKeys.tasks.traces(taskId ?? ""),
    queryFn: async () => {
      const res = await apiFetch<{ traces: Observation[] }>(`/tasks/${taskId}/traces`);
      return res.traces;
    },
    enabled: !!taskId,
    staleTime: STALE_TIMES.taskDetail,
  });
}

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
