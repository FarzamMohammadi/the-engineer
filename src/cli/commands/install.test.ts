import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runInstall } from "./install.js";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "install-test-"));
  // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op to suppress console in tests
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("runInstall", () => {
  it("generates launchd plist on macOS", () => {
    // This test only validates the content generation, not the file write location
    // since we can't mock process.platform easily
    if (process.platform !== "darwin") {
      return;
    }
    const code = runInstall(tempDir);
    expect(code).toBe(0);
  });

  it("generates systemd unit on Linux", () => {
    if (process.platform !== "linux") {
      return;
    }
    const code = runInstall(tempDir);
    expect(code).toBe(0);
  });
});
