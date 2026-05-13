/** Client-side route paths and path-builder functions for the dashboard SPA. */
export const ROUTES = {
  overview: "/",
  tasks: "/tasks",
  taskDetail: (taskId: string): string => `/tasks/${taskId}`,
  taskTimeline: (taskId: string): string => `/tasks/${taskId}/timeline`,
  taskPhases: (taskId: string): string => `/tasks/${taskId}/phases`,
  taskLlm: (taskId: string): string => `/tasks/${taskId}/llm`,
  taskTools: (taskId: string): string => `/tasks/${taskId}/tools`,
  activity: "/activity",
  metrics: "/metrics",
  errors: "/errors",
} as const;
