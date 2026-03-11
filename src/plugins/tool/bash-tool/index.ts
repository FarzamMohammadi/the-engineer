import type { ToolAdapter } from "../../../adapters/index.js";
import { BashToolPlugin } from "./bash-tool.js";

export function createPlugin(): ToolAdapter {
  return new BashToolPlugin();
}
