# Agent Adapter Plugin Setup

Use this prompt with any AI coding CLI to interactively set up an agent plugin for The Engineer.

---

## Prompt

```
Read the file at docs/plugins/agent/README.md for full technical context on The Engineer's agent adapter contract.

Then help me set up an agent plugin by doing the following:

1. Ask me which coding agent CLI I want to use (Claude Code, OpenCode, Gemini CLI, or other).

2. Detect my operating system and note any platform-specific considerations (credential access for quota tracking varies by OS — macOS uses Keychain, Linux/Windows use file-based credentials).

3. Verify the CLI tool is installed by running its version command (e.g. `claude --version`, `opencode --version`, `gemini --version`).

4. If the CLI tool already has a built-in plugin (check the per-plugin pages under docs/plugins/agent/ — e.g. claude-code-agent, opencode-agent, gemini-cli-agent), skip to step 6 — just configure it.

5. If building a NEW plugin for a CLI tool that doesn't have one yet:

   a. Research the CLI's output format by running it with a trivial prompt and structured output flags. Capture the real NDJSON/JSON output. Identify: which event type carries content, which carries cost/tokens, what flags enable non-interactive mode, whether there's a --system-prompt flag, and critically — how the CLI reads from stdin (prompts MUST be piped via stdin, never as CLI args, because orchestrator prompts are 50KB+).

   b. Read the reference implementations for the closest match:
      - Claude Code: src/plugins/agent/claude-code-agent/claude-code-agent.ts (NDJSON, cost+tokens+quota)
      - OpenCode: src/plugins/agent/opencode-agent/opencode-agent.ts (NDJSON, cost+tokens, no quota)
      - Gemini CLI: src/plugins/agent/gemini-cli-agent/gemini-cli-agent.ts (NDJSON, tokens only, no cost)

   c. Create the new plugin following the same patterns:
      - config.ts with a Zod schema (use z.output<> for the type)
      - plugin.ts extending AgentAdapter (doRun, getCapabilities, doInitialize, doShutdown, doHealthCheck)
      - CRITICAL: pipe prompt via stdin (child.stdin.write), NEVER as a CLI arg — orchestrator prompts are 50KB+ and will hit OS arg length limits
      - If the CLI has no --system-prompt flag, prepend with [SYSTEM INSTRUCTIONS]...[END SYSTEM INSTRUCTIONS] delimiters
      - Copy the buildAgentEnv() env isolation pattern into the plugin
      - Export the output parser function for unit testing
      - plugin.test.ts with mock CLI scripts + contract compliance suite (runContractSuite)

   d. Register in src/plugins/builtin.ts:
      - Import the plugin class
      - Add a manifest entry (set enabled: false for opt-in plugins)
      - Add a factory function

   e. Run the contract compliance suite and all tests: pnpm test

6. Walk me through configuration:
   - Ask for any provider-specific settings (model, timeout, CLI path if non-default)
   - Check if credentials/authentication are set up for the CLI tool
   - Generate the plugin config at ~/.engineer/config/plugins/<plugin-id>.yaml (one file per plugin, e.g. claude-code-agent.yaml)

7. If quota/usage tracking is available for this CLI tool, set that up too — explain what data will be visible on the dashboard and what won't be available.

Ask me questions as you go. Don't assume — verify each step before moving to the next.
```
