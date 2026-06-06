import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createOutput, resetOutput } from "../../../../../src/cli/output.js";
import * as setup from "../../../../../src/cli/setup/setup.js";

// runStart imports runFirstTimeSetup/needsSetup from this module; mock so first-run
// setup is the only path exercised — the exit-code decision returns before any daemon bootstrap.
vi.mock("../../../../../src/cli/setup/setup.js", async (importOriginal) => {
  const actual = await importOriginal<typeof setup>();
  return { ...actual, needsSetup: vi.fn(), runFirstTimeSetup: vi.fn() };
});

let tempHome: string;
let originalIsTty: boolean | undefined;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), "first-run-setup-test-"));
  originalIsTty = process.stdin.isTTY;
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  createOutput({ mode: "human", color: false });
  vi.mocked(setup.needsSetup).mockReturnValue(true);
});

afterEach(() => {
  rmSync(tempHome, { recursive: true, force: true });
  Object.defineProperty(process.stdin, "isTTY", { value: originalIsTty, configurable: true });
  vi.restoreAllMocks();
  resetOutput();
});

describe("runStart first-run setup exit code", () => {
  it("returns non-zero when a seeded setup does not complete", async () => {
    // Seed mode: `runFirstTimeSetup` returns false because setup was incomplete
    // (e.g. missing required secrets), not because a human cancelled.
    vi.mocked(setup.runFirstTimeSetup).mockResolvedValue(false);
    const { runStart } = await import("../../../../../src/cli/commands/start/start.js");

    const code = await runStart(tempHome, {
      daemon: false,
      verbose: false,
      dryRun: false,
      seedPath: join(tempHome, "seed"),
    });

    expect(code).toBe(1);
  });

  it("returns zero when an interactive setup is cancelled by the user", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    vi.mocked(setup.runFirstTimeSetup).mockResolvedValue(false);
    const { runStart } = await import("../../../../../src/cli/commands/start/start.js");

    const code = await runStart(tempHome, {
      daemon: false,
      verbose: false,
      dryRun: false,
      seedPath: undefined,
    });

    expect(code).toBe(0);
  });
});
