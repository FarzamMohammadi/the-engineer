import { beforeEach, describe, expect, it } from "vitest";
import type { GitHostingAdapter } from "../../../src/adapters/git-hosting.js";
import {
  BranchProtectionSchema,
  CommentResultSchema,
  MergeResultSchema,
  PRCommentSchema,
  type PROptions,
  PRResultSchema,
  PRStatusSchema,
  type PluginManifest,
  ReviewStatusSchema,
} from "../../../src/schemas/adapters.js";
import { PrEventSchema } from "../../../src/schemas/git-hosting-events.js";
import { SecureValue } from "../../../src/utils/secure-value.js";
import { createTestPluginContext } from "../test-plugin-context.js";

export interface GitHostingContractFixtures {
  validConfig: Record<string, unknown>;
  invalidConfig: Record<string, unknown>;
  manifest: PluginManifest;
  prOptions: PROptions;
}

/**
 * Contract compliance suite for GitHostingAdapter implementations.
 *
 * Tests behavioral expectations: lifecycle, PR lifecycle methods return
 * expected shapes, branch queries work.
 */
export function runGitHostingContractSuite(
  factory: () => GitHostingAdapter,
  fixtures: GitHostingContractFixtures,
): void {
  describe("Git Hosting Adapter Contract", () => {
    let adapter: GitHostingAdapter;

    beforeEach(() => {
      adapter = factory();
      adapter.manifest = fixtures.manifest;
      adapter.context = createTestPluginContext(fixtures.manifest.id);
    });

    // ── Lifecycle ────────────────────────────────────────────────────────

    describe("lifecycle", () => {
      it("initialize() with valid config returns success", async () => {
        const result = await adapter.initialize(fixtures.validConfig);
        expect(result.success).toBe(true);
      });

      it("initialize() with invalid config returns failure (does not throw)", async () => {
        const result = await adapter.initialize(fixtures.invalidConfig);
        expect(result.success).toBe(false);
        expect(result.message).not.toBeNull();
      });

      it("healthCheck() returns HealthStatus with required fields", async () => {
        await adapter.initialize(fixtures.validConfig);
        const status = await adapter.healthCheck();
        expect(status).toHaveProperty("healthy");
        expect(status).toHaveProperty("message");
        expect(status).toHaveProperty("details");
        expect(typeof status.healthy).toBe("boolean");
      });

      it("healthCheck() resolves within 5 seconds", async () => {
        await adapter.initialize(fixtures.validConfig);
        const start = Date.now();
        await adapter.healthCheck();
        const elapsed = Date.now() - start;
        expect(elapsed).toBeLessThan(5000);
      });

      it("shutdown() resolves without throwing", async () => {
        await adapter.initialize(fixtures.validConfig);
        await expect(adapter.shutdown()).resolves.toBeUndefined();
      });
    });

    // ── PR Lifecycle ─────────────────────────────────────────────────────

    describe("PR lifecycle", () => {
      it("createPR() returns a valid PRResult", async () => {
        await adapter.initialize(fixtures.validConfig);
        const result = await adapter.createPR(fixtures.prOptions);
        const parsed = PRResultSchema.safeParse(result);
        expect(parsed.success).toBe(true);
      });

      it("getPRStatus() returns a valid PRStatus", async () => {
        await adapter.initialize(fixtures.validConfig);
        const pr = await adapter.createPR(fixtures.prOptions);
        const status = await adapter.getPRStatus(fixtures.prOptions.repo, pr.pr_number);
        const parsed = PRStatusSchema.safeParse(status);
        expect(parsed.success).toBe(true);
      });

      it("getReviewStatus() returns a valid ReviewStatus", async () => {
        await adapter.initialize(fixtures.validConfig);
        const pr = await adapter.createPR(fixtures.prOptions);
        const review = await adapter.getReviewStatus(fixtures.prOptions.repo, pr.pr_number);
        const parsed = ReviewStatusSchema.safeParse(review);
        expect(parsed.success).toBe(true);
      });

      it("getPRComments() returns valid PRComment array", async () => {
        await adapter.initialize(fixtures.validConfig);
        const pr = await adapter.createPR(fixtures.prOptions);
        const comments = await adapter.getPRComments(fixtures.prOptions.repo, pr.pr_number);
        expect(Array.isArray(comments)).toBe(true);
        for (const comment of comments) {
          const parsed = PRCommentSchema.safeParse(comment);
          expect(parsed.success).toBe(true);
        }
      });

      it("detectPrEvents() returns a valid PrEvent array", async () => {
        await adapter.initialize(fixtures.validConfig);
        const pr = await adapter.createPR(fixtures.prOptions);
        const events = await adapter.detectPrEvents(fixtures.prOptions.repo, pr.pr_number);
        expect(Array.isArray(events)).toBe(true);
        for (const event of events) {
          const parsed = PrEventSchema.safeParse(event);
          expect(parsed.success).toBe(true);
        }
      });

      it("commentOnPR() returns a valid CommentResult", async () => {
        await adapter.initialize(fixtures.validConfig);
        const pr = await adapter.createPR(fixtures.prOptions);
        const comment = await adapter.commentOnPR(fixtures.prOptions.repo, pr.pr_number, "Test comment");
        const parsed = CommentResultSchema.safeParse(comment);
        expect(parsed.success).toBe(true);
      });

      it("mergePR() returns a valid MergeResult", async () => {
        await adapter.initialize(fixtures.validConfig);
        const pr = await adapter.createPR(fixtures.prOptions);
        const result = await adapter.mergePR(fixtures.prOptions.repo, pr.pr_number, "squash");
        const parsed = MergeResultSchema.safeParse(result);
        expect(parsed.success).toBe(true);
      });

      it("closePR() resolves without throwing", async () => {
        await adapter.initialize(fixtures.validConfig);
        const pr = await adapter.createPR(fixtures.prOptions);
        await expect(adapter.closePR(fixtures.prOptions.repo, pr.pr_number)).resolves.toBeUndefined();
      });

      it("dismissApprovals() resolves without throwing", async () => {
        await adapter.initialize(fixtures.validConfig);
        const pr = await adapter.createPR(fixtures.prOptions);
        await expect(
          adapter.dismissApprovals(fixtures.prOptions.repo, pr.pr_number, "test dismiss"),
        ).resolves.toBeUndefined();
      });
    });

    // ── Branch Queries ───────────────────────────────────────────────────

    describe("branch queries", () => {
      it("getDefaultBranch() returns a string", async () => {
        await adapter.initialize(fixtures.validConfig);
        const branch = await adapter.getDefaultBranch(fixtures.prOptions.repo);
        expect(typeof branch).toBe("string");
        expect(branch.length).toBeGreaterThan(0);
      });

      it("getBranchProtection() returns valid BranchProtection", async () => {
        await adapter.initialize(fixtures.validConfig);
        const protection = await adapter.getBranchProtection(fixtures.prOptions.repo, "main");
        const parsed = BranchProtectionSchema.safeParse(protection);
        expect(parsed.success).toBe(true);
      });
    });

    describe("Authentication", () => {
      it("getAuthenticatedRemoteUrl() returns a SecureValue", async () => {
        await adapter.initialize(fixtures.validConfig);
        const result = adapter.getAuthenticatedRemoteUrl("https://github.com/owner/repo.git");
        expect(result).toBeInstanceOf(SecureValue);
      });

      it("getAuthenticatedRemoteUrl() wraps the URL (toString never leaks)", async () => {
        await adapter.initialize(fixtures.validConfig);
        const result = adapter.getAuthenticatedRemoteUrl("https://github.com/owner/repo.git");
        expect(result.toString()).toBe("[REDACTED]");
        expect(JSON.stringify(result)).toBe('"[REDACTED]"');
      });

      it("getAuthenticatedRemoteUrl() unwrap contains the original host", async () => {
        await adapter.initialize(fixtures.validConfig);
        const result = adapter.getAuthenticatedRemoteUrl("https://github.com/owner/repo.git");
        expect(result.unwrap()).toContain("github.com/owner/repo.git");
      });
    });
  });
}
