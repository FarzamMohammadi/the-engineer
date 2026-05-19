import { describe, expect, it } from "vitest";

import {
  InferenceRequestSchema,
  InferenceResultSchema,
  PluginManifestSchema,
  TriggerEventSchema,
} from "../../src/schemas/adapters.js";
import { EventSchema } from "../../src/schemas/events.js";
import { TaskSchema, TaskStates } from "../../src/schemas/task.js";
import {
  createMockEvent,
  createMockInferenceRequest,
  createMockInferenceResult,
  createMockManifest,
  createMockTask,
  createMockTriggerEvent,
} from "./mock-factories.js";

describe("mock-factories", () => {
  describe("createMockManifest", () => {
    it("produces a Zod-valid PluginManifest", () => {
      const manifest = createMockManifest();
      expect(() => PluginManifestSchema.parse(manifest)).not.toThrow();
    });

    it("applies overrides", () => {
      const manifest = createMockManifest({ id: "custom-id", type: "llm" });
      expect(manifest.id).toBe("custom-id");
      expect(manifest.type).toBe("llm");
    });

    it("provides sensible defaults", () => {
      const manifest = createMockManifest();
      expect(manifest.id).toBe("mock-plugin");
      expect(manifest.version).toBe("1.0.0");
    });
  });

  describe("createMockTriggerEvent", () => {
    it("produces a Zod-valid TriggerEvent", () => {
      const event = createMockTriggerEvent();
      expect(() => TriggerEventSchema.parse(event)).not.toThrow();
    });

    it("applies overrides", () => {
      const event = createMockTriggerEvent({ title: "Custom title", repo: "custom/repo" });
      expect(event.title).toBe("Custom title");
      expect(event.repo).toBe("custom/repo");
    });
  });

  describe("createMockEvent", () => {
    it("produces a Zod-valid Event", () => {
      const event = createMockEvent("task.created", { task_id: "t1" });
      expect(() => EventSchema.parse(event)).not.toThrow();
    });

    it("uses provided type and payload", () => {
      const event = createMockEvent("cost.incurred", { amount: 0.5 });
      expect(event.type).toBe("cost.incurred");
      expect(event.payload).toEqual({ amount: 0.5 });
    });

    it("applies overrides", () => {
      const event = createMockEvent("task.created", {}, { task_id: "t1", source: "test" });
      expect(event.task_id).toBe("t1");
      expect(event.source).toBe("test");
    });
  });

  describe("createMockTask", () => {
    it("produces a Zod-valid Task", () => {
      const task = createMockTask();
      expect(() => TaskSchema.parse(task)).not.toThrow();
    });

    it("applies overrides", () => {
      const task = createMockTask({
        title: "Custom task",
        state: TaskStates.active,
        sub_state: "working",
      });
      expect(task.title).toBe("Custom task");
      expect(task.state).toBe(TaskStates.active);
      expect(task.sub_state).toBe("working");
    });

    it("has sensible defaults", () => {
      const task = createMockTask();
      expect(task.state).toBe(TaskStates.requirements_gathering);
      expect(task.priority).toBe(50);
      expect(task.children).toEqual([]);
    });
  });

  describe("createMockInferenceRequest", () => {
    it("produces a Zod-valid InferenceRequest", () => {
      const request = createMockInferenceRequest();
      expect(() => InferenceRequestSchema.parse(request)).not.toThrow();
    });

    it("applies overrides", () => {
      const request = createMockInferenceRequest({ prompt: "Custom prompt" });
      expect(request.prompt).toBe("Custom prompt");
    });
  });

  describe("createMockInferenceResult", () => {
    it("matches InferenceResult schema shape", () => {
      const result = createMockInferenceResult();
      expect(() => InferenceResultSchema.parse(result)).not.toThrow();
    });

    it("always includes cost and duration data", () => {
      const result = createMockInferenceResult();
      expect(result).toHaveProperty("cost_usd");
      expect(result.duration_ms).toBeGreaterThanOrEqual(0);
    });
  });
});
