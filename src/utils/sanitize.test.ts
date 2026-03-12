import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { sanitizeSecrets } from "./sanitize.js";

describe("sanitizeSecrets", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Clear secret env vars so they don't interfere
    process.env.GITHUB_TOKEN = undefined;
    process.env.TELEGRAM_BOT_TOKEN = undefined;
  });

  afterEach(() => {
    process.env.GITHUB_TOKEN = originalEnv.GITHUB_TOKEN;
    process.env.TELEGRAM_BOT_TOKEN = originalEnv.TELEGRAM_BOT_TOKEN;
  });

  // ── Empty / no-op cases ──────────────────────────────────────────────────

  it("returns empty string unchanged", () => {
    expect(sanitizeSecrets("")).toBe("");
  });

  it("returns text unchanged when no secrets present", () => {
    const text = "Everything is fine, no tokens here.";
    expect(sanitizeSecrets(text)).toBe(text);
  });

  // ── URL token patterns ─────────────────────────────────────────────────

  it("redacts https://git:{token}@ pattern", () => {
    const input = "fatal: unable to access 'https://git:ghp_abc123xyz@github.com/org/repo.git/'";
    const expected = "fatal: unable to access 'https://git:***@github.com/org/repo.git/'";
    expect(sanitizeSecrets(input)).toBe(expected);
  });

  it("redacts https://{token}@ pattern (bare token)", () => {
    const input = "Cloning into 'repo'... https://ghp_abc123xyz@github.com/org/repo.git";
    const expected = "Cloning into 'repo'... https://***@github.com/org/repo.git";
    expect(sanitizeSecrets(input)).toBe(expected);
  });

  it("redacts multiple URL tokens in one string", () => {
    const input =
      "push https://git:token1@github.com/a.git and https://git:token2@github.com/b.git";
    const expected = "push https://git:***@github.com/a.git and https://git:***@github.com/b.git";
    expect(sanitizeSecrets(input)).toBe(expected);
  });

  it("does not redact plain https:// URLs without tokens", () => {
    const input = "Visit https://github.com/org/repo for details.";
    expect(sanitizeSecrets(input)).toBe(input);
  });

  // ── Env var value replacement ──────────────────────────────────────────

  it("redacts GITHUB_TOKEN value from text", () => {
    process.env.GITHUB_TOKEN = "ghp_RealToken123456";
    const input = "Error with token ghp_RealToken123456 in request";
    expect(sanitizeSecrets(input)).toBe("Error with token [REDACTED] in request");
  });

  it("redacts TELEGRAM_BOT_TOKEN value from text", () => {
    process.env.TELEGRAM_BOT_TOKEN = "123456:ABCdefGHIjklMNO";
    const input = "Bot token is 123456:ABCdefGHIjklMNO";
    expect(sanitizeSecrets(input)).toBe("Bot token is [REDACTED]");
  });

  it("redacts multiple occurrences of the same env var value", () => {
    process.env.GITHUB_TOKEN = "ghp_repeated_token";
    const input = "token ghp_repeated_token appeared twice ghp_repeated_token";
    expect(sanitizeSecrets(input)).toBe("token [REDACTED] appeared twice [REDACTED]");
  });

  it("does not redact short env var values (< 8 chars)", () => {
    process.env.GITHUB_TOKEN = "short";
    const input = "The word short appears here.";
    expect(sanitizeSecrets(input)).toBe(input);
  });

  it("ignores env vars that are not set", () => {
    // GITHUB_TOKEN and TELEGRAM_BOT_TOKEN are deleted in beforeEach
    const input = "No env vars to match against.";
    expect(sanitizeSecrets(input)).toBe(input);
  });

  // ── Combined patterns ─────────────────────────────────────────────────

  it("redacts both URL tokens and env var values in one pass", () => {
    process.env.GITHUB_TOKEN = "ghp_MySecretToken99";
    const input =
      "Push to https://git:ghp_MySecretToken99@github.com/org/repo failed. Token: ghp_MySecretToken99";
    const expected = "Push to https://git:***@github.com/org/repo failed. Token: [REDACTED]";
    expect(sanitizeSecrets(input)).toBe(expected);
  });

  // ── Real-world git error messages ──────────────────────────────────────

  it("handles realistic git push error", () => {
    const input = [
      "remote: Permission to org/repo.git denied to git.",
      "fatal: unable to access 'https://git:ghp_x9k2m4n7@github.com/org/repo.git/': The requested URL returned error: 403",
    ].join("\n");

    const result = sanitizeSecrets(input);
    expect(result).toContain("https://git:***@github.com/org/repo.git/");
    expect(result).not.toContain("ghp_x9k2m4n7");
  });
});
