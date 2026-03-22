# LLM Adapter Plugin Setup

Use this prompt with any LLM CLI to interactively set up an LLM plugin for The Engineer.

---

## Prompt

```
Read the file at contribution-docs/how-tos/plugins/llm-adapter/README.md for full technical context on The Engineer's LLM adapter contract.

Then help me set up an LLM plugin by doing the following:

1. Ask me which LLM CLI tool I want to use (Claude Code, OpenCode, Gemini CLI, or other).

2. Detect my operating system and note any platform-specific considerations (credential access for quota tracking varies by OS — macOS uses Keychain, Linux/Windows use file-based credentials).

3. Verify the CLI tool is installed by running its version command (e.g. `claude --version`, `opencode --version`, `gemini --version`).

4. Walk me through configuration:
   - Ask for any provider-specific settings (model, timeout, CLI path if non-default)
   - Check if credentials/authentication are set up for the CLI tool
   - Generate the plugin config for ~/.engineer/config/plugins.yaml

5. If building a NEW plugin (not Claude Code which is built-in):
   - Read the source of the reference implementation at src/plugins/llm/claude-code-llm/claude-code-llm.ts
   - Create the new plugin following the same patterns:
     a. Extend LLMAdapter from src/adapters/llm.ts
     b. Implement doInfer() — spawn the CLI, parse output, return InferenceResult
     c. Implement getCapabilities() — model_id + feature flags
     d. Implement getQuotaStatus() if the CLI exposes rate limit data
     e. Create config.ts with a Zod schema
     f. Create engineer.plugin.yaml manifest
     g. Register in src/plugins/builtin.ts
   - Run the contract compliance suite to validate: test/helpers/contract-suites/llm-contract.ts

6. Test the setup by running a simple inference call through The Engineer.

7. If quota/usage tracking is available for this CLI tool, set that up too — explain what data will be visible on the dashboard and what won't be available.

Ask me questions as you go. Don't assume — verify each step before moving to the next.
```
