import type { Clock } from "../../src/utils/clock.js";

/**
 * Deterministic clock for testing. Time only advances when explicitly told to.
 * Defaults to 2026-01-01T00:00:00Z for reproducible test timestamps.
 */
export class FakeClock implements Clock {
  private time: number;

  constructor(startTime: number = Date.parse("2026-01-01T00:00:00Z")) {
    this.time = startTime;
  }

  now(): number {
    return this.time;
  }

  advance(ms: number): void {
    this.time += ms;
  }

  set(time: number): void {
    this.time = time;
  }
}
