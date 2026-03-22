import { PluginManifestSchema } from "../../../../src/schemas/adapters.js";
import { runTriggerContractSuite } from "../../contract-suites/trigger-contract.js";
import { createMockTriggerEvent } from "../../mock-factories.js";
import { FakeTriggerPlugin } from "./index.js";

const manifest = PluginManifestSchema.parse({
  id: "fake-trigger",
  type: "trigger",
  version: "1.0.0",
  name: "Fake Trigger Plugin",
  description: "Test trigger plugin",
  adapter_meta: { poll_interval: "5s" },
});

runTriggerContractSuite(
  () => {
    const plugin = new FakeTriggerPlugin();
    plugin.setEvents([createMockTriggerEvent()]);
    return plugin;
  },
  {
    validConfig: {},
    invalidConfig: { _force_fail: true },
    manifest,
  },
);
