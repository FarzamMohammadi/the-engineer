export const queryKeys = {
  systemStatus: ["system-status"] as const,
  tasks: {
    all: ["tasks"] as const,
    list: (state?: string) => ["tasks", "list", state ?? "all"] as const,
    detail: (taskId: string) => ["tasks", taskId] as const,
    timeline: (taskId: string) => ["tasks", taskId, "timeline"] as const,
    phases: (taskId: string) => ["tasks", taskId, "phases"] as const,
    traces: (taskId: string) => ["tasks", taskId, "traces"] as const,
    llmTraces: (taskId: string) => ["tasks", taskId, "llm-traces"] as const,
  },
  metrics: {
    cost: ["metrics-cost"] as const,
    quota: ["metrics-quota"] as const,
  },
  observations: (filters?: Record<string, string>) => ["observations", filters ?? {}] as const,
  events: (filters?: Record<string, string>) => ["events", filters ?? {}] as const,
  errors: ["errors"] as const,
} as const;
