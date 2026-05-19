// ── Types ────────────────────────────────────────────────────────────────────

export type OperatingSystemSupport = "full" | "preview" | "unsupported";

export interface OperatingSystemInfo {
  /** Raw Node.js platform value (e.g., "darwin", "linux", "win32"). */
  platform: NodeJS.Platform;
  /** Human-friendly label (e.g., "macOS", "Linux", "Windows"). */
  label: string;
  /** Support classification for the gate logic. */
  support: OperatingSystemSupport;
  /** One-line message shown to the user during setup. */
  message: string;
}

// ── Constants ────────────────────────────────────────────────────────────────

const PLATFORM_LABELS: Partial<Record<NodeJS.Platform, string>> = {
  darwin: "macOS",
  linux: "Linux",
  win32: "Windows",
};

// ── Pure Function ────────────────────────────────────────────────────────────

/** Classify the host operating system for setup gating. */
export function detectOperatingSystem(platform: NodeJS.Platform): OperatingSystemInfo {
  const label = PLATFORM_LABELS[platform] ?? platform;

  if (platform === "darwin") {
    return {
      platform,
      label,
      support: "full",
      message: `Detected: ${label} — fully supported`,
    };
  }

  if (platform === "linux") {
    return {
      platform,
      label,
      support: "preview",
      message: `Detected: ${label} — highly compatible, not yet thoroughly tested`,
    };
  }

  return {
    platform,
    label,
    support: "unsupported",
    message: `Detected: ${label} — not natively supported. Built-in plugins were developed and tested on macOS and Linux`,
  };
}
