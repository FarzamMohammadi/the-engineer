/**
 * Test helper for the unified Observer facade — silent pino, no observation store.
 */
import { type ComponentTag, Observer, createSilentLogger } from "../../src/core/observer/index.js";

/** Create a test Observer with silent pino and no observation store. */
export function createTestObserverFacade(component: ComponentTag = "cli"): Observer {
  return new Observer({ rootPino: createSilentLogger().logger, store: null }, component);
}
