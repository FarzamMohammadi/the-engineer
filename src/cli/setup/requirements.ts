import type { PluginRequirement } from "../../schemas/adapters.js";
import type { DetectionResult } from "./types.js";

/**
 * Check whether all of a plugin's requirements are satisfied by the detection result.
 * A requirement is met when its binary was found on PATH or its env var is set.
 * Unknown requirement types are skipped gracefully (forward-compatibility).
 */
export function checkRequirementsMet(
  plugin: { requirements: readonly PluginRequirement[] },
  detection: DetectionResult,
): boolean {
  for (const req of plugin.requirements) {
    if (req.type === "binary") {
      if (!detection.binaries[req.name]) {
        return false;
      }
    } else if (req.type === "env") {
      if (!detection.envVars.has(req.name)) {
        return false;
      }
    }
  }
  return true;
}
