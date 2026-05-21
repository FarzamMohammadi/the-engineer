import type { PluginContext, StateStore } from "../../src/adapters/base.js";
import { createTestObserverFacade } from "./test-observer-facade.js";
import { createTestStateStoreFactory } from "./test-state-store.js";

/**
 * Build the PluginContext the Registry injects before `initialize()`.
 *
 * Tests that construct a plugin directly (bypassing the Registry) must set
 * `plugin.context` themselves — exactly as they already set `plugin.manifest`.
 *
 * Pass a shared `stateStore` to model a restart: two plugin instances backed
 * by the same store, as they would be by the same database across runs.
 */
export function createTestPluginContext(pluginId = "test-plugin", stateStore?: StateStore): PluginContext {
  return {
    logger: createTestObserverFacade("registry").childPlugin(pluginId),
    stateStore: stateStore ?? createTestStateStoreFactory()(pluginId),
  };
}
