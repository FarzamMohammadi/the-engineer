import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";

import { KILL_GRACE_MS, killProcess } from "../../../src/utils/process.js";

describe("killProcess", () => {
  it("sends SIGTERM immediately", () => {
    const child = spawn("sleep", ["60"]);
    const killSpy = vi.spyOn(child, "kill");

    killProcess(child);

    expect(killSpy).toHaveBeenCalledWith("SIGTERM");
    // Clean up
    child.kill("SIGKILL");
  });

  it("terminates a normally-responsive process via SIGTERM", () =>
    new Promise<void>((resolve) => {
      const child = spawn("sleep", ["60"]);

      killProcess(child);

      child.on("close", (_code, signal) => {
        expect(signal).toBe("SIGTERM");
        resolve();
      });
    }));

  it("does not throw when called on an already-dead process", () =>
    new Promise<void>((resolve) => {
      const child = spawn("true", []);

      child.on("close", () => {
        // Process is already dead — killProcess should not throw
        expect(() => killProcess(child)).not.toThrow();
        resolve();
      });
    }));

  it("sends SIGKILL after grace period when exitCode is still null", () => {
    const fakeChild = {
      kill: vi.fn(),
      exitCode: null,
      killed: true, // killed is true (signal sent) but exitCode is null (still running)
    } as unknown as ChildProcess;

    vi.useFakeTimers();
    killProcess(fakeChild);

    expect(fakeChild.kill).toHaveBeenCalledWith("SIGTERM");

    // Advance past grace period — exitCode is still null, so SIGKILL fires
    vi.advanceTimersByTime(KILL_GRACE_MS);
    expect(fakeChild.kill).toHaveBeenCalledWith("SIGKILL");
    expect(fakeChild.kill).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  it("skips SIGKILL when process exits before grace period", () => {
    const fakeChild = {
      kill: vi.fn(),
      exitCode: null,
      killed: false,
    } as unknown as ChildProcess;

    vi.useFakeTimers();
    killProcess(fakeChild);

    expect(fakeChild.kill).toHaveBeenCalledWith("SIGTERM");

    // Simulate process exit before grace period
    (fakeChild as { exitCode: number | null }).exitCode = 0;

    vi.advanceTimersByTime(KILL_GRACE_MS);
    expect(fakeChild.kill).not.toHaveBeenCalledWith("SIGKILL");
    expect(fakeChild.kill).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });

  it("exports KILL_GRACE_MS as 5000", () => {
    expect(KILL_GRACE_MS).toBe(5000);
  });
});
