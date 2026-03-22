import { PluginManifestSchema } from "../../../../src/schemas/adapters.js";
import { runToolContractSuite } from "../../contract-suites/tool-contract.js";
import { FakeToolPlugin } from "./index.js";

const manifest = PluginManifestSchema.parse({
  id: "fake-tool",
  type: "tool",
  version: "1.0.0",
  name: "Fake Tool Plugin",
  description: "Test tool plugin",
  adapter_meta: { action_classes: ["read", "write"] },
});

runToolContractSuite(() => new FakeToolPlugin(), {
  validConfig: {},
  // biome-ignore lint/style/useNamingConvention: sentinel config key
  invalidConfig: { _force_fail: true },
  manifest,
  action: "read",
  params: { command: "echo test" },
  context: { workspace_path: "/tmp/test-workspace", task_id: "test-task-001" },
});
