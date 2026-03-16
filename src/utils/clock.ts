/** Minimal clock interface for injectable time control. */
export interface Clock {
  now(): number;
}

/** Production clock that delegates to Date.now(). */
export class RealClock implements Clock {
  now(): number {
    return Date.now();
  }
}
