# Philosophy

Core beliefs driving every decision in The Engineer. Stated once. Referenced always.

---

## Agent-Agnostic Protocol

We do not accommodate individual agents. We define our own protocol. Any agent that starts in this repo follows our rules. No per-agent files (CLAUDE.md, GEMINI.md, .cursor/rules, etc.). The repo dictates. The agent adapts.

The exact protocol (boot file, memory system, etc.) will be designed during architecture. The principle is fixed: one protocol, any agent.

## PI-Inspired Minimalism

Inspired by the PI agent toolkit's philosophy:
- Small orchestrator prompt. The core system prompt stays lean — it knows who the agent is, what state it's in, and where to find detailed instructions. Heavy context (guardrails, phase guides, how-tos) lives in reference docs loaded on-demand based on current phase. The prompt is small, but effective knowledge at any moment is exactly what's needed.
- Few broad tools, not many narrow ones. Bash is the meta-tool. The agent composes complex operations from primitives.
- Single agent with full context. No multi-agent orchestration. Information is lost at agent boundaries. One agent seeing everything outperforms a committee of specialists.
- Full context visibility. The developer sees exactly what enters the model's context. No hidden injections, no framework magic.
- Self-extension. When the agent needs a capability it doesn't have, it builds it.

## Real Engineer Behavior

"Full auto" does NOT mean "go build." It means the agent operates like the best human senior engineer you've ever worked with:
- Receives a task and reads it carefully
- Identifies every gap, ambiguity, and assumption in the requirements
- Reaches out to REAL PEOPLE through real channels (Slack, GitHub, WhatsApp, Teams) to gather requirements, ask questions, and clarify
- Researches the codebase deeply before touching anything
- Forms a technical plan
- Communicates that plan to stakeholders
- Only then: executes

The agent is never lazy. It does diligent, thorough, best-possible work — because that's what a real engineer does.

## Post-Completion Rigor

The work isn't done when the code compiles. After implementation, the agent:
- Runs analysis on its own work
- Refactors for clarity and quality
- Creates the PR as a DRAFT first
- Self-reviews the diff as if it were a code reviewer
- Requests reviews from repo owners / codeowners
- Iterates on feedback until approved

Many phases. Many steps. All modular, all configurable.

## Modular Everything

Every component follows the registry pattern. Triggers, communication channels, LLM providers, tools, and workflow phases are all plugins. This means:
- Anyone can swap GitHub issues for Jira tickets
- Anyone can swap Slack for Teams or WhatsApp
- Anyone can swap Claude for GPT or a local model
- Anyone can add, remove, or reorder workflow phases

This is what makes great open source: it works for everyone, not just one group.

## Open Source for All

The Engineer is built for everyone. This demands:
- Extreme reliability and robustness
- Trustworthiness — people are giving this agent access to their repos
- Clear documentation and easy setup
- Configurable safety and autonomy levels
- No vendor lock-in to any LLM, platform, or service

## Say It Once

Intentions, philosophies, and goals are documented once in these files. We execute from the docs. Nobody repeats themselves. If something changes, we update the doc. The docs are the source of truth.

## Collaboration

Farzam and the agent are partners. This is not a command-and-control relationship. It's a collaboration where each watches the other's back. Every decision is made together. The agent brings research, analysis, and technical depth. Farzam brings vision, judgment, and final authority.

## No Premature Artifacts

Do not build things before they're designed. Implementation artifacts (boot files, memory systems, config files, code) come OUT of architectural decisions, not before them. Design first, build from the design.
