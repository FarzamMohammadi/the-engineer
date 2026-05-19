import { describe, expect, it } from "vitest";

import { detectOperatingSystem } from "../../../../src/cli/setup/os-detection.js";

describe("detectOperatingSystem", () => {
  describe("macOS (darwin)", () => {
    const result = detectOperatingSystem("darwin");

    it("classifies as full support", () => {
      expect(result.support).toBe("full");
    });

    it("returns the raw platform value", () => {
      expect(result.platform).toBe("darwin");
    });

    it("labels as macOS", () => {
      expect(result.label).toBe("macOS");
    });

    it("message mentions fully supported", () => {
      expect(result.message).toContain("fully supported");
    });
  });

  describe("Linux", () => {
    const result = detectOperatingSystem("linux");

    it("classifies as preview support", () => {
      expect(result.support).toBe("preview");
    });

    it("returns the raw platform value", () => {
      expect(result.platform).toBe("linux");
    });

    it("labels as Linux", () => {
      expect(result.label).toBe("Linux");
    });

    it("message mentions not thoroughly tested", () => {
      expect(result.message).toContain("not yet thoroughly tested");
    });
  });

  describe("Windows (win32)", () => {
    const result = detectOperatingSystem("win32");

    it("classifies as unsupported", () => {
      expect(result.support).toBe("unsupported");
    });

    it("returns the raw platform value", () => {
      expect(result.platform).toBe("win32");
    });

    it("labels as Windows", () => {
      expect(result.label).toBe("Windows");
    });

    it("message mentions not natively supported", () => {
      expect(result.message).toContain("not natively supported");
    });

    it("message mentions macOS and Linux", () => {
      expect(result.message).toContain("macOS and Linux");
    });
  });

  describe("unknown platform", () => {
    const result = detectOperatingSystem("freebsd");

    it("classifies as unsupported", () => {
      expect(result.support).toBe("unsupported");
    });

    it("uses the raw platform value as label", () => {
      expect(result.label).toBe("freebsd");
    });

    it("message includes the raw platform name", () => {
      expect(result.message).toContain("freebsd");
    });

    it("message mentions not natively supported", () => {
      expect(result.message).toContain("not natively supported");
    });
  });

  describe("return shape", () => {
    it("always returns all four fields", () => {
      for (const platform of ["darwin", "linux", "win32", "freebsd"] as NodeJS.Platform[]) {
        const result = detectOperatingSystem(platform);
        expect(result).toHaveProperty("platform");
        expect(result).toHaveProperty("label");
        expect(result).toHaveProperty("support");
        expect(result).toHaveProperty("message");
      }
    });
  });
});
