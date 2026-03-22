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

## Derive from Proven Systems

Don't invent from scratch. Study how proven systems solved the same class of problem, then derive our approach from theirs.

CPU scheduling → task management. OS process isolation → workspace design. CI/CD pipelines → developer lifecycle. Message queues → communication patterns. Journaling filesystems → session persistence.

Standing on the shoulders of decades of engineering. The patterns that survived are the ones that work.

## Isolation as Survival

Each task is its own universe. Own state, own workspace, own session log. Even when a task spawns sub-tasks, they stay grouped but isolated. Nothing bleeds across task boundaries.

How tidy we are, how isolated we work, and how well we manage modularity determines whether the system stays alive and does careful work.
