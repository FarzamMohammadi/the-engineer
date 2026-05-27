import type { EventBus } from "../../src/core/event-bus/index.js";
import { Registry } from "../../src/core/registry/index.js";
import { AdapterTypes } from "../../src/schemas/adapters.js";
import { FakeAgentPlugin } from "./fake-plugins/fake-agent/index.js";
import { FakeCommunicationPlugin } from "./fake-plugins/fake-comm/index.js";
import { FakeGitHostingPlugin } from "./fake-plugins/fake-git-hosting/index.js";
import { FakeTriggerPlugin } from "./fake-plugins/fake-trigger/index.js";
import { createMockManifest } from "./mock-factories.js";
import { createTestObserverFacade } from "./test-observer-facade.js";
import { createTestStateStoreFactory } from "./test-state-store.js";

export interface TestRegistryFakes {
  trigger: FakeTriggerPlugin;
  communication: FakeCommunicationPlugin;
  llm: FakeAgentPlugin;
  gitHosting: FakeGitHostingPlugin;
}

export interface TestRegistryHandle {
  registry: Registry;
  fakes: TestRegistryFakes;
  cleanup(): void;
}

/**
 * Creates a Registry pre-loaded with all 4 fake plugins.
 *
 * Used by consuming phase tests (Task Engine, Safety Layer, etc.) to get
 * a working registry with controllable fake plugins.
 *
 * Plugins are registered but NOT initialized — call `initializePlugin()`
 * on individual plugins if your test needs initialized state.
 */
export function createTestRegistry(eventBus: EventBus): TestRegistryHandle {
  const registry = new Registry({
    eventBus,
    observer: createTestObserverFacade("registry"),
    createStateStore: createTestStateStoreFactory(),
    healthCheckIntervalMs: 60_000,
    healthCheckTimeoutMs: 1_000,
    consecutiveFailuresThreshold: 3,
  });

  const trigger = new FakeTriggerPlugin();
  const communication = new FakeCommunicationPlugin();
  const llm = new FakeAgentPlugin();
  const gitHosting = new FakeGitHostingPlugin();

  registry.register(
    createMockManifest({
      id: "fake-trigger",
      type: AdapterTypes.trigger,
      name: "Fake Trigger Plugin",
      description: "Test trigger plugin",
      critical: false,
      adapter_meta: { poll_interval: "5s" },
    }),
    trigger,
  );

  registry.register(
    createMockManifest({
      id: "fake-comm",
      type: AdapterTypes.communication,
      name: "Fake Communication Plugin",
      description: "Test communication plugin",
      critical: false,
      adapter_meta: { capabilities: ["send", "receive"] },
    }),
    communication,
  );

  registry.register(
    createMockManifest({
      id: "fake-agent",
      type: AdapterTypes.agent,
      name: "Fake LLM Plugin",
      description: "Test agent plugin",
      critical: false,
      adapter_meta: { provider_type: "cli" },
    }),
    llm,
  );

  registry.register(
    createMockManifest({
      id: "fake-git-hosting",
      type: AdapterTypes.git_hosting,
      name: "Fake Git Hosting Plugin",
      description: "Test git hosting plugin",
      critical: false,
      adapter_meta: { action_classes: ["git_remote", "merge"] },
    }),
    gitHosting,
  );

  return {
    registry,
    fakes: { trigger, communication, llm, gitHosting },
    cleanup() {
      registry.stopHealthCheckLoop();
    },
  };
}
