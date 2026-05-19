import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CommunicationAdapter } from "../../src/adapters/communication.js";
import { GitHostingAdapter } from "../../src/adapters/git-hosting.js";
import { LLMAdapter } from "../../src/adapters/llm.js";
import { TriggerAdapter } from "../../src/adapters/trigger.js";
import { AdapterTypes, MessageTypes } from "../../src/schemas/adapters.js";
import { type TestEventBusHandle, createTestEventBus } from "./test-event-bus.js";
import { type TestRegistryHandle, createTestRegistry } from "./test-registry.js";

describe("createTestRegistry", () => {
  let eventBusHandle: TestEventBusHandle;
  let registryHandle: TestRegistryHandle;

  beforeEach(() => {
    eventBusHandle = createTestEventBus();
    registryHandle = createTestRegistry(eventBusHandle.eventBus);
  });

  afterEach(() => {
    registryHandle.cleanup();
    eventBusHandle.cleanup();
  });

  it("registers all 4 fake plugins", () => {
    const { registry } = registryHandle;
    expect(registry.getPluginsByType(AdapterTypes.trigger)).toHaveLength(1);
    expect(registry.getPluginsByType(AdapterTypes.communication)).toHaveLength(1);
    expect(registry.getPluginsByType(AdapterTypes.llm)).toHaveLength(1);
    expect(registry.getPluginsByType(AdapterTypes.git_hosting)).toHaveLength(1);
  });

  it("provides direct access to fake instances", () => {
    const { fakes } = registryHandle;
    expect(fakes.trigger).toBeInstanceOf(TriggerAdapter);
    expect(fakes.communication).toBeInstanceOf(CommunicationAdapter);
    expect(fakes.llm).toBeInstanceOf(LLMAdapter);
    expect(fakes.gitHosting).toBeInstanceOf(GitHostingAdapter);
  });

  it("injects manifests into all fakes", () => {
    const { fakes } = registryHandle;
    expect(fakes.trigger.manifest.id).toBe("fake-trigger");
    expect(fakes.communication.manifest.id).toBe("fake-comm");
    expect(fakes.llm.manifest.id).toBe("fake-llm");
    expect(fakes.gitHosting.manifest.id).toBe("fake-git-hosting");
  });

  it("cleanup stops health check loop", () => {
    const { registry } = registryHandle;
    const spy = vi.spyOn(registry, "stopHealthCheckLoop");

    registryHandle.cleanup();

    expect(spy).toHaveBeenCalled();
  });

  it("fakes are controllable for tests", async () => {
    const { fakes } = registryHandle;

    // Trigger: set events
    fakes.trigger.setEvents([
      {
        idempotency_key: "test:1",
        source: "fake-trigger",
        event_type: "issue_opened",
        external_ref: { type: "test_issue", repo: "test/repo", id: "1" },
        title: "Test issue",
        body: null,
        repo: "test/repo",
        clone_url: "https://github.com/test/repo.git",
        metadata: null,
        thoughts_id: "test-1",
      },
    ]);

    const events = await fakes.trigger.poll();
    expect(events).toHaveLength(1);

    // Communication: records messages
    await fakes.communication.sendMessage(
      { user_id: "user1", channel: null },
      { content: "hello", metadata: { task_id: null, type: MessageTypes.notification } },
    );
    expect(fakes.communication.getMessages()).toHaveLength(1);

    // LLM: returns canned responses
    const result = await fakes.llm.infer({
      prompt: "test",
      system_prompt: null,
      cwd: null,
      trace_output_path: null,
    });
    expect(result.content).toBe("Fake LLM response");
    expect(result.cost_usd).toBe(0.01);
  });
});
