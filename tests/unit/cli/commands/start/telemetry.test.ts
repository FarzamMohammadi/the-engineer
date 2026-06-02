/**
 * Unit tests for the start-command telemetry helpers: the reachability probe and
 * the OS-aware install pointer. These are the load-bearing pieces of the start
 * output — a reachable backend yields the trace UI URL (configured via
 * `telemetry.ui_base`, asserted in the config schema test), an absent one yields a
 * friendly, platform-correct install pointer. The probe must never throw and never
 * block beyond its short timeout.
 */

import { describe, expect, it, vi } from "vitest";

import {
  type ProbeFetch,
  probeEndpointReachable,
  traceInstallCommand,
  traceInstallPointer,
} from "../../../../../src/cli/commands/start/telemetry.js";

describe("probeEndpointReachable", () => {
  it("returns true when the endpoint answers (any response counts)", async () => {
    const fetchFn: ProbeFetch = vi.fn().mockResolvedValue({ ok: false });
    await expect(probeEndpointReachable("http://localhost:4318", fetchFn)).resolves.toBe(true);
    expect(fetchFn).toHaveBeenCalledWith(
      "http://localhost:4318",
      expect.objectContaining({ method: "GET", signal: expect.any(AbortSignal) }),
    );
  });

  it("returns false when the connection is refused (backend absent)", async () => {
    const fetchFn: ProbeFetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(probeEndpointReachable("http://localhost:4318", fetchFn)).resolves.toBe(false);
  });

  it("returns false (never throws) when fetch rejects for any reason", async () => {
    const fetchFn: ProbeFetch = vi.fn().mockRejectedValue(new Error("aborted"));
    await expect(probeEndpointReachable("http://localhost:9999", fetchFn)).resolves.toBe(false);
  });
});

describe("traceInstallPointer", () => {
  it("gives the brew one-liner on macOS", () => {
    const pointer = traceInstallPointer("darwin");
    expect(pointer).toContain("brew install jaeger && jaeger");
    expect(pointer).not.toContain("jaegertracing.io/download");
  });

  it("gives the official download link on Linux", () => {
    const pointer = traceInstallPointer("linux");
    expect(pointer).toContain("https://www.jaegertracing.io/download/");
    expect(pointer).not.toContain("brew install");
  });

  it("gives the official download link on Windows (non-macOS fallback)", () => {
    const pointer = traceInstallPointer("win32");
    expect(pointer).toContain("https://www.jaegertracing.io/download/");
  });

  it("states that telemetry is on but no backend is reachable", () => {
    expect(traceInstallPointer("darwin")).toContain("no trace backend is reachable");
    expect(traceInstallPointer("linux")).toContain("no trace backend is reachable");
  });
});

describe("traceInstallCommand", () => {
  it("gives the brew one-liner on macOS", () => {
    expect(traceInstallCommand("darwin")).toBe("brew install jaeger && jaeger");
  });

  it("downloads and runs ./jaeger on Linux", () => {
    const cmd = traceInstallCommand("linux");
    expect(cmd).toContain("https://www.jaegertracing.io/download/");
    expect(cmd).toContain("./jaeger");
    expect(cmd).not.toContain("brew");
  });

  it("downloads and runs jaeger.exe on Windows", () => {
    const cmd = traceInstallCommand("win32");
    expect(cmd).toContain("https://www.jaegertracing.io/download/");
    expect(cmd).toContain("jaeger.exe");
  });
});
