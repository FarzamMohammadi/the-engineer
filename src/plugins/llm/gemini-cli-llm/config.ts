import { z } from "zod";

export const GeminiCliLLMConfigSchema = z.object({
  model: z.string().default("gemini-2.5-pro"),
  cli_path: z.string().default("gemini"),
  command_timeout_ms: z.number().int().positive().default(600_000), // 10 min
});

export type GeminiCliLLMConfig = z.output<typeof GeminiCliLLMConfigSchema>;
