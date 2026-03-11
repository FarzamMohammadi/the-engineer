import type { TriggerAdapter } from "../../../adapters/index.js";
import { GitHubTriggerPlugin } from "./github-trigger.js";

export function createPlugin(): TriggerAdapter {
  return new GitHubTriggerPlugin();
}
