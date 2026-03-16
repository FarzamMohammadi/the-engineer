import { describe, expect, it, vi } from "vitest";

import { createTestObserverFacade } from "../../../test/helpers/test-observer-facade.js";
import { HookAbortError, type HookHandler, HookRegistry } from "./index.js";

describe("HookRegistry", () => {
  // ── Registration ────────────────────────────────────────────────────────

  describe("register / deregister", () => {
    it("registers a handler and reports it in getRegisteredHooks", () => {
      const registry = new HookRegistry(createTestObserverFacade("hooks"));
      const handler: HookHandler = vi.fn();

      registry.register("plugin-a", "pre:task:create", handler);

      const hooks = registry.getRegisteredHooks();
      expect(hooks.get("pre:task:create")).toBe(1);
    });

    it("supports multiple handlers for the same hook point", () => {
      const registry = new HookRegistry(createTestObserverFacade("hooks"));

      registry.register("plugin-a", "post:task:create", vi.fn());
      registry.register("plugin-b", "post:task:create", vi.fn());

      const hooks = registry.getRegisteredHooks();
      expect(hooks.get("post:task:create")).toBe(2);
    });

    it("deregister removes all hooks for a plugin", () => {
      const registry = new HookRegistry(createTestObserverFacade("hooks"));

      registry.register("plugin-a", "pre:task:create", vi.fn());
      registry.register("plugin-a", "post:task:create", vi.fn());
      registry.register("plugin-b", "pre:task:create", vi.fn());

      registry.deregister("plugin-a");

      const hooks = registry.getRegisteredHooks();
      expect(hooks.get("pre:task:create")).toBe(1); // only plugin-b
      expect(hooks.has("post:task:create")).toBe(false); // removed entirely
    });

    it("deregister is a no-op for unknown plugin", () => {
      const registry = new HookRegistry(createTestObserverFacade("hooks"));
      registry.register("plugin-a", "pre:task:create", vi.fn());

      registry.deregister("unknown-plugin");

      expect(registry.getRegisteredHooks().get("pre:task:create")).toBe(1);
    });
  });

  // ── Execution order ──────────────────────────────────────────────────────

  describe("execution order", () => {
    it("handlers execute in registration order", async () => {
      const registry = new HookRegistry(createTestObserverFacade("hooks"));
      const order: string[] = [];

      registry.register("plugin-a", "post:task:create", () => {
        order.push("a");
      });
      registry.register("plugin-b", "post:task:create", () => {
        order.push("b");
      });
      registry.register("plugin-c", "post:task:create", () => {
        order.push("c");
      });

      await registry.execute("post:task:create", {});

      expect(order).toEqual(["a", "b", "c"]);
    });
  });

  // ── Error isolation ──────────────────────────────────────────────────────

  describe("error isolation", () => {
    it("post: hook errors are caught and do not prevent subsequent handlers", async () => {
      const observer = createTestObserverFacade("hooks");
      const errorSpy = vi.spyOn(observer, "error");
      const registry = new HookRegistry(observer);
      const handlerC = vi.fn();

      registry.register("plugin-a", "post:phase:complete", () => {
        throw new Error("boom");
      });
      registry.register("plugin-c", "post:phase:complete", handlerC);

      await registry.execute("post:phase:complete", {});

      expect(handlerC).toHaveBeenCalledOnce();
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Hook error [post:phase:complete] from plugin "plugin-a"'),
        expect.any(Object),
      );
    });

    it("pre: hook non-HookAbortError errors are caught and continue", async () => {
      const observer = createTestObserverFacade("hooks");
      const registry = new HookRegistry(observer);
      const handlerB = vi.fn();

      registry.register("plugin-a", "pre:task:create", () => {
        throw new Error("regular error");
      });
      registry.register("plugin-b", "pre:task:create", handlerB);

      await registry.execute("pre:task:create", {});

      expect(handlerB).toHaveBeenCalledOnce();
    });
  });

  // ── Abort ──────────────────────────────────────────────────────────────

  describe("abort", () => {
    it("HookAbortError from pre: hook propagates", async () => {
      const registry = new HookRegistry(createTestObserverFacade("hooks"));
      const handlerB = vi.fn();

      registry.register("plugin-a", "pre:task:transition", () => {
        throw new HookAbortError("plugin-a", "not allowed");
      });
      registry.register("plugin-b", "pre:task:transition", handlerB);

      await expect(registry.execute("pre:task:transition", {})).rejects.toThrow(HookAbortError);

      // handler-b should NOT have been called
      expect(handlerB).not.toHaveBeenCalled();
    });

    it("HookAbortError from post: hook does NOT propagate", async () => {
      const observer = createTestObserverFacade("hooks");
      const registry = new HookRegistry(observer);

      registry.register("plugin-a", "post:task:transition", () => {
        throw new HookAbortError("plugin-a", "not allowed");
      });

      // Should not throw
      await registry.execute("post:task:transition", {});
    });

    it("HookAbortError has correct properties", () => {
      const err = new HookAbortError("my-plugin", "blocked");
      expect(err.name).toBe("HookAbortError");
      expect(err.pluginId).toBe("my-plugin");
      expect(err.reason).toBe("blocked");
      expect(err.message).toBe("Hook aborted by my-plugin: blocked");
    });
  });

  // ── Async handlers ──────────────────────────────────────────────────────

  describe("async handlers", () => {
    it("awaits async handlers correctly", async () => {
      const registry = new HookRegistry(createTestObserverFacade("hooks"));
      const order: string[] = [];

      registry.register("plugin-a", "pre:tool:execute", async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        order.push("async-a");
      });
      registry.register("plugin-b", "pre:tool:execute", () => {
        order.push("sync-b");
      });

      await registry.execute("pre:tool:execute", {});

      expect(order).toEqual(["async-a", "sync-b"]);
    });

    it("supports synchronous handlers", async () => {
      const registry = new HookRegistry(createTestObserverFacade("hooks"));
      const called = vi.fn();

      registry.register("plugin-a", "post:publish", () => {
        called();
      });

      await registry.execute("post:publish", {});

      expect(called).toHaveBeenCalledOnce();
    });
  });

  // ── Empty hooks ────────────────────────────────────────────────────────

  describe("empty hooks", () => {
    it("executing a hook with no handlers is a no-op", async () => {
      const registry = new HookRegistry(createTestObserverFacade("hooks"));

      // Should not throw
      await registry.execute("pre:task:create", { someData: true });
    });

    it("getRegisteredHooks returns empty map when nothing registered", () => {
      const registry = new HookRegistry(createTestObserverFacade("hooks"));
      const hooks = registry.getRegisteredHooks();
      expect(hooks.size).toBe(0);
    });
  });

  // ── Context ────────────────────────────────────────────────────────────

  describe("hook context", () => {
    it("passes correct context to handlers", async () => {
      const registry = new HookRegistry(createTestObserverFacade("hooks"));
      const handler = vi.fn();

      registry.register("plugin-a", "pre:phase:start", handler);

      await registry.execute("pre:phase:start", { phase: "execution", taskId: "t1" });

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          hookPoint: "pre:phase:start",
          data: { phase: "execution", taskId: "t1" },
          timestamp: expect.any(String),
        }),
      );
    });
  });
});
