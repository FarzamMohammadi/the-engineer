import type { StateStore } from "../../src/adapters/base.js";

/**
 * In-memory StateStore factory for tests — namespaced per plugin id,
 * honoring the same isolation guarantee as the real DB-backed store.
 */
export function createTestStateStoreFactory(): (pluginId: string) => StateStore {
  const namespaces = new Map<string, Map<string, unknown>>();

  return (pluginId: string): StateStore => {
    let store = namespaces.get(pluginId);
    if (!store) {
      store = new Map<string, unknown>();
      namespaces.set(pluginId, store);
    }
    const keyed = store;
    return {
      get: (key) => keyed.get(key) ?? null,
      set: (key, value) => {
        keyed.set(key, value);
      },
      delete: (key) => {
        keyed.delete(key);
      },
    };
  };
}
