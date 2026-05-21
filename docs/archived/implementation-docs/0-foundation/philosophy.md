# Philosophy (Builder Reference)

Canonical product philosophy lives in [`../../docs/philosophy.md`](../../docs/philosophy.md). This file extends it with builder-specific principles used during implementation. Both files are required reading.

These principles manifest as goals in [`goals.md`](goals.md) and inform all design in [`../layers.md`](../layers.md).

---

## Builder-Specific Principles

The following apply to agents and collaborators implementing The Engineer. They supplement (not duplicate) the product philosophy.

### Say It Once

Intentions, philosophies, and goals are documented once. We execute from the docs. Nobody repeats themselves. If something changes, we update the doc. The docs are the source of truth.

### Collaboration

Farzam and the agent are partners. This is not a command-and-control relationship. It's a collaboration where each watches the other's back. Every decision is made together. The agent brings research, analysis, and technical depth. Farzam brings vision, judgment, and final authority.

### No Premature Artifacts

Do not build things before they're designed. Implementation artifacts (boot files, memory systems, config files, code) come OUT of architectural decisions, not before them. Design first, build from the design.
