import { Observer } from "../../src/core/observer/facade.js";
/**
 * Test helper for the unified Observer facade — silent pino, no observation store.
 */
import { createSilentLogger } from "../../src/core/observer/logging.js";
import type { ComponentTag } from "../../src/core/observer/logging.js";

/** Create a test Observer with silent pino and no observation store. */
export function createTestObserverFacade(component: ComponentTag = "cli"): Observer {
  return new Observer({ rootPino: createSilentLogger().logger, store: null }, component);
}
