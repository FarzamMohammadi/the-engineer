import type { AdapterType } from "../../schemas/adapters.js";

// ── Detection ────────────────────────────────────────────────────────────────

/** Outcome of probing the host environment for binaries, env vars, and git context. */
export interface DetectionResult {
  /** Binary name → resolved path or null if not found. */
  binaries: Record<string, string | null>;
  /** Env var names that are present AND non-empty. */
  envVars: Set<string>;
  /** Detected git remote (origin), or null. */
  gitRemote: { owner: string; name: string } | null;
}

// ── Adapter Type Config ──────────────────────────────────────────────────────

/** How the guided setup prompts the user for one adapter slot (LLM, trigger, etc.). */
export interface AdapterTypeConfig {
  type: AdapterType;
  label: string;
  selectionMode: "single" | "multi";
  setupOrder: number;
  required: boolean;
}

// ── Setup Result ─────────────────────────────────────────────────────────────

/** A single person captured during guided setup, destined for the People Directory. */
export interface PersonSetupEntry {
  id: string;
  name: string;
  roles: string[];
  contacts: Array<{ channel: string; handle: string }>;
}

/** Final output of the guided setup flow — selected plugins, configs, secrets, and people. */
export interface GuidedSetupResult {
  selectedPlugins: string[];
  pluginConfigs: Record<string, Record<string, unknown>>;
  secrets: Record<string, string>;
  people: PersonSetupEntry[];
}
