import { PluginManifestSchema } from "../../../../src/schemas/adapters.js";
import { runCommunicationContractSuite } from "../../contract-suites/communication-contract.js";
import { FakeCommunicationPlugin } from "./index.js";

const manifest = PluginManifestSchema.parse({
  id: "fake-comm",
  type: "communication",
  version: "1.0.0",
  name: "Fake Communication Plugin",
  description: "Test communication plugin",
  adapter_meta: { capabilities: ["send", "receive"] },
});

runCommunicationContractSuite(() => new FakeCommunicationPlugin(), {
  validConfig: {},
  invalidConfig: { _force_fail: true },
  manifest,
  target: { user_id: "test-user", channel: null },
  message: {
    content: "Test message",
    metadata: { task_id: null, type: "notification" },
  },
});
