import { PluginManifestSchema } from "../../../../src/schemas/adapters.js";
import { runContractSuite } from "../../contract-suites/agent-contract.js";
import { createMockAgentRunRequest } from "../../mock-factories.js";
import { FakeAgentPlugin } from "./index.js";

const manifest = PluginManifestSchema.parse({
  id: "fake-agent",
  type: "agent",
  version: "1.0.0",
  name: "Fake LLM Plugin",
  description: "Test agent plugin",
  adapter_meta: { provider_type: "cli" },
});

runContractSuite(() => new FakeAgentPlugin(), {
  validConfig: {},
  invalidConfig: { _force_fail: true },
  manifest,
  request: createMockAgentRunRequest(),
});
