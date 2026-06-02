import type { AdapterType } from "../../schemas/adapters.js";

// ── Detection ────────────────────────────────────────────────────────────────

/** Outcome of probing the host environment for binaries, env vars, and git context. */
export interface DetectionResult {
  /** Binary name → resolved path or null if not found. */
  readonly binaries: Record<string, string | null>;
  /** Env var names that are present AND non-empty. */
  readonly envVars: Set<string>;
  /** Detected git remote (origin), or null. */
  readonly gitRemote: { readonly owner: string; readonly name: string } | null;
}

// ── Adapter Type Config ──────────────────────────────────────────────────────

/** How the guided setup prompts the user for one adapter slot (agent, trigger, etc.). */
export interface AdapterTypeConfig {
  readonly type: AdapterType;
  readonly label: string;
  readonly selectionMode: "single" | "multi";
  readonly setupOrder: number;
  readonly required: boolean;
}

// ── Setup Result ─────────────────────────────────────────────────────────────

/** A single person captured during guided setup, destined for the People Directory. */
export interface PersonSetupEntry {
  readonly id: string;
  readonly name: string;
  readonly roles: string[];
  readonly contacts: Array<{ readonly channel: string; readonly handle: string }>;
}

/** Final output of the guided setup flow — selected plugins, configs, secrets, people, and opt-ins. */
export interface GuidedSetupResult {
  readonly selectedPlugins: string[];
  readonly pluginConfigs: Record<string, Record<string, unknown>>;
  readonly secrets: Record<string, string>;
  readonly people: PersonSetupEntry[];
  /** Whether the user opted into live trace visualization — writes `telemetry.enabled: true` to daemon.yaml. */
  readonly enableTelemetry: boolean;
}
