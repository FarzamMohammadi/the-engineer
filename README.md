# The Engineer

An autonomous software engineering agent that works like a real engineer — not a code generator.

It receives tasks, gathers requirements from real people, researches codebases, plans, executes, self-reviews, and ships pull requests. It runs continuously, listens for triggers, and communicates through real channels like Slack, GitHub, and Teams.

## Principles

- **Agent-agnostic** — works with any LLM (Claude, GPT, Gemini, local models). No vendor lock-in.
- **Real engineer behavior** — gathers requirements, asks questions, clarifies ambiguity before writing a line of code.
- **Modular everything** — triggers, communication channels, LLM providers, tools, and workflow phases are all pluggable via a registry pattern.
- **Minimal by design** — inspired by the PI philosophy. Small system prompts, few broad tools, single agent with full context. No framework bloat.
- **Post-completion rigor** — analysis, refactoring, draft PR, self-review, request reviews, iterate on feedback.
- **Open source for all** — reliable, robust, trustable, and configurable for any team or individual.

## Status

Architecture and planning phase. No code yet — every decision is being made deliberately before implementation begins.

## License

TBD
