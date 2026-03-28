# Philosophy

Core beliefs driving every decision in The Engineer.

---

## Agent-Agnostic Protocol

We define our own protocol. Any agent that enters this system follows our rules. No per-agent accommodation (no CLAUDE.md, GEMINI.md, .cursor/rules). The system dictates. The agent adapts.

One protocol, any agent.

## Minimalism

Inspired by the PI agent toolkit:

- **Small orchestrator prompt.** The core system prompt stays lean — what state the agent is in, where to find detailed instructions. Heavy context loads on-demand based on current phase.
- **Few broad tools.** Bash is the meta-tool. The agent composes complex operations from primitives.
- **Single agent, full context.** No multi-agent orchestration. Information is lost at agent boundaries. One agent seeing everything outperforms a committee of specialists.
- **Full context visibility.** The developer sees exactly what enters the model's context. No hidden injections, no framework magic.
- **Self-extension.** When the agent needs a capability it doesn't have, it builds it.

## Real Engineer Behavior

"Full auto" does NOT mean "go build." It means the agent operates like the best human senior engineer:

- Receives a task and reads it carefully
- Identifies every gap, ambiguity, and assumption
- Reaches out to real people through real channels to gather requirements and clarify
- Researches the codebase deeply before touching anything
- Forms a technical plan and communicates it to stakeholders
- Only then: executes

The agent is never lazy. Diligent, thorough, best-possible work.

## Post-Completion Rigor

The work isn't done when the code compiles:

- Runs analysis on its own work
- Refactors for clarity and quality
- Creates the PR as a draft first
- Self-reviews the diff as a code reviewer would
- Requests reviews from repo owners / codeowners
- Iterates on feedback until approved

Many phases. Many steps. All modular, all configurable.

## Modular Everything

Every component follows the registry pattern. Triggers, communication channels, LLM providers, tools, and workflow phases are all plugins:

- Swap GitHub issues for Jira tickets
- Swap Slack for Teams or Telegram
- Swap Claude for GPT or a local model
- Add, remove, or reorder workflow phases

This is what makes great open source: it works for everyone, not just one setup.

## Open Source for All

The Engineer is built for everyone. This demands:

- Extreme reliability and robustness
- Trustworthiness — people are giving this agent access to their repos
- Clear documentation and easy setup
- Configurable safety and autonomy levels
- No vendor lock-in to any LLM, platform, or service

## Documentation as Product

The reader's time is sacred. Every doc earns its existence by saving time or preventing a mistake. This applies to The Engineer's own output just as much — when the agent ships a feature, it updates the relevant docs. A PR without documentation is incomplete work.

- **Structure and referencing over embedding.** Information lives in one place and is referenced everywhere else. Inline only when it genuinely improves speed. When in doubt, link.
- **Automation over prose.** A copy-pasteable command that works on first try beats a paragraph explaining what to do. A `--help` flag that stays in sync with code beats a manually maintained table.
- **Docs ship with features.** Every change to user-facing behavior updates docs in the same step — not "later."

## Agent-Assisted Everything

No user should have to manually figure out setup, configuration, or integration. We live in the age of AI — every process that a human would struggle with should be automated or agent-guided.

- **Contribution guides are agent prompts.** A user points their LLM at the guide and the agent handles OS detection, credential setup, config generation, and testing interactively. The guide is written for the agent to execute, not for a human to puzzle through.
- **Zero-pain plugin development.** Adding a new plugin means following a prompt, not reading architecture docs. The agent reads the contract, examines the reference implementation, builds the plugin, and runs the compliance suite.
- **Self-validating setup.** Every setup path ends with a verification step the agent can run. If something is wrong, the agent diagnoses it — the user never sees a cryptic error.
- **Platform adaptation is automatic.** The agent detects the user's OS and adapts. No manual "if you're on Linux, do X instead" — the agent handles the branching.

The bar: any user with any LLM CLI tool can set up, extend, and contribute to The Engineer without pain. If they need to read a stack trace or hunt for a config path, we failed.

## Plugin Blindness — Core Sees Only Adapters

This is the single most important architectural discipline in The Engineer. Violating it poisons the entire three-tier model.

**Core never knows which plugins exist.** It never references a plugin by name, never checks for a specific plugin, never assumes a particular plugin is loaded. Core speaks exclusively through adapter contracts. A plugin is interchangeable, optional, and invisible to Core.

**What this means in practice:**

- No hardcoded plugin names in Core or setup flows. Not `"github-trigger"`, not `"telegram-comm"`, not any specific plugin ID. If you find yourself writing `if (pluginId === "github-trigger")`, you are violating the architecture.
- No hardcoded tokens, URLs, or platform-specific checks in Core. Not `GITHUB_TOKEN`, not `TELEGRAM_BOT_TOKEN`. If Core needs to validate connectivity, it calls the adapter's `healthCheck()` — it does not know what the adapter checks internally.
- No assumptions about which plugins are installed. The system must function correctly with zero plugins of a given adapter type (graceful degradation), one plugin, or many. If a trigger adapter has no plugins, the daemon simply receives no trigger events. It does not crash, warn about missing GitHub config, or prompt for a token.
- Detection, setup, and configuration derive from plugin manifests and adapter type metadata — never from hardcoded lists. When the setup flow asks "which trigger do you want?", it reads from the registry's discovered plugins, not from a hardcoded array of known options.

**Why this matters so profoundly:**

The entire value proposition of the three-tier model (see [`architecture/three-tier-model.md`](architecture/three-tier-model.md)) is that plugins are the ecosystem — swappable, community-contributed, independently developed. The moment Core contains knowledge about a specific plugin, every future plugin must either (a) be known to Core (defeating the purpose) or (b) be a second-class citizen that Core doesn't accommodate. Both outcomes destroy extensibility.

The adapter contract IS the integration boundary. Everything Core needs from the outside world is defined there: `TriggerAdapter.poll()`, `CommunicationAdapter.sendMessage()`, `LLMAdapter.runInference()`. The plugin behind the contract is irrelevant to Core. GitHub today, GitLab tomorrow, a custom webhook next week — Core's code does not change.

**The test:** Before merging any code, ask: "If I deleted every plugin and replaced them with completely different implementations for different platforms, would Core still compile and function?" If the answer is no, the code violates this principle.

See [`architecture/three-tier-model.md`](architecture/three-tier-model.md) § How the Tiers Interact and § Extensibility by Design for the full architectural specification.

## Derive from Proven Systems

Don't invent from scratch. Study how proven systems solved the same class of problem, then derive our approach from theirs.

CPU scheduling → task management. OS process isolation → workspace design. CI/CD pipelines → developer lifecycle. Message queues → communication patterns. Journaling filesystems → session persistence.

Standing on the shoulders of decades of engineering. The patterns that survived are the ones that work.

## Isolation as Survival

Each task is its own universe. Own state, own workspace, own session log. Even when a task spawns sub-tasks, they stay grouped but isolated. Nothing bleeds across task boundaries.

How tidy we are, how isolated we work, and how well we manage modularity determines whether the system stays alive and does careful work.
