import { describe, expect, it } from "vitest";

import { mapActivity } from "../../../../src/core/agent-activity/index.js";
import type { AgentActivityEvent } from "../../../../src/schemas/adapters.js";

// A real-looking GitHub token (ghp_ + 36 chars) the pattern sanitizer redacts with no registry setup.
const SECRET = `ghp_${"a".repeat(36)}`;

describe("mapActivity", () => {
  describe("per-kind shape", () => {
    it("maps a session marker to a session-named observation carrying the boot fields", () => {
      const event: AgentActivityEvent = { kind: "session", model: "claude", tools: 12, cwd: "/repo" };

      const parts = mapActivity(event);

      expect(parts.name).toBe("session");
      expect(parts.data).toEqual({ kind: "session", model: "claude", tools: 12, cwd: "/repo" });
      expect(parts.blobs).toEqual([]);
    });

    it("maps assistant text to an assistant_text observation with the text inline", () => {
      const parts = mapActivity({ kind: "assistant_text", text: "Here is the plan." });

      expect(parts.name).toBe("assistant_text");
      expect(parts.data).toEqual({ kind: "assistant_text", text: "Here is the plan." });
      expect(parts.blobs).toEqual([]);
    });

    it("maps a thinking block to a thinking observation with the reasoning inline", () => {
      const parts = mapActivity({ kind: "thinking", text: "First I should read the file." });

      expect(parts.name).toBe("thinking");
      expect(parts.data).toEqual({ kind: "thinking", text: "First I should read the file." });
    });

    it("names a tool_use after the tool so the conversation reads by tool, not by kind", () => {
      const parts = mapActivity({ kind: "tool_use", tool_call_id: "call-1", name: "bash", input: { command: "ls" } });

      expect(parts.name).toBe("bash");
      expect(parts.data).toEqual({
        kind: "tool_use",
        tool_call_id: "call-1",
        name: "bash",
        input: JSON.stringify({ command: "ls" }),
      });
    });

    it("maps a tool_result to a tool_result observation paired by tool_call_id", () => {
      const parts = mapActivity({ kind: "tool_result", tool_call_id: "call-1", status: "ok", output: "file.txt" });

      expect(parts.name).toBe("tool_result");
      expect(parts.data).toEqual({ kind: "tool_result", tool_call_id: "call-1", status: "ok", output: "file.txt" });
    });

    it("keeps an error tool_result's status so the conversation shows it failed", () => {
      const parts = mapActivity({ kind: "tool_result", tool_call_id: "call-9", status: "error", output: "boom" });

      expect(parts.data).toMatchObject({ status: "error", output: "boom" });
    });
  });

  describe("size bounding", () => {
    it("inlines a short payload with no blob", () => {
      const parts = mapActivity({ kind: "assistant_text", text: "short" });

      expect(parts.data["text"]).toBe("short");
      expect(parts.data["truncated"]).toBeUndefined();
      expect(parts.blobs).toEqual([]);
    });

    it("truncates a long payload inline and offloads the full value to a blob", () => {
      const long = "x".repeat(2000);

      const parts = mapActivity({ kind: "assistant_text", text: long });

      expect((parts.data["text"] as string).length).toBe(600);
      expect(parts.data["truncated"]).toBe(true);
      expect(parts.blobs).toEqual([{ field: "text_blob", content: long }]);
    });

    it("offloads a large tool input under input_blob", () => {
      const bigInput = { script: "y".repeat(2000) };

      const parts = mapActivity({ kind: "tool_use", tool_call_id: "c", name: "bash", input: bigInput });

      expect(parts.data["truncated"]).toBe(true);
      expect(parts.blobs[0]?.field).toBe("input_blob");
      expect(parts.blobs[0]?.content).toBe(JSON.stringify(bigInput));
    });

    it("offloads a large tool output under output_blob", () => {
      const parts = mapActivity({ kind: "tool_result", tool_call_id: "c", status: "ok", output: "z".repeat(2000) });

      expect(parts.blobs[0]?.field).toBe("output_blob");
    });
  });

  describe("secret sanitization", () => {
    it("scrubs a secret from inline assistant text", () => {
      const parts = mapActivity({ kind: "assistant_text", text: `token is ${SECRET} done` });

      expect(parts.data["text"]).not.toContain(SECRET);
      expect(parts.data["text"]).toContain("[REDACTED:token]");
    });

    it("scrubs a secret from a tool input before it is inlined", () => {
      const parts = mapActivity({ kind: "tool_use", tool_call_id: "c", name: "bash", input: { env: SECRET } });

      expect(JSON.stringify(parts.data)).not.toContain(SECRET);
    });

    it("scrubs a secret from an offloaded blob, not just the preview", () => {
      const leaky = `${SECRET} ${"q".repeat(2000)}`;

      const parts = mapActivity({ kind: "tool_result", tool_call_id: "c", status: "ok", output: leaky });

      expect(parts.blobs[0]?.content).not.toContain(SECRET);
      expect(parts.data["output"]).not.toContain(SECRET);
    });
  });

  describe("payload stringification", () => {
    it("passes a string tool input through verbatim (no JSON quoting)", () => {
      const parts = mapActivity({ kind: "tool_use", tool_call_id: "c", name: "bash", input: "ls -la" });

      expect(parts.data["input"]).toBe("ls -la");
    });

    it("survives an unserializable tool input without throwing", () => {
      const circular: Record<string, unknown> = {};
      circular["self"] = circular;

      const parts = mapActivity({ kind: "tool_use", tool_call_id: "c", name: "bash", input: circular });

      expect(parts.name).toBe("bash");
      expect(typeof parts.data["input"]).toBe("string");
    });
  });
});
