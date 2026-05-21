import type { PluginContext } from "../../src/adapters/base.js";
import { createTestObserverFacade } from "./test-observer-facade.js";
import { createTestStateStoreFactory } from "./test-state-store.js";

/**
 * Build the PluginContext the Registry injects before `initialize()`.
 *
 * Tests that construct a plugin directly (bypassing the Registry) must set
 * `plugin.context` themselves — exactly as they already set `plugin.manifest`.
 */
export function createTestPluginContext(pluginId = "test-plugin"): PluginContext {
  return {
    logger: createTestObserverFacade("registry").childPlugin(pluginId),
    stateStore: createTestStateStoreFactory()(pluginId),
  };
}
