import { defineConfig } from "vitepress";
// withMermaid renders the ```mermaid fences in docs/ (e.g. architecture/overview.md) as diagrams —
// stock VitePress would otherwise print them as raw code blocks on the published site.
import { withMermaid } from "vitepress-plugin-mermaid";

// VitePress requires a default export here. The `docs/.vitepress/**` biome override sanctions it,
// mirroring the existing `src/dashboard/client/vite.config.ts` override — a deliberate, documented
// deviation from coding-standards § 6 (No Default Exports), as anti-patterns.md § Dogmatic Rule
// Following allows for genuine config-file cases.
export default withMermaid(
  defineConfig({
    title: "The Engineer",
    description:
      "An autonomous orchestrator for AI coding agents — the full engineering lifecycle, on a swappable plugin architecture.",
    base: "/the-engineer/",
    cleanUrls: true,
    lastUpdated: true,
    // The build journal + internal planning under docs/archived/ are linked from the nav, not built as
    // site pages.
    srcExclude: ["archived/**"],
    // localhostLinks keeps the local dashboard URLs (http://localhost:3847) valid; all other links
    // must resolve to real site pages or absolute external URLs.
    ignoreDeadLinks: "localhostLinks",
    themeConfig: {
      nav: [
        { text: "Guide", link: "/cli" },
        { text: "Architecture", link: "/architecture/overview" },
        { text: "Configuration", link: "/configuration/README" },
        { text: "Plugins", link: "/plugins/plugin-context" },
        { text: "Contributing", link: "/contribution-docs/README" },
        {
          text: "Build Journal",
          link: "https://github.com/FarzamMohammadi/the-engineer/tree/main/docs/archived",
        },
      ],
      sidebar: [
        {
          text: "Guide",
          items: [
            { text: "CLI Reference", link: "/cli" },
            { text: "Writing Tickets", link: "/usage-guide/writing-tickets" },
            { text: "Dashboard", link: "/usage-guide/dashboard" },
            { text: "Troubleshooting", link: "/troubleshooting" },
          ],
        },
        {
          text: "Architecture",
          items: [
            { text: "Overview", link: "/architecture/overview" },
            { text: "Three-Tier Model", link: "/architecture/three-tier-model" },
            { text: "Pipeline", link: "/architecture/pipeline" },
            { text: "Scheduling & Dispatch", link: "/architecture/scheduling-dispatch" },
            { text: "Observability", link: "/architecture/observability" },
          ],
        },
        {
          text: "Configuration",
          items: [
            { text: "Overview", link: "/configuration/README" },
            { text: "Daemon", link: "/configuration/daemon" },
            { text: "Orchestrator", link: "/configuration/orchestrator" },
            { text: "Safety", link: "/configuration/safety" },
            { text: "Workspace", link: "/configuration/workspace" },
            { text: "People", link: "/configuration/people" },
          ],
        },
        {
          text: "Plugins",
          items: [
            { text: "Plugin Context", link: "/plugins/plugin-context" },
            { text: "Trigger", link: "/plugins/trigger/README" },
            { text: "Communication", link: "/plugins/communication/README" },
            { text: "Agent", link: "/plugins/agent/README" },
            { text: "Git Hosting", link: "/plugins/git-hosting/README" },
          ],
        },
        {
          text: "User Flows",
          items: [
            { text: "Task Intake", link: "/user-flows/task-intake/overview" },
            { text: "Communication", link: "/user-flows/communication/overview" },
            { text: "PR Management", link: "/user-flows/pr-management/overview" },
            { text: "Post-Execution Review", link: "/user-flows/post-execution-review/overview" },
          ],
        },
        {
          text: "Concepts",
          items: [
            { text: "Philosophy", link: "/philosophy" },
            { text: "Constraints", link: "/constraints" },
            { text: "Assumptions", link: "/assumptions" },
            { text: "The Engineer Persona", link: "/the-engineer-persona" },
          ],
        },
        {
          text: "Contributing",
          items: [
            { text: "Overview", link: "/contribution-docs/README" },
            { text: "Authoring a Plugin", link: "/contribution-docs/how-tos/plugins/authoring" },
            { text: "Operator Setup", link: "/contribution-docs/how-tos/setup/operator-setup" },
            { text: "Observability", link: "/contribution-docs/how-tos/observability" },
            { text: "Zod Schemas", link: "/contribution-docs/how-tos/zod-schemas" },
            { text: "Coding Standards", link: "/coding-standards" },
            { text: "Anti-Patterns", link: "/anti-patterns" },
          ],
        },
      ],
      socialLinks: [{ icon: "github", link: "https://github.com/FarzamMohammadi/the-engineer" }],
      search: { provider: "local" },
      editLink: {
        pattern: "https://github.com/FarzamMohammadi/the-engineer/edit/main/docs/:path",
        text: "Edit this page on GitHub",
      },
    },
  }),
);
