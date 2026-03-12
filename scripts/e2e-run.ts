/**
 * E2E test runner — runs The Engineer against a real repo.
 * Usage: source .env.test && GIT_TOKEN=$GITHUB_TOKEN npx tsx scripts/e2e-run.ts
 */
import { mkdirSync } from "node:fs";

import { bootstrap } from "../src/cli/bootstrap.js";
import { loadConfigDir } from "../src/config/loader.js";

const home = "/Users/farzammohammadi/.engineer";
mkdirSync(`${home}/data`, { recursive: true });

async function main() {
  const { bundle } = loadConfigDir(`${home}/config`);
  if (!bundle) {
    console.error("Config load failed");
    process.exit(1);
  }

  console.log("[E2E] Bootstrapping...");
  const { daemon, cleanup } = await bootstrap(home, bundle, true);

  console.log("[E2E] Starting daemon...");
  await daemon.start();
  console.log("[E2E] State:", JSON.stringify(daemon.getState()));

  console.log("[E2E] Tick 1: poll trigger...");
  await daemon.tick();
  console.log("[E2E] State after tick 1:", JSON.stringify(daemon.getState()));

  console.log("[E2E] Tick 2: schedule + dispatch...");
  await daemon.tick();
  console.log("[E2E] State after tick 2:", JSON.stringify(daemon.getState()));

  // Wait for orchestrator to finish (up to 20 min for real Claude calls)
  console.log("[E2E] Waiting for orchestrator to complete...");
  const start = Date.now();
  while (daemon.getState().activeTaskIds.length > 0) {
    await new Promise((r) => setTimeout(r, 5000));
    const elapsed = Math.round((Date.now() - start) / 1000);
    console.log(`[E2E]   ...${elapsed}s elapsed, active: ${daemon.getState().activeTaskIds}`);
    if (Date.now() - start > 1_200_000) {
      console.error("[E2E] Timeout waiting for orchestrator (20 min)");
      break;
    }
  }

  const finalState = daemon.getState();
  console.log("[E2E] Final state:", JSON.stringify(finalState));
  console.log(`[E2E] Tasks completed: ${finalState.tasksCompleted}`);

  await daemon.stop();
  cleanup();
  console.log("[E2E] Done!");
}

main().catch((e) => {
  console.error("[E2E] Fatal:", e);
  process.exit(1);
});
