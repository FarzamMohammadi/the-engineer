import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach } from "vitest";

// Isolated test home — prevents tests from touching real ~/.engineer/
const testHome = path.join(os.tmpdir(), `engineer-test-${Date.now()}`);
process.env["ENGINEER_HOME"] = testHome;

// Cleanup guard: restore registry and timers after each test
afterEach(() => {});

// Clean up test home directory after all tests complete
afterAll(() => {
  fs.rmSync(testHome, { recursive: true, force: true });
});
