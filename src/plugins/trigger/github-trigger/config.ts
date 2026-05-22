import { z } from "zod";

export const GitHubTriggerConfigSchema = z
  .object({
    github_token: z.string().min(1),
    repos: z
      .array(
        z.object({
          owner: z.string().min(1),
          name: z.string().min(1),
        }),
      )
      .min(1),
    labels: z.array(z.string()).default(["engineer"]),
    assignee: z.string().min(1).optional(),
  })
  .refine((data) => data.labels.length > 0 || data.assignee !== undefined, {
    message:
      "Work selection is empty: you set labels to [] with no assignee, which would match every open issue. Add a label or set assignee.",
  });

export type GitHubTriggerConfig = z.output<typeof GitHubTriggerConfigSchema>;
