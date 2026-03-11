import type { GitHostingAdapter } from "../../../adapters/index.js";
import { GitHubHostingPlugin } from "./github-hosting.js";

export function createPlugin(): GitHostingAdapter {
  return new GitHubHostingPlugin();
}
