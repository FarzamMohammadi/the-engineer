# Git Hosting Adapter

Git Hosting adapters manage the PR lifecycle on remote code hosting platforms. They are the remote API layer -- local git operations (worktrees, commits, branches) are handled by the Workspace Manager, not here.

This adapter type is fully separate from Communication adapters. PRs are code artifacts, not messages. GitHub needs three plugins (Trigger, Communication, Hosting) because each operates in a different capability domain.

All 11 methods are required. There are no optional or capability-gated methods. Every implementation must handle the full PR lifecycle: create, update, merge, close, query status, query reviews, dismiss stale approvals, comment, fetch comments, check branch protection, and resolve default branch.

A core safety invariant: never force-merge. If branch protection rules are not satisfied, return an error in `MergeResult` rather than bypassing them.

## Contract

The abstract class `GitHostingAdapter` extends `BaseAdapter`. Plugin authors implement the `do*` protected methods. The public methods wrap them with error handling -- unknown errors become `AdapterMethodError` with `internal_error` code.

| Public Method | Signature | Returns |
|---|---|---|
| `createPR` | `(options: PROptions) => Promise<PRResult>` | `{ pr_number, url }` |
| `updatePR` | `(repo: string, prNumber: number, updates: PRUpdates) => Promise<void>` | -- |
| `mergePR` | `(repo: string, prNumber: number, strategy: MergeStrategy) => Promise<MergeResult>` | `{ merge_sha, success, error }` |
| `closePR` | `(repo: string, prNumber: number) => Promise<void>` | -- |
| `getPRStatus` | `(repo: string, prNumber: number) => Promise<PRStatus>` | `{ number, state, draft, mergeable, checks_state, url }` |
| `getReviewStatus` | `(repo: string, prNumber: number) => Promise<ReviewStatus>` | `{ approved, approvals, changes_requested, reviewers, comments }` |
| `getPRComments` | `(repo: string, prNumber: number) => Promise<PRComment[]>` | Array of `{ id, author, body, created_at }` |
| `commentOnPR` | `(repo: string, prNumber: number, comment: string, replyTo?: string) => Promise<CommentResult>` | `{ comment_id, url }` |
| `dismissApprovals` | `(repo: string, prNumber: number, message: string) => Promise<void>` | -- |
| `getBranchProtection` | `(repo: string, branch: string) => Promise<BranchProtection>` | `{ protected, required_reviews, required_checks, restrictions }` |
| `getDefaultBranch` | `(repo: string) => Promise<string>` | Branch name (e.g. `"main"`) |

The `repo` parameter uses `"owner/repo"` format throughout.

### Lifecycle (inherited from BaseAdapter)

| Method | Signature | Notes |
|---|---|---|
| `initialize` | `(config: Record<string, unknown>) => Promise<InitResult>` | Validate config, set up API client. Never throws -- returns `{ success: false }` on failure. |
| `shutdown` | `() => Promise<void>` | Clean up resources. Errors are swallowed. |
| `healthCheck` | `() => Promise<HealthStatus>` | Report API availability. Timeout handled by Registry. |

## Key Types

All types are Zod schemas exported from `src/schemas/adapters.ts`.

```typescript
// PR creation input
type PROptions = {
  repo: string;        // "owner/repo"
  branch: string;      // head branch
  base: string;        // target branch
  title: string;
  body: string;
  draft: boolean;
  labels: string[] | null;
  reviewers: string[] | null;
};

// PR creation result
type PRResult = { pr_number: number; url: string };

// PR update fields (null = no change)
type PRUpdates = {
  title: string | null;
  body: string | null;
  draft: boolean | null;
  labels_add: string[] | null;
  labels_remove: string[] | null;
};

// Merge strategies
type MergeStrategy = "merge" | "squash" | "rebase";

// Merge result (success: false when protection rules block merge)
type MergeResult = { merge_sha: string; success: boolean; error: AdapterError | null };

// PR state query
type PRStatus = {
  number: number;
  state: "open" | "closed" | "merged";
  draft: boolean;
  mergeable: boolean;
  checks_state: "passing" | "failing" | "pending" | "none";
  url: string;
};

// Review aggregation
type ReviewStatus = {
  approved: boolean;           // true only if approvals > 0 AND no changes_requested
  approvals: number;
  changes_requested: boolean;
  reviewers: { username: string; state: "approved" | "changes_requested" | "commented" | "pending" }[];
  comments: string[];          // review body text
};

// Branch protection
type BranchProtection = {
  protected: boolean;
  required_reviews: number;
  required_checks: string[];
  restrictions: Record<string, unknown> | null;
};
```

## Developing a New Plugin

### Directory structure

```
src/plugins/git-hosting/
  your-hosting/
    your-hosting.ts    # Plugin class
    config.ts          # Zod config schema
```

### Class skeleton

```typescript
import {
  GitHostingAdapter,
  type HealthStatus,
  type InitResult,
  type PROptions,
  type PRResult,
  type PRStatus,
  type PRUpdates,
  type MergeResult,
  type MergeStrategy,
  type ReviewStatus,
  type PRComment,
  type CommentResult,
  type BranchProtection,
  createAdapterError,
} from "../../../adapters/index.js";
import { type YourConfig, YourConfigSchema } from "./config.js";

export class YourHostingPlugin extends GitHostingAdapter {
  private config!: YourConfig;

  // ── PR Lifecycle ────────────────────────────────────
  protected async doCreatePR(options: PROptions): Promise<PRResult> { /* ... */ }
  protected async doUpdatePR(repo: string, prNumber: number, updates: PRUpdates): Promise<void> { /* ... */ }
  protected async doMergePR(repo: string, prNumber: number, strategy: MergeStrategy): Promise<MergeResult> { /* ... */ }
  protected async doClosePR(repo: string, prNumber: number): Promise<void> { /* ... */ }

  // ── PR Queries ──────────────────────────────────────
  protected async doGetPRStatus(repo: string, prNumber: number): Promise<PRStatus> { /* ... */ }
  protected async doGetReviewStatus(repo: string, prNumber: number): Promise<ReviewStatus> { /* ... */ }
  protected async doGetPRComments(repo: string, prNumber: number): Promise<PRComment[]> { /* ... */ }

  // ── PR Comments ─────────────────────────────────────
  protected async doCommentOnPR(repo: string, prNumber: number, comment: string, replyTo: string | undefined): Promise<CommentResult> { /* ... */ }

  // ── Review Actions ─────────────────────────────────
  protected async doDismissApprovals(repo: string, prNumber: number, message: string): Promise<void> { /* ... */ }

  // ── Branch Queries ──────────────────────────────────
  protected async doGetBranchProtection(repo: string, branch: string): Promise<BranchProtection> { /* ... */ }
  protected async doGetDefaultBranch(repo: string): Promise<string> { /* ... */ }

  // ── Lifecycle ───────────────────────────────────────
  protected async doInitialize(config: Record<string, unknown>): Promise<InitResult> {
    const parsed = YourConfigSchema.safeParse(config);
    if (!parsed.success) {
      return { success: false, message: `Invalid config: ${parsed.error.message}` };
    }
    this.config = parsed.data;
    // Set up API client here
    return { success: true, message: null };
  }

  protected async doShutdown(): Promise<void> { /* clean up */ }
  protected async doHealthCheck(): Promise<HealthStatus> { /* check API reachability */ }
}
```

### Config schema

Create a Zod schema in `config.ts`:

```typescript
import { z } from "zod";
import { MergeStrategySchema } from "../../../schemas/adapters.js";

export const YourConfigSchema = z.object({
  api_token: z.string().min(1),
  default_merge_strategy: MergeStrategySchema.default("squash"),
});

export type YourConfig = z.output<typeof YourConfigSchema>;
```

### Registration

Add your plugin to `src/plugins/builtin.ts`:

1. Import your class.
2. Add a manifest entry to the `manifests` array with `type: "git_hosting"`.
3. Add a factory entry to the `factories` map.

```typescript
// In manifests array:
{
  id: "your-hosting",
  type: "git_hosting",
  version: "1.0.0",
  name: "Your Hosting",
  description: "PR lifecycle management via Your Platform API",
  critical: true,
  requirements: [{ type: "env", name: "YOUR_API_TOKEN" }],
  entry: "builtin",
  adapter_meta: { action_classes: ["git-remote", "merge"] },
  contributes: { events: ["git.pr_opened", "git.pr_updated", "git.pr_merged"] },
}

// In factories map:
"your-hosting": () => new YourHostingPlugin(),
```

### Contract tests

Use the reusable contract suite in `test/helpers/contract-suites/git-hosting-contract.ts`:

```typescript
import { describe } from "vitest";
import { runGitHostingContractSuite, type GitHostingContractFixtures } from "../../helpers/contract-suites/git-hosting-contract.js";
import { YourHostingPlugin } from "../../../src/plugins/git-hosting/your-hosting/your-hosting.js";

const fixtures: GitHostingContractFixtures = {
  validConfig: { api_token: "test-token" },
  invalidConfig: {},
  manifest: {
    id: "your-hosting",
    type: "git_hosting",
    version: "1.0.0",
    name: "Your Hosting",
    description: "Test",
    critical: true,
    requirements: [],
    entry: "builtin",
    adapter_meta: {},
    contributes: {},
  },
  prOptions: {
    repo: "owner/repo",
    branch: "feature",
    base: "main",
    title: "Test PR",
    body: "Test body",
    draft: false,
    labels: null,
    reviewers: null,
  },
};

describe("YourHostingPlugin", () => {
  runGitHostingContractSuite(() => new YourHostingPlugin(), fixtures);
});
```

The contract suite validates: lifecycle (init, health, shutdown), PR lifecycle (create, status, review, comments, comment, merge, dismiss approvals), and branch queries (default branch, protection).

## Built-in Plugins

| Plugin | Platform | API Client | Config Keys | Requirements |
|---|---|---|---|---|
| `GitHubHostingPlugin` | GitHub | `@octokit/rest` | `github_token`, `default_merge_strategy` | `GITHUB_TOKEN` env var |

The GitHub implementation uses Octokit for all API calls. It parses `"owner/repo"` strings internally with `splitRepo()`. Merge errors are classified by HTTP status (405 = not mergeable, 409 = conflict). Review aggregation takes the latest state per reviewer and collects review body text.

## Reference

| File | Description |
|---|---|
| `src/adapters/git-hosting.ts` | Abstract class with 11 public methods + 11 protected abstract `do*` methods |
| `src/adapters/base.ts` | `BaseAdapter` -- lifecycle template methods, manifest, `hasCapability()` |
| `src/adapters/errors.ts` | `AdapterMethodError` and `createAdapterError()` |
| `src/schemas/adapters.ts` | All Zod schemas: `PROptionsSchema`, `PRResultSchema`, `MergeResultSchema`, etc. |
| `src/plugins/git-hosting/github-hosting/github-hosting.ts` | Reference implementation (GitHub via Octokit) |
| `src/plugins/git-hosting/github-hosting/config.ts` | GitHub-specific config schema |
| `src/plugins/builtin.ts` | Manifest definitions and factory registration |
| `test/helpers/contract-suites/git-hosting-contract.ts` | Reusable contract compliance test suite |
