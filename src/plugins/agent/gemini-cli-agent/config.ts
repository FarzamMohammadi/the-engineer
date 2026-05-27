import { z } from "zod";

export const GeminiCliAgentConfigSchema = z.object({
  model: z.string().default("gemini-2.5-pro"),
  cli_path: z.string().default("gemini"),
  command_timeout_ms: z.number().int().positive().default(600_000), // 10 min
  /** Maximum bytes of stdout before killing the CLI process. Prevents memory blowups. */
  max_cli_output_bytes: z.number().int().positive().default(500_000_000), // 500 MB
});

export type GeminiCliAgentConfig = z.output<typeof GeminiCliAgentConfigSchema>;
