import type { EventBus } from "../../src/core/event-bus/index.js";
import { Registry } from "../../src/core/registry/index.js";
import { FakeCommunicationPlugin } from "./fake-plugins/fake-comm/index.js";
import { FakeGitHostingPlugin } from "./fake-plugins/fake-git-hosting/index.js";
import { FakeLLMPlugin } from "./fake-plugins/fake-llm/index.js";
import { FakeToolPlugin } from "./fake-plugins/fake-tool/index.js";
import { FakeTriggerPlugin } from "./fake-plugins/fake-trigger/index.js";
import { createMockManifest } from "./mock-factories.js";
import { createTestObserverFacade } from "./test-observer-facade.js";

export interface TestRegistryFakes {
  trigger: FakeTriggerPlugin;
  communication: FakeCommunicationPlugin;
  llm: FakeLLMPlugin;
  tool: FakeToolPlugin;
  gitHosting: FakeGitHostingPlugin;
}

export interface TestRegistryHandle {
  registry: Registry;
  fakes: TestRegistryFakes;
  cleanup(): void;
}

/**
 * Creates a Registry pre-loaded with all 5 fake plugins.
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
    healthCheckIntervalMs: 60_000,
    healthCheckTimeoutMs: 1_000,
    consecutiveFailuresThreshold: 3,
  });

  const trigger = new FakeTriggerPlugin();
  const communication = new FakeCommunicationPlugin();
  const llm = new FakeLLMPlugin();
  const tool = new FakeToolPlugin();
  const gitHosting = new FakeGitHostingPlugin();

  registry.register(
    createMockManifest({
      id: "fake-trigger",
      type: "trigger",
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
      type: "communication",
      name: "Fake Communication Plugin",
      description: "Test communication plugin",
      critical: false,
      adapter_meta: { capabilities: ["send", "receive"] },
    }),
    communication,
  );

  registry.register(
    createMockManifest({
      id: "fake-llm",
      type: "llm",
      name: "Fake LLM Plugin",
      description: "Test LLM plugin",
      critical: false,
      adapter_meta: { provider_type: "cli" },
    }),
    llm,
  );

  registry.register(
    createMockManifest({
      id: "fake-tool",
      type: "tool",
      name: "Fake Tool Plugin",
      description: "Test tool plugin",
      critical: false,
      adapter_meta: { action_classes: ["read", "write"] },
    }),
    tool,
  );

  registry.register(
    createMockManifest({
      id: "fake-git-hosting",
      type: "git_hosting",
      name: "Fake Git Hosting Plugin",
      description: "Test git hosting plugin",
      critical: false,
      adapter_meta: { action_classes: ["git_remote", "merge"] },
    }),
    gitHosting,
  );

  return {
    registry,
    fakes: { trigger, communication, llm, tool, gitHosting },
    cleanup() {
      registry.stopHealthCheckLoop();
    },
  };
}
