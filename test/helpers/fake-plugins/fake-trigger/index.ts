import { TriggerAdapter } from "../../../../src/adapters/trigger.js";
import type { HealthStatus, InitResult, TriggerEvent } from "../../../../src/schemas/adapters.js";

/**
 * Fake trigger plugin for testing.
 *
 * Test control surface:
 * - `setEvents(events)` — configure what `poll()` returns
 * - `setFailNextPoll(fail)` — make the next `poll()` throw
 * - `setUnhealthy(fail)` — make healthCheck return unhealthy
 * - `getPollCount()` — how many times `poll()` was called
 * - `getInitConfig()` — what config was passed to initialize
 * - `wasShutdownCalled()` — whether shutdown was called
 */
export class FakeTriggerPlugin extends TriggerAdapter {
  private events: TriggerEvent[] = [];
  private shouldFailPoll = false;
  private shouldFailHealthCheck = false;
  private pollCount = 0;
  private initConfig: Record<string, unknown> | null = null;
  private shutdownCalled = false;

  // ── Test Control Surface ────────────────────────────────────────────────

  setEvents(events: TriggerEvent[]): void {
    this.events = events;
  }

  setFailNextPoll(fail: boolean): void {
    this.shouldFailPoll = fail;
  }

  setUnhealthy(fail: boolean): void {
    this.shouldFailHealthCheck = fail;
  }

  getPollCount(): number {
    return this.pollCount;
  }

  getInitConfig(): Record<string, unknown> | null {
    return this.initConfig;
  }

  wasShutdownCalled(): boolean {
    return this.shutdownCalled;
  }

  // ── Adapter Implementation ──────────────────────────────────────────────

  protected doPoll(): Promise<TriggerEvent[]> {
    this.pollCount++;
    if (this.shouldFailPoll) {
      this.shouldFailPoll = false;
      return Promise.reject(new Error("Fake trigger poll failure"));
    }
    return Promise.resolve([...this.events]);
  }

  protected doInitialize(config: Record<string, unknown>): Promise<InitResult> {
    this.initConfig = config;
    if (config["_force_fail"] === true) {
      return Promise.resolve({ success: false, message: "Forced failure for testing" });
    }
    return Promise.resolve({ success: true, message: null });
  }

  protected doShutdown(): Promise<void> {
    this.shutdownCalled = true;
    return Promise.resolve();
  }

  protected doHealthCheck(): Promise<HealthStatus> {
    return Promise.resolve({
      healthy: !this.shouldFailHealthCheck,
      message: this.shouldFailHealthCheck ? "Fake trigger unhealthy" : null,
      details: null,
    });
  }
}

export function createPlugin(): TriggerAdapter {
  return new FakeTriggerPlugin();
}
