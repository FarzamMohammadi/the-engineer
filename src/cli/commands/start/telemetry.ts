/**
 * Start-command telemetry helpers: the trace UI URL, a non-blocking reachability
 * probe, and the OS-aware install pointer printed when the backend is absent.
 *
 * Scope: this is the START-OUTPUT surface only — it decides what the user is TOLD
 * about telemetry at boot (a clickable trace UI URL when the backend answers, or a
 * friendly "here's how to install it" otherwise). The exporter itself is wired in
 * bootstrap and is best-effort regardless of this probe; the probe NEVER gates
 * export and NEVER blocks startup (short timeout, total-catch).
 */

import { detectOperatingSystem } from "../../setup/os-detection.js";

/**
 * The Jaeger v2 web UI port. The OTLP receiver (config `telemetry.endpoint`,
 * default :4318) and the UI are distinct ports on the same host; we report the UI
 * so the user lands on the flame graph, not the ingest endpoint.
 */
export const TRACE_UI_URL = "http://localhost:16686";

/** Official download page, shown to non-macOS users who have no `brew` one-liner. */
const JAEGER_DOWNLOAD_URL = "https://www.jaegertracing.io/download/";

/** How long the reachability probe waits before giving up. Kept short so a slow or
 * absent backend never delays "The Engineer is ready". */
const PROBE_TIMEOUT_MS = 1_000;

/** A `fetch`-shaped function (the global in prod, a fake in tests). */
export type ProbeFetch = (url: string, init: RequestInit) => Promise<{ ok: boolean }>;

/**
 * Best-effort reachability probe against the OTLP endpoint. Returns true only on a
 * response (any HTTP status counts — a live backend that 405s a bare GET is still
 * "there"); false on timeout, connection refused, or any thrown error. NEVER throws
 * and NEVER blocks longer than {@link PROBE_TIMEOUT_MS}.
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
 * OS-aware install pointer for when the backend is unreachable. macOS gets the
 * `brew` one-liner; every other platform gets the official download link. Reuses
 * the setup OS detection so the classification stays single-sourced.
 */
export function traceInstallPointer(platform: NodeJS.Platform = process.platform): string {
  const os = detectOperatingSystem(platform);
  if (os.platform === "darwin") {
    return "Telemetry is on, but no trace backend is reachable. Install one: brew install jaeger && jaeger";
  }
  return `Telemetry is on, but no trace backend is reachable. Install Jaeger v2: ${JAEGER_DOWNLOAD_URL}`;
}
