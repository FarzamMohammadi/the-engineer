import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Observer, createSilentLogger } from "../../../../src/core/observer/index.js";
import type { QuotaStatus } from "../../../../src/schemas/adapters.js";
import { createTestDaemon } from "../../../helpers/test-daemon.js";
import { type TestObserverHandle, createTestObserver } from "../../../helpers/test-observer.js";

const QUOTA: QuotaStatus = {
  windows: [{ window_type: "session", resets_at: null, is_exhausted: false, used_percentage: 42 }],
  is_rate_limited: false,
  earliest_reset_at: null,
};

describe("Daemon — agent quota poll", () => {
  let observerHandle: TestObserverHandle;

  beforeEach(() => {
    observerHandle = createTestObserver();
  });

  afterEach(() => {
    observerHandle.cleanup();
  });

  function queryableObserver(): Observer {
    return new Observer({ rootPino: createSilentLogger().logger, store: observerHandle.observer }, "daemon");
  }

  it("emits a queryable quota_status observation carrying the polled quota and provider", async () => {
    const handle = createTestDaemon(undefined, { observer: queryableObserver() });
    const agent = { manifest: { id: "claude-code-agent" }, getQuotaStatus: vi.fn().mockResolvedValue(QUOTA) };
    handle.registry.getPrimaryPlugin.mockImplementation((type: string) => (type === "agent" ? agent : null));

    await handle.daemon.tick();

    expect(agent.getQuotaStatus).toHaveBeenCalledOnce();
    const observations = observerHandle.observer.query({ type: "quota_status" });
    expect(observations).toHaveLength(1);
    expect(observations[0]?.name).toBe("quota_polled");
    expect(observations[0]?.input).toMatchObject({ provider_id: "claude-code-agent", is_rate_limited: false });

    await handle.daemon.stop().catch(() => undefined);
    handle.cleanup();
  });

  it("emits nothing when the agent plugin does not report quota", async () => {
    const handle = createTestDaemon(undefined, { observer: queryableObserver() });
    const agent = { manifest: { id: "opencode-agent" }, getQuotaStatus: vi.fn().mockResolvedValue(null) };
    handle.registry.getPrimaryPlugin.mockImplementation((type: string) => (type === "agent" ? agent : null));

    await handle.daemon.tick();

    expect(agent.getQuotaStatus).toHaveBeenCalledOnce();
    expect(observerHandle.observer.query({ type: "quota_status" })).toHaveLength(0);

    await handle.daemon.stop().catch(() => undefined);
    handle.cleanup();
  });
});
