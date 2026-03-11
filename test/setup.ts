import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach } from "vitest";

// Isolated test home — prevents tests from touching real ~/.engineer/
const testHome = path.join(os.tmpdir(), `engineer-test-${Date.now()}`);
process.env["ENGINEER_HOME"] = testHome;

// TODO (Phase 6): Initialize shared test registry with fake plugins
// const DEFAULT_REGISTRY = createTestRegistry([
//   { type: "trigger", plugin: new FakeTriggerPlugin() },
//   { type: "communication", plugin: new FakeCommunicationPlugin() },
//   { type: "llm", plugin: new FakeLLMPlugin() },
//   { type: "tool", plugin: new FakeToolPlugin() },
//   { type: "git-hosting", plugin: new FakeGitHostingPlugin() },
// ]);
// beforeAll(() => setActiveRegistry(DEFAULT_REGISTRY));

// Cleanup guard: restore registry and timers after each test
afterEach(() => {
  // TODO (Phase 6): Restore registry if overridden
  // if (getActiveRegistry() !== DEFAULT_REGISTRY) {
  //   setActiveRegistry(DEFAULT_REGISTRY);
  // }
});

// Clean up test home directory after all tests complete
afterAll(() => {
  fs.rmSync(testHome, { recursive: true, force: true });
});
