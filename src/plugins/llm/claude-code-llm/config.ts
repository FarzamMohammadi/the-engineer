import { z } from "zod";

export const ClaudeCodeLLMConfigSchema = z.object({
  model: z.string().default("claude-opus-4-6"),
  max_tokens: z.number().int().positive().default(16_384),
  cli_path: z.string().default("claude"),
  command_timeout_ms: z.number().int().positive().default(7_200_000), // 2 hours
  /** Maximum bytes of stdout before killing the CLI process. Prevents memory blowups. */
  max_cli_output_bytes: z.number().int().positive().default(500_000_000), // 500 MB
});

export type ClaudeCodeLLMConfig = z.output<typeof ClaudeCodeLLMConfigSchema>;
