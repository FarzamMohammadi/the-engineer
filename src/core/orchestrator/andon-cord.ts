// ── AndonCord (Toyota Production System) ────────────────────────────────────
//
// Emergency halt mechanism for the phase pipeline. Any subsystem can "pull
// the cord" to stop execution between phases — named after the Toyota
// Production System's andon cord that halts the assembly line.

/** Emergency halt mechanism — any subsystem can "pull the cord" to stop the pipeline. */
export interface AndonCord {
  /** Pull the cord with a reason. Pipeline halts between phases. */
  pull(reason: string): void;
  /** Check if the cord has been pulled. */
  isPulled(): boolean;
  /** Get the reason the cord was pulled, or null if not pulled. */
  getReason(): string | null;
  /** Reset the cord (after the issue is addressed). */
  reset(): void;
}

/** Create an AndonCord instance. */
export function createAndonCord(): AndonCord {
  let pulled = false;
  let pulledReason: string | null = null;
  return {
    pull(reason) {
      pulled = true;
      pulledReason = reason;
    },
    isPulled() {
      return pulled;
    },
    getReason() {
      return pulledReason;
    },
    reset() {
      pulled = false;
      pulledReason = null;
    },
  };
}
