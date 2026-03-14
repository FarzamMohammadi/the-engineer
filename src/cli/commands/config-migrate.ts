import { CURRENT_CONFIG_VERSION } from "../../schemas/config.js";

/**
 * Run config migration. Currently only version 1 exists, so this is
 * infrastructure-only — no actual migrations to apply yet.
 *
 * Future migrations will be registered as functions that transform
 * config from version N to N+1.
 */
export function runConfigMigrate(_engineerHome: string): number {
  console.log(
    `All configuration files are at the current version (${String(CURRENT_CONFIG_VERSION)}). No migrations needed.`,
  );
  return 0;
}
