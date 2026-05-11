import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { sanitizeErrorMessage, sanitizeSecrets } from "../../../src/utils/sanitize.js";
import { _resetSecretRegistryForTest, registerSecretEnvVars } from "../../../src/utils/secret-registry.js";

describe("sanitizeSecrets", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    _resetSecretRegistryForTest();
    // Register the env vars used in these tests (simulates startup discovery)
    registerSecretEnvVars(["GITHUB_TOKEN", "TELEGRAM_BOT_TOKEN", "ANTHROPIC_API_KEY"]);
    // Clear secret env vars so they don't interfere
    process.env["GITHUB_TOKEN"] = undefined;
    process.env["TELEGRAM_BOT_TOKEN"] = undefined;
  });

  afterEach(() => {
    process.env["GITHUB_TOKEN"] = originalEnv["GITHUB_TOKEN"];
    process.env["TELEGRAM_BOT_TOKEN"] = originalEnv["TELEGRAM_BOT_TOKEN"];
    _resetSecretRegistryForTest();
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
    const input = "push https://git:token1@github.com/a.git and https://git:token2@github.com/b.git";
    const expected = "push https://git:***@github.com/a.git and https://git:***@github.com/b.git";
    expect(sanitizeSecrets(input)).toBe(expected);
  });

  it("does not redact plain https:// URLs without tokens", () => {
    const input = "Visit https://github.com/org/repo for details.";
    expect(sanitizeSecrets(input)).toBe(input);
  });

  // ── Env var value replacement ──────────────────────────────────────────

  it("redacts GITHUB_TOKEN value from text", () => {
    process.env["GITHUB_TOKEN"] = "ghp_RealToken123456";
    const input = "Error with token ghp_RealToken123456 in request";
    expect(sanitizeSecrets(input)).toBe("Error with token [REDACTED] in request");
  });

  it("redacts TELEGRAM_BOT_TOKEN value from text", () => {
    process.env["TELEGRAM_BOT_TOKEN"] = "123456:ABCdefGHIjklMNO";
    const input = "Bot token is 123456:ABCdefGHIjklMNO";
    expect(sanitizeSecrets(input)).toBe("Bot token is [REDACTED]");
  });

  it("redacts multiple occurrences of the same env var value", () => {
    process.env["GITHUB_TOKEN"] = "ghp_repeated_token";
    const input = "token ghp_repeated_token appeared twice ghp_repeated_token";
    expect(sanitizeSecrets(input)).toBe("token [REDACTED] appeared twice [REDACTED]");
  });

  it("does not redact short env var values (< 8 chars)", () => {
    process.env["GITHUB_TOKEN"] = "short";
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
    process.env["GITHUB_TOKEN"] = "ghp_MySecretToken99";
    const input = "Push to https://git:ghp_MySecretToken99@github.com/org/repo failed. Token: ghp_MySecretToken99";
    const expected = "Push to https://git:***@github.com/org/repo failed. Token: [REDACTED]";
    expect(sanitizeSecrets(input)).toBe(expected);
  });

  // ── Pattern-based secret detection (Security Hardening R8) ────────────

  it("redacts GitHub token patterns (ghp_, gho_, ghs_, ghr_)", () => {
    const ghp = `ghp_${"a".repeat(40)}`;
    const gho = `gho_${"b".repeat(40)}`;
    const ghs = `ghs_${"c".repeat(40)}`;
    const ghr = `ghr_${"d".repeat(40)}`;
    const input = `tokens: ${ghp} ${gho} ${ghs} ${ghr}`;
    const result = sanitizeSecrets(input);
    expect(result).not.toContain(ghp);
    expect(result).not.toContain(gho);
    expect(result).not.toContain(ghs);
    expect(result).not.toContain(ghr);
    expect(result).toContain("[REDACTED:token]");
  });

  it("redacts github_pat_ tokens", () => {
    const pat = `github_pat_${"x".repeat(40)}`;
    expect(sanitizeSecrets(`pat=${pat}`)).toContain("[REDACTED:pat]");
  });

  it("redacts AWS key patterns (AKIA...)", () => {
    const awsKey = `AKIA${"A".repeat(16)}`;
    const result = sanitizeSecrets(`key: ${awsKey}`);
    expect(result).toContain("[REDACTED:aws_key]");
    expect(result).not.toContain(awsKey);
  });

  it("redacts assignment patterns (token=long_value)", () => {
    const longValue = "a".repeat(50);
    const input = `api_key="${longValue}"`;
    const result = sanitizeSecrets(input);
    expect(result).toContain("[REDACTED:secret_value]");
  });

  it("does not false-positive on normal text", () => {
    const text = "The environment variable PATH is set to /usr/bin. This is normal code.";
    expect(sanitizeSecrets(text)).toBe(text);
  });

  it("redacts expanded env var list (ANTHROPIC_API_KEY)", () => {
    process.env["ANTHROPIC_API_KEY"] = "sk-ant-test-key-12345678";
    const input = "Using key sk-ant-test-key-12345678 for API";
    expect(sanitizeSecrets(input)).toBe("Using key [REDACTED] for API");
    delete process.env["ANTHROPIC_API_KEY"];
  });

  it("catches multiple pattern types in one string", () => {
    const ghp = `ghp_${"z".repeat(40)}`;
    const awsKey = `AKIA${"B".repeat(16)}`;
    const input = `Tokens: ${ghp} and ${awsKey}`;
    const result = sanitizeSecrets(input);
    expect(result).toContain("[REDACTED:token]");
    expect(result).toContain("[REDACTED:aws_key]");
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

describe("sanitizeErrorMessage", () => {
  it("sanitizes Error objects with token-bearing URLs", () => {
    const error = new Error("request to https://ghp_abc123xyz@api.github.com/repos failed");
    const result = sanitizeErrorMessage(error);
    expect(result).toContain("https://***@api.github.com/repos failed");
    expect(result).not.toContain("ghp_abc123xyz");
  });

  it("sanitizes non-Error values", () => {
    const result = sanitizeErrorMessage("failed at https://git:token123@github.com/org/repo");
    expect(result).toContain("https://git:***@github.com/org/repo");
    expect(result).not.toContain("token123");
  });

  it("passes through clean error messages unchanged", () => {
    const error = new Error("connection refused");
    expect(sanitizeErrorMessage(error)).toBe("connection refused");
  });

  it("handles non-Error non-string values", () => {
    expect(sanitizeErrorMessage(null)).toBe("null");
    expect(sanitizeErrorMessage(42)).toBe("42");
  });
});
