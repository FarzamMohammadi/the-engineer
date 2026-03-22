import { PluginManifestSchema } from "../../../../src/schemas/adapters.js";
import { runGitHostingContractSuite } from "../../contract-suites/git-hosting-contract.js";
import { FakeGitHostingPlugin } from "./index.js";

const manifest = PluginManifestSchema.parse({
  id: "fake-git-hosting",
  type: "git_hosting",
  version: "1.0.0",
  name: "Fake Git Hosting Plugin",
  description: "Test git hosting plugin",
  adapter_meta: { action_classes: ["git_remote", "merge"] },
});

runGitHostingContractSuite(() => new FakeGitHostingPlugin(), {
  validConfig: {},
  invalidConfig: { _force_fail: true },
  manifest,
  prOptions: {
    repo: "test/repo",
    branch: "feature/test",
    base: "main",
    title: "Test PR",
    body: "Test body",
    draft: false,
    labels: null,
    reviewers: null,
  },
});
