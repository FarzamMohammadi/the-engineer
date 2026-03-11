import { z } from "zod";

export const GitHubTriggerConfigSchema = z.object({
  github_token: z.string().min(1),
  repos: z
    .array(
      z.object({
        owner: z.string().min(1),
        name: z.string().min(1),
      }),
    )
    .min(1),
  labels: z.array(z.string()).default([]),
  poll_interval_ms: z.number().int().positive().default(30_000),
});

export type GitHubTriggerConfig = z.output<typeof GitHubTriggerConfigSchema>;
