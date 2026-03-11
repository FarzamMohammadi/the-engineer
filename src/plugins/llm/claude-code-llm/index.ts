import type { LLMAdapter } from "../../../adapters/index.js";
import { ClaudeCodeLLMPlugin } from "./claude-code-llm.js";

export function createPlugin(): LLMAdapter {
  return new ClaudeCodeLLMPlugin();
}
