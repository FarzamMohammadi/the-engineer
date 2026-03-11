import { z } from "zod";
import { MergeStrategySchema } from "../../../schemas/adapters.js";

export const GitHubHostingConfigSchema = z.object({
  github_token: z.string().min(1),
  default_merge_strategy: MergeStrategySchema.default("squash"),
});

export type GitHubHostingConfig = z.output<typeof GitHubHostingConfigSchema>;
