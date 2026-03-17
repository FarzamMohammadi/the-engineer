import type { BaseAdapter } from "../../adapters/base.js";
import type { AdapterType } from "../../schemas/adapters.js";

/**
 * Read-only plugin lookup contract.
 *
 * Consumers that only need to find plugins (Daemon subsystems, Orchestrator
 * subsystems) depend on this narrow interface instead of the full Registry.
 * Lifecycle methods (register, deregister, shutdownAll) stay on the concrete
 * Registry class — only bootstrap touches those.
 */
export interface IPluginLookup {
  getPlugin<T extends BaseAdapter>(type: AdapterType, id: string): T | null;
  getPluginsByType<T extends BaseAdapter>(type: AdapterType): T[];
  getPrimaryPlugin<T extends BaseAdapter>(type: AdapterType): T | null;
}
