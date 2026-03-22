# Plugin Setup

The Engineer uses a plugin system for all external integrations — LLM providers, git hosting, communication, triggers, and tools. Each plugin implements an adapter contract that Core consumes generically.

**You don't need to understand the code to set up plugins.** Point your LLM CLI at this file, and it will walk you through setup interactively — detecting your OS, asking which providers you use, configuring credentials, and testing the result.

---

## How to Set Up Plugins

1. Open your LLM CLI tool (Claude Code, OpenCode, Gemini CLI, etc.)
2. Point it to this file: `Read contribution-docs/how-tos/plugins/README.md`
3. It will guide you through each adapter type below, one at a time
4. For each, it reads the adapter's `prompt.md` and interactively sets up your plugin

---

## Available Adapters

### LLM Adapter

Connects The Engineer to an LLM CLI tool for inference. The Engineer is the agent — the LLM just receives prompts and returns text.

**Supported CLIs:** Claude Code, OpenCode, Gemini CLI (others can be added)

**Setup prompt:** [`llm-adapter/prompt.md`](llm-adapter/prompt.md)
**Technical reference:** [`llm-adapter/README.md`](llm-adapter/README.md)

---

## Platform Notes

Current plugins are built and tested on **macOS**. Some platform-specific functionality (credential access, Keychain integration) may not work on Linux or Windows without adaptation. Each adapter's `prompt.md` will detect your OS and guide you through platform-appropriate setup, or flag what needs manual adaptation.

See `implementation-docs/future-considerations.md` for the planned OS-based plugin selection system.

---

## For Plugin Developers

Each adapter directory contains:

| File | Purpose |
|------|---------|
| `README.md` | Full technical reference — schemas, contract, code examples, testing |
| `prompt.md` | Self-contained LLM prompt for interactive plugin setup |

To add a new adapter type: create a new directory under `plugins/`, add both files, and list it in this README.
