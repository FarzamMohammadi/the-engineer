import { z } from "zod";

export const GitHubCommConfigSchema = z.object({
  github_token: z.string().min(1),
  label_prefix: z.string().default("engineer:"),
});

export type GitHubCommConfig = z.output<typeof GitHubCommConfigSchema>;
