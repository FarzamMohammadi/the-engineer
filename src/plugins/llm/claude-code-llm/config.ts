import { z } from "zod";

export const ClaudeCodeLLMConfigSchema = z.object({
  model: z.string().default("claude-sonnet-4-20250514"),
  max_tokens: z.number().int().positive().default(16_384),
  cli_path: z.string().default("claude"),
  command_timeout_ms: z.number().int().positive().default(600_000), // 10 min
});

export type ClaudeCodeLLMConfig = z.output<typeof ClaudeCodeLLMConfigSchema>;
