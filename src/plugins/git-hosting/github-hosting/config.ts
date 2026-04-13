import { z } from "zod";
import { MergeStrategies, MergeStrategySchema } from "../../../schemas/adapters.js";

export const GitHubHostingConfigSchema = z.object({
  github_token: z.string().min(1),
  default_merge_strategy: MergeStrategySchema.default(MergeStrategies.squash),
});

export type GitHubHostingConfig = z.output<typeof GitHubHostingConfigSchema>;
