import { describe, expect, it } from "vitest";

import { checkPermission } from "../../../../src/core/task-engine/permissions.js";
import { ActionClasses, SubStates, TaskStates } from "../../../../src/schemas/task.js";

describe("checkPermission (pure function)", () => {
  describe("queued state", () => {
    it("allows read", () => {
      const result = checkPermission(TaskStates.queued, null, ActionClasses.read);
      expect(result).toEqual({ allowed: true });
    });

    it("denies write", () => {
      const result = checkPermission(TaskStates.queued, null, ActionClasses.write);
      expect(result.allowed).toBe(false);
    });
  });

  describe("active.working state", () => {
    it("allows read", () => {
      const result = checkPermission(TaskStates.active, SubStates.working, ActionClasses.read);
      expect(result).toEqual({ allowed: true });
    });

    it("allows write", () => {
      const result = checkPermission(TaskStates.active, SubStates.working, ActionClasses.write);
      expect(result).toEqual({ allowed: true });
    });

    it("allows test", () => {
      const result = checkPermission(TaskStates.active, SubStates.working, ActionClasses.test);
      expect(result).toEqual({ allowed: true });
    });

    it("allows git_local", () => {
      const result = checkPermission(TaskStates.active, SubStates.working, ActionClasses.git_local);
      expect(result).toEqual({ allowed: true });
    });

    it("allows git_remote", () => {
      const result = checkPermission(TaskStates.active, SubStates.working, ActionClasses.git_remote);
      expect(result).toEqual({ allowed: true });
    });

    it("allows communicate", () => {
      const result = checkPermission(TaskStates.active, SubStates.working, ActionClasses.communicate);
      expect(result).toEqual({ allowed: true });
    });

    it("allows task_manage", () => {
      const result = checkPermission(TaskStates.active, SubStates.working, ActionClasses.task_manage);
      expect(result).toEqual({ allowed: true });
    });

    it("allows ask_human", () => {
      const result = checkPermission(TaskStates.active, SubStates.working, ActionClasses.ask_human);
      expect(result).toEqual({ allowed: true });
    });

    it("denies merge", () => {
      const result = checkPermission(TaskStates.active, SubStates.working, ActionClasses.merge);
      expect(result.allowed).toBe(false);
    });

    it("denies deploy", () => {
      const result = checkPermission(TaskStates.active, SubStates.working, ActionClasses.deploy);
      expect(result.allowed).toBe(false);
    });
  });

  describe("blocked state", () => {
    it("allows read", () => {
      const result = checkPermission(TaskStates.blocked, null, ActionClasses.read);
      expect(result).toEqual({ allowed: true });
    });

    it("allows communicate", () => {
      const result = checkPermission(TaskStates.blocked, null, ActionClasses.communicate);
      expect(result).toEqual({ allowed: true });
    });

    it("allows ask_human", () => {
      const result = checkPermission(TaskStates.blocked, null, ActionClasses.ask_human);
      expect(result).toEqual({ allowed: true });
    });

    it("denies write", () => {
      const result = checkPermission(TaskStates.blocked, null, ActionClasses.write);
      expect(result.allowed).toBe(false);
    });
  });

  describe("completed state", () => {
    it("denies all actions (empty allowed list)", () => {
      const result = checkPermission(TaskStates.completed, null, ActionClasses.read);
      expect(result.allowed).toBe(false);
    });
  });

  describe("failed state", () => {
    it("allows communicate", () => {
      const result = checkPermission(TaskStates.failed, null, ActionClasses.communicate);
      expect(result).toEqual({ allowed: true });
    });

    it("denies read", () => {
      const result = checkPermission(TaskStates.failed, null, ActionClasses.read);
      expect(result.allowed).toBe(false);
    });

    it("denies write", () => {
      const result = checkPermission(TaskStates.failed, null, ActionClasses.write);
      expect(result.allowed).toBe(false);
    });
  });

  describe("unknown state", () => {
    it("returns not allowed for unknown state", () => {
      const result = checkPermission("nonexistent" as any, null, ActionClasses.read);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("No permission entry");
    });
  });
});
