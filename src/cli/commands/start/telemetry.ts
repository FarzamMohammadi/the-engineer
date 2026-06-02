/**
 * Start-command telemetry helpers: a non-blocking reachability probe and the
 * OS-aware install pointer printed when the backend is absent. The trace UI URL it
 * reports is the configured `telemetry.ui_base`, threaded in by the caller.
 *
 * Scope: this is the START-OUTPUT surface only — it decides what the user is TOLD
 * about telemetry at boot (a clickable trace UI URL when the backend answers, or a
 * friendly "here's how to install it" otherwise). The exporter itself is wired in
 * bootstrap and is best-effort regardless of this probe; the probe NEVER gates
 * export and NEVER blocks startup (short timeout, total-catch).
 */

/** Official Jaeger v2 download page, used for the non-macOS install command. */
const JAEGER_DOWNLOAD_URL = "https://www.jaegertracing.io/download/";

/** How long the reachability probe waits before giving up. Kept short so a slow or
 * absent backend never delays "The Engineer is ready". */
const PROBE_TIMEOUT_MS = 1_000;

/** A `fetch`-shaped function (the global in prod, a fake in tests). */
export type ProbeFetch = (url: string, init: RequestInit) => Promise<{ ok: boolean }>;

/**
 * Best-effort reachability probe against the configured OTLP endpoint (the URL
 * passed in — local by default, but a remote endpoint is probed there, not at
 * localhost). Returns true only on a response (any HTTP status counts — a live
 * backend that 405s a bare GET is still "there"); false on timeout, connection
 * refused, or any thrown error. NEVER throws and NEVER blocks longer than
 * {@link PROBE_TIMEOUT_MS}.
 */
export async function probeEndpointReachable(
  endpoint: string,
  fetchFn: ProbeFetch = (url, init) => globalThis.fetch(url, init),
): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    await fetchFn(endpoint, { method: "GET", signal: controller.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * OS-aware command to get a local Jaeger v2 trace backend running. macOS has a
 * Homebrew formula; other platforms download the single binary (run as `./jaeger`
 * on Linux, `jaeger.exe` on Windows). Single-sourced so the wizard's "how to
 * enable" hint and the runtime "backend unreachable" pointer never drift.
 */
export function traceInstallCommand(platform: NodeJS.Platform = process.platform): string {
  if (platform === "darwin") {
    return "brew install jaeger && jaeger";
  }
  if (platform === "win32") {
    return `download Jaeger v2 from ${JAEGER_DOWNLOAD_URL} and run jaeger.exe`;
  }
  return `download Jaeger v2 from ${JAEGER_DOWNLOAD_URL} and run ./jaeger`;
}

/**
 * Runtime pointer shown at startup (and as the `doctor` remedy) when telemetry is
 * on but no backend answered the probe — states the situation plus the OS-aware
 * fix. Best-effort: a missing backend warns, it never blocks startup or a task.
 */
export function traceInstallPointer(platform: NodeJS.Platform = process.platform): string {
  return `Telemetry is on, but no trace backend is reachable. Install one: ${traceInstallCommand(platform)}`;
}
