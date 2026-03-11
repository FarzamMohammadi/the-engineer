import type { CommunicationAdapter } from "../../../adapters/index.js";
import { GitHubCommPlugin } from "./github-comm.js";

export function createPlugin(): CommunicationAdapter {
  return new GitHubCommPlugin();
}
