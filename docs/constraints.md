# Deliberate Constraints

Some boundaries in The Engineer are not limitations of the design — they are scope decisions made
on purpose. We narrowed the problem so we could refine a smaller surface to a higher standard.

This document is the home for those self-imposed constraints. Each one is **deliberate**, **scoped
to v1**, and stays in place **until it is deliberately lifted**. None of them are architectural
invariants (those live in [`philosophy.md`](philosophy.md) — Plugin Blindness and Trust Through
Restraint). Everything here is a chosen narrowing that a future version may widen.

---

## Single-User

**The Engineer assumes the human side is exactly one person — the owner.** They assign the work,
answer the questions, and review the output. A team of one.

### Why

The people directory once modeled a multi-role team — owner, reviewer, domain expert, stakeholder —
each separately addressable. v1 deliberately collapses the human side to a single person. The
narrower scope is the point: one well-handled contact, refined fully, beats four half-handled roles.
A future version (for example, a paid teams or pro edition) may reintroduce multiple people and
roles. Until then, the owner is the whole team.

### Assumed, not required

Configuring an owner is **assumed but not required**. The Engineer does not force you to set one and
does not refuse to start without one.

If no contact is configured, The Engineer **warns** — because without someone to reach, it cannot
involve you when it needs you:

- It cannot reach you when a task is **blocked**.
- It cannot ask you for **additional context**.
- It cannot get a **decision from you during requirements gathering**.

The daemon still runs and still does its work. It simply has no way to pull a human into the loop.
The warning makes that trade-off visible instead of letting it surprise you at the first blocker.

### What this does NOT relax

The constraint is on the *number of humans*, and nothing else:

- **One user ≠ one task.** The single owner still has many concurrent tasks. Per-task isolation,
  correlation, and the full pipeline run independently for each one.
- **One user ≠ one plugin.** This constrains the *human*, not the *integrations*. Many trigger,
  communication, hosting, and LLM plugins coexist. [Plugin Blindness](philosophy.md#plugin-blindness--core-sees-only-adapters)
  is untouched — Core still never knows which plugins exist.

### Where it shows up

- **`people.yaml`** — configures the owner (role `owner`) and their contact channels.
- **Startup** — The Engineer logs a warning if no owner is configured, if more than one person is
  configured (only the owner is reached in v1), or if an owner's channel has no installed
  communication plugin to deliver it.
- **`engineer doctor`** — the **People Directory** category reports the same checks on demand.
- **Outreach** — every message to a human targets the owner.
