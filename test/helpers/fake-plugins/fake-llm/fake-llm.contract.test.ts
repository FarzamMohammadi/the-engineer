import { PluginManifestSchema } from "../../../../src/schemas/adapters.js";
import { runLLMContractSuite } from "../../contract-suites/llm-contract.js";
import { createMockInferenceRequest } from "../../mock-factories.js";
import { FakeLLMPlugin } from "./index.js";

const manifest = PluginManifestSchema.parse({
  id: "fake-llm",
  type: "llm",
  version: "1.0.0",
  name: "Fake LLM Plugin",
  description: "Test LLM plugin",
  adapter_meta: { provider_type: "cli" },
});

runLLMContractSuite(() => new FakeLLMPlugin(), {
  validConfig: {},
  // biome-ignore lint/style/useNamingConvention: sentinel config key
  invalidConfig: { _force_fail: true },
  manifest,
  request: createMockInferenceRequest(),
});
