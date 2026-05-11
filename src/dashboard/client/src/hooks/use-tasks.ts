import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../lib/api-client";
import { STALE_TIMES } from "../lib/constants";
import { queryKeys } from "../lib/query-keys";
import type { TaskDetailResponse, TaskListItem, TaskListResponse } from "../types/api";

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

export function useTaskDetail(taskId: string | undefined): ReturnType<typeof useQuery> {
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
