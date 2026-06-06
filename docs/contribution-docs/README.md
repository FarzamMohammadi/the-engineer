# Contribution Docs

Patterns, practices, and how-tos for contributing to The Engineer.

Code changes. Architecture evolves. These docs capture the **how and why** behind the patterns we use — so contributors (human or agent) can work with the codebase confidently without reverse-engineering conventions from source.

Add a how-to when a system has non-obvious conventions that a contributor would need to understand before making changes. If the pattern is self-evident from reading the code, skip the doc.

## How-Tos

- **[Operator Setup](how-tos/setup/operator-setup.md)** — the executable, agent-drivable runbook for standing up a working, configured daemon for a human end to end: interview their tooling, map it to shipping plugins, assemble a seed, start, pause only for secrets with precise instructions, and verify. Covers the case where a tool has no plugin yet — author one mid-setup and walk back into the flow.
- **[Authoring a Plugin](how-tos/plugins/authoring.md)** — the one executable, agent-drivable methodology for building a plugin behind any of the four adapter types (trigger, communication, git-hosting, agent), from identifying the adapter through contributing it back. Each step sends you into the matching [adapter contract](../plugins/) for the specifics.
- **[Observability](how-tos/observability.md)** — how to emit spans, decisions, and observations the dashboard renders.
- **[Zod Schemas](how-tos/zod-schemas.md)** — the schema-first conventions every config and contract type follows.
