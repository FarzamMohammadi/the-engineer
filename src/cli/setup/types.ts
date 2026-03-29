import type { AdapterType } from "../../schemas/adapters.js";

// ── Detection ────────────────────────────────────────────────────────────────

export interface DetectionResult {
  /** Binary name → resolved path or null if not found. */
  binaries: Record<string, string | null>;
  /** Env var names that are present AND non-empty. */
  envVars: Set<string>;
  /** Detected git remote (origin), or null. */
  gitRemote: { owner: string; name: string } | null;
}

// ── Adapter Type Config ──────────────────────────────────────────────────────

export interface AdapterTypeConfig {
  type: AdapterType;
  label: string;
  selectionMode: "single" | "multi";
  setupOrder: number;
  required: boolean;
}

// ── Setup Result ─────────────────────────────────────────────────────────────

export interface PersonSetupEntry {
  id: string;
  name: string;
  roles: string[];
  contacts: Array<{ channel: string; handle: string }>;
}

export interface GuidedSetupResult {
  selectedPlugins: string[];
  pluginConfigs: Record<string, Record<string, unknown>>;
  secrets: Record<string, string>;
  people: PersonSetupEntry[];
}
