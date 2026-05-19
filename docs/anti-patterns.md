# Anti-Patterns

Things that look productive but hurt the project. If you catch yourself doing any of these, stop and reconsider.

---

## YAGNI Without Confirmation

Don't add features, abstractions, or infrastructure the user didn't ask for. "We might need this later" is not a reason to build it now. If you see a genuine future need, raise it — then wait for confirmation before acting. The user decides scope, not the agent.

## Gold-Plating

Shipping "working" on time beats shipping "perfect" late. But "working" is not "done" — the [Definition of Done](philosophy.md#definition-of-done) is the bar, not personal taste. The tension is real: meet the bar fully, then stop. Don't polish beyond what the checklist demands.

## Assuming Over Asking

When uncertain — ask. When "pretty sure" — still ask. Assumptions compound silently. A wrong assumption that ships is harder to fix than a question that takes 30 seconds. This applies to scope, implementation approach, naming, architecture, and especially edge cases.

## Premature Optimization

Don't optimize before measuring. Write clear, correct code first. Profile when performance is actually a problem — not when you imagine it might be. The bottleneck is almost never where you think it is.

## Cargo Culting

Don't copy patterns without understanding why they exist in this codebase. A pattern that solved a problem in module A may be unnecessary in module B. Every pattern earns its place through the specific problem it solves here — not because it exists elsewhere.

## Scope Creep Without Consent

Expanding task scope without explicit user agreement is a violation of trust. If you discover adjacent work that needs doing, surface it — don't silently include it. The user decides whether to expand scope, defer it, or ignore it.

## Dogmatic Rule Following

Nothing in this project is 100% absolute (except [Plugin Blindness](philosophy.md#plugin-blindness--core-sees-only-adapters) and [Trust Through Restraint](philosophy.md#trust-through-restraint) — those are invariants). Every other rule is a strong default. When a specific case deliberately calls for deviation, deviate — but document why. The test: "Is this deviation intentional and justified, or am I being lazy?"

## Silent Decisions

Making decisions on behalf of the user without communicating them is the fastest way to lose alignment. Every non-trivial decision gets surfaced: what you chose, why, and what alternatives existed. The user is always the compass.
