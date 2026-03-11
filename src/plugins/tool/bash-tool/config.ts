import { z } from "zod";

export const BashToolConfigSchema = z.object({
  max_output_bytes: z.number().int().positive().default(10_485_760), // 10MB
  command_timeout_ms: z.number().int().positive().default(300_000), // 5 min
  env_passthrough: z.array(z.string()).default([]),
});

export type BashToolConfig = z.output<typeof BashToolConfigSchema>;
