/**
 * Opaque wrapper for sensitive values (tokens, keys, credentials).
 *
 * Prevents accidental leakage through toString, JSON serialization, console
 * logging, and Node.js inspect. The raw value is accessible only via the
 * explicit `unwrap()` call — a conscious decision at the exact point of use.
 *
 * Modeled after Rust's `secrecy::Secret<T>`.
 */
export class SecureValue {
  #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  /** Explicitly retrieve the raw secret. Use only at the point of consumption. */
  unwrap(): string {
    return this.#value;
  }

  /** Always returns "[REDACTED]" — prevents leakage via string coercion. */
  toString(): string {
    return "[REDACTED]";
  }

  /** Always returns "[REDACTED]" — prevents leakage via JSON.stringify. */
  toJSON(): string {
    return "[REDACTED]";
  }

  /** Always returns "[REDACTED]" — prevents leakage via util.inspect / console.log. */
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return "[REDACTED]";
  }
}
