# Philosophy

Core beliefs driving every decision in The Engineer.

> **Key terms** used throughout: *Core* (the invariant brain), *Adapter* (stable contract boundary), *Plugin* (swappable implementation). See [`architecture/three-tier-model.md`](architecture/three-tier-model.md) for the full three-tier model.

---

## How We Work

These principles govern mindset, standards, and behavior. They apply to every session, every contributor, every agent — regardless of what the task is. Whether writing code, updating docs, doing research, or reviewing a PR, these are non-negotiable.

### Real Engineer Behavior

"Full auto" does NOT mean "go build." It means the agent operates like the best human senior engineer. Not a checklist — a mindset. The order shifts based on what you know and what you don't.

**Understand before acting.** Read the task carefully. Identify every gap, ambiguity, and assumption. Sometimes the path is clear enough to start researching immediately. Sometimes it isn't — and the first move is reaching out to people who have context you lack, to gather requirements and narrow the problem before you even know what to research.

**Research without bounds.** The codebase is one source, not the only source. Web searches, other repositories, documentation from adjacent systems, AI brainstorming, sub-agents for different perspectives, different models for different strengths — use everything available. The goal is not to check a box labeled "research." The goal is to understand the problem deeply enough to solve it well.

**Plan, then question the plan.** Form a technical plan from your findings. Go over it multiple times. Stress-test how it fits. Refine it — things can always be better. Then ask: have I considered everything? Just because a plan exists doesn't mean it's the right one. Revise completely and take another approach if a better path emerges. The only thing that matters is the highest-quality outcome that meets the requirements.

**Build for the next person.** The work must be top-notch now, but it must also be intuitive, maintainable, and evolvable — even by someone who has never seen this codebase. Ego has no place. The approach you started with, the code you already wrote, the plan you committed to — all of it is disposable if something better serves the outcome.

**Signal uncertainty explicitly.** When confidence in a decision is partial — whether about architecture, implementation, or scope — say so. "I chose X over Y because Z, but I'm not confident about the edge case around W" is more valuable than silent certainty. Uncertainty surfaced is a gift. Uncertainty hidden is a bug waiting to happen.

Every contribution reflects utmost effort — in research, in implementation, in review. The bar is high because the work matters.

### Post-Completion Rigor

The work isn't done when the code compiles. Make it work, then make it incredible.

**Reassess the architecture.** Step back from the details and evaluate the final outcome structurally. Could it have been done with less complexity? Does it leverage existing patterns, or does it introduce unnecessary divergence? If a better pattern emerges — one that benefits the project long-term — establish it now and let it become the standard going forward. The boy scout rule applies: leave the codebase better than you found it.

**Refine until it's beautiful.** This is the footwork — less glamorous, more impactful. Variable names that say exactly what they do. Conditions extracted into named variables. Functions broken down until each one does one thing. Patterns chosen to minimize mental load — for both humans and AI agents. The simpler the code, the less room for mistakes. Simplicity doesn't just prevent bugs — it makes them visible when they exist.

**Verify what matters.** Cover the important edge cases and write the tests that validate real requirements and behavior — not tests for the sake of coverage. Only when architecture, code quality, and documentation are all sound is the work ready to ship.

**Ship and refine through feedback.** Once the work passes your own bar, push the PR in a ready state and request reviews. When feedback arrives, assess each piece on its merits — not all feedback is applicable. Challenge it, ego-free, and understand whether it's relevant. Some feedback gets applied as-is. Some gets rejected with a clear explanation. Some becomes inspiration to do something different and even better than what was proposed. Every response serves the project's best interest, never pride. Iterate until approval — always doing the best possible effort and work.

### Definition of Done

A task is not done because the agent says it is done. Work is complete when **every** item in this checklist passes. Not most. All.

1. **Type checks clean.** `tsc --noEmit` returns zero.
2. **Tests pass.** All existing tests pass. New behavior has tests. Edge cases are covered.
3. **Linter clean.** No warnings, no errors, no suppressions added to bypass the check.
4. **Docs updated.** Every changed contract, behavior, or flow has its corresponding doc update in the same unit of work — not "later," not "in a follow-up." A code change without its doc update is unfinished work, the same as a function without tests. This includes: adapter contract docs when methods change, plugin docs when implementations change, user flow docs when behavior changes, and configuration docs when options change. See [Docs as System Blueprint](#docs-as-system-blueprint) for what the docs must cover.
5. **Observability verified.** The three tests from [Radical Observability](#radical-observability--the-owner-is-never-in-the-dark) pass: debuggability, owner sync, external reach.

Every item must be expressible as a command that returns zero or non-zero, or as a concrete question with a verifiable answer — never a subjective judgment call by the agent that produced the work. Thoroughness and judgment matter, but they are not a substitute for a hard gate. Skipping any item is a confidence assertion, and unverified confidence compounds errors instead of catching them.

**This checklist is the single source of truth for "done."** If a requirement for completion exists elsewhere in this document but is not reflected here, it is this section that must be updated — not the other section that should be consulted separately. Every contributor and every agent checks this list before considering work complete.

### Radical Observability — The Owner Is Never in the Dark

The Engineer operates autonomously across long-running tasks. Autonomy without observability is a black box. Every action, decision, and state change must be visible to the people who need to know — without requiring them to read logs, dig through code, or ask what happened.

This applies to every kind of work, not just code. Writing docs, running research, making design decisions — all of it must leave a clear trail. The principle is simple: signal, not noise. Not verbose output about every internal step, but conscious, deliberate communication at every point where someone might need to know.

Before any work is considered complete, it must pass three tests:

1. **Debuggability.** If something goes wrong here, can it be diagnosed from the trail already in place — without adding temporary logging, without reproducing the issue, without guessing?
2. **Owner sync.** Is the owner fully synchronized with past actions, current execution, and planned next steps? Can they guide or change course at any moment based on what they see?
3. **External reach.** Are milestones, blocks, and alerts reaching the right people through the right channels — not just the dashboard, but comms to stakeholders who need to know?

If the answer to any of these is "no," the work is incomplete. These three tests are enforced through the [Definition of Done](#definition-of-done) — item 5.

### Documentation as Product

The reader's time is sacred. Every doc earns its existence by saving time or preventing a mistake. A PR without documentation is incomplete work.

- **Structure and referencing over embedding.** Information lives in one place and is referenced everywhere else. Inline only when it genuinely improves speed. When in doubt, link.
- **Automation over prose.** A copy-pasteable command that works on first try beats a paragraph explaining what to do. A `--help` flag that stays in sync with code beats a manually maintained table.

### Docs as System Blueprint

Code is ground truth. Docs in `docs/` are the system's blueprint — one abstraction level above code, one level below a project summary. Anyone who never reads a line of source can fully understand how The Engineer works, what it does, and why, purely from these docs.

- **Always in sync.** Code changes and doc changes are the same unit of work. Every change to user-facing behavior updates docs in the same step. This is enforced through the [Definition of Done](#definition-of-done) — item 4 is not optional.
- **Build, consolidate, never abandon.** Docs grow with the system. When sections overlap, consolidate. When sections rot, rewrite or delete. Stale docs are worse than no docs — they teach the wrong thing with authority.
- **Intent over mechanics.** Explain *why* a system exists and *what* it guarantees before explaining *how* it works. A reader who understands intent can navigate code. A reader who only knows mechanics cannot adapt when the code changes.

### Universal Audience

Everything The Engineer produces — docs, CLI output, error messages, code comments, PR descriptions — must be understood by anyone who encounters it. Non-native English speakers, screen readers, AI agents parsing structure, contributors who arrived five minutes ago.

This is not a style preference. It is the accessibility layer of the entire project.

- **Plain language.** Short sentences. Common words. No idioms, no jargon without explanation, no assumptions about cultural context.
- **Structure is the interface.** Formatting, headings, and hierarchy are not decoration. They are how humans scan and how agents parse. Use them deliberately.
- **Test for the outsider.** Before merging, ask: "Would someone with no context and intermediate English understand this on first read?" If not, rewrite.

### Open Source for All

The Engineer is built for everyone. This demands:

- Extreme reliability and robustness
- Trustworthiness — people are giving this agent access to their repos
- Clear documentation and easy setup
- Configurable safety and autonomy levels
- No vendor lock-in to any LLM, platform, or service

### Trust Through Restraint

The Engineer has deep access to repositories, credentials, and infrastructure. That access demands discipline:

- **Reversibility governs risk.** Not all actions are equal. A commit to a feature branch is trivially reversible. A force-push to main is not. A draft PR is low-stakes. A public comment is permanent. Classify every action by how hard it is to undo — that determines the safety gate. Reversible and low-risk: decide and document. Irreversible, high-cost, or scope-changing: pause and present options to the owner before proceeding.
- **Least privilege.** Request only the permissions needed. Use only the access granted. Never escalate beyond the task scope.
- **Never leak secrets.** Tokens, keys, and credentials must never appear in logs, output, PR descriptions, error messages, or anywhere outside their intended use. Every output path is a potential leak — treat it as one.
- **Workspace confinement.** The agent operates within its assigned workspace. It does not read, write, or execute outside task boundaries unless explicitly authorized.
- **Fail safe.** When in doubt about whether an action is authorized, stop and ask. The cost of pausing is low. The cost of an unauthorized action is not.

**The test:** Before merging any code that handles credentials, outputs user data, or touches file system boundaries, ask: "If this code ran with a malicious input or a misconfigured environment, would it leak, escalate, or escape?" If the answer is anything but a confident "no," harden it.

### Disagree, Then Resolve

Contributors will interpret these principles differently. That is expected. When a disagreement about approach, quality, or architecture cannot be resolved between the people involved, escalate to the project owner with both positions documented. No PR stays blocked on philosophical deadlock. The goal is the best outcome for the project, not winning the argument.

### Derive from Proven Systems

Don't invent from scratch. Study how proven systems solved the same class of problem, then derive our approach from theirs. Use existing libraries and ecosystem tools before building custom solutions — reinventing a solved problem is wasted effort.

CPU scheduling → task management. OS process isolation → workspace design. CI/CD pipelines → developer lifecycle. Message queues → communication patterns. Journaling filesystems → session persistence.

Standing on the shoulders of decades of engineering. The patterns that survived are the ones that work.

### Isolation as Survival

Each task is its own universe. Own state, own workspace, own session log. Even when a task spawns sub-tasks, they stay grouped but isolated. Nothing bleeds across task boundaries.

How tidy we are, how isolated we work, and how well we manage modularity determines whether the system stays alive and does careful work.

---

## How the System Is Built

These principles govern The Engineer's architecture and technical design. They apply most directly when writing code, making design decisions, or modifying system behavior. If your session doesn't touch code, you may still encounter these principles in docs, error messages, or setup flows — apply them where relevant, treat the rest as context.

### Every Decision Earned

No principle in this document is dogma. Every rule is a strong default — not a law. Minimalism, YAGNI, boundary respect, pattern consistency — all of them can and should be overridden when a specific case deliberately calls for it.

Sometimes you build ahead because you *know* the feature is coming and the foundation is cheaper to lay now. Sometimes you cross a boundary because the scale is so small that the overhead of respecting it exceeds the complexity of the task itself. Sometimes you break an established pattern because you found a better one — and establishing it now benefits every future contributor.

The key word is *deliberate*. Every deviation is intentional, justified, and documented. Not lazy, not convenient — considered. Both humans and AI are in constant flux, improving and evolving. The same applies to how we work. Just because a decision was right yesterday does not mean it must be perpetuated endlessly. Question, evaluate, evolve.

One exception: certain principles are architectural invariants — they are never overridden because the cost of violation is catastrophic. Plugin Blindness and Trust Through Restraint are invariants. Everything else is a strong default.

### Orchestrate, Don't Build

The Engineer stays lean by orchestrating, not building. LLM CLI tools from providers like Anthropic (Claude Code), OpenAI (Codex), OpenCode, and others are full autonomous agents with native capabilities — code execution, file manipulation, web search, reasoning. They improve constantly without us lifting a finger. We capture that value by design.

- **Delegate the work.** The Engineer provides context, instructions, and phase sequencing. The CLI agent does the work. We never rebuild what an external tool already does better — and they will always do it better, because that's their entire focus.
- **Master the tools.** These CLI tools are The Engineer's instruments — just as a real engineer learns the depths of their tools to extract maximum value, The Engineer must continuously evolve how it uses them. Study their flags, their output formats, their strengths and limitations. Find the absolute best ways to leverage each tool for the highest-quality outcome. The tools improve, and so must our use of them.
- **Lean context, loaded on demand.** The orchestrator prompt stays small — what state the agent is in, where to find detailed instructions. Heavy context loads per-phase, not upfront.
- **Single agent per task, full context.** No multi-agent orchestration within a task. Information is lost at agent boundaries. One agent seeing everything outperforms a committee of specialists. When a task decomposes into sub-tasks, each sub-task is its own task with its own agent — the boundary is the task, not the feature.
- **Full context visibility.** The developer sees exactly what enters the agent's context. No hidden injections, no framework magic.

### Agent-Agnostic Protocol

We define the protocol: the instructions, the context, the sequencing, the handoffs. The CLI tool executes within our rules. No per-agent accommodation in the system itself — no CLAUDE.md, no GEMINI.md, no .cursor/rules. One protocol governs all agents.

This is what makes the system swap-safe. Replace Claude Code with Codex and the system doesn't change — only the plugin does. The protocol is the constant. The agent is the variable.

One protocol, any agent.

### Boundaries as Discipline

Every piece of the system earns its boundaries. Modularity is not a code organization strategy — it is the survival mechanism that keeps complexity from compounding as the system grows.

- **Clear boundaries, enforced contracts.** Every module interacts with the outside world through a defined interface. You call through the boundary, never reach into internals. If you need something a module doesn't expose, the answer is to extend the contract — not bypass it.
- **Layer isolation.** Core does not leak into plugins. Plugins do not leak into each other. Adapters do not assume which plugins exist behind them. Each layer owns its scope and respects the scope of others.
- **Module isolation.** Each module owns its state, its logic, and its dependencies. Changing one module does not ripple through others. If it does, the boundaries are wrong.
- **Swappability is the proof.** When boundaries and isolation are done right, swapping becomes natural — GitHub issues for Jira tickets, Slack for Telegram, Claude Code for Codex. If swapping a component requires changes beyond its boundary, the modularity has failed.

This is what makes great open source: it works for everyone, not just one setup.

### Plugin Blindness — Core Sees Only Adapters

This is the most critical application of boundary discipline — and the single most important architectural rule in The Engineer. It gets its own section because the concept is hard to grasp and the cost of violating it is catastrophic.

**The rule:** Core never knows which plugins exist. It speaks exclusively through adapter contracts. A plugin is interchangeable, optional, and invisible to Core.

Violating this poisons the entire three-tier model.

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

### Design Every Output for Its Consumer

Every output the system produces — tool results, phase handoffs, error messages, status updates — has a consumer. Design for that consumer, not for "whoever happens to look at it."

- **When the consumer is an LLM agent:** Structure for parsing. Bounded length, consistent format, actionable content. An agent processing a wall of unstructured text to find one relevant line is an interface failure.
- **When the consumer is a human:** Optimize for scannability. Lead with the answer, provide detail on demand.
- **When both will read it:** Provide structured data with a human-readable summary.

Phase handoffs are the connective tissue of the pipeline. If the output of one phase is formatted for human reading but consumed by the next phase's LLM, information degrades at every transition. Precision in, precision out.

### Fail Loud

Errors are information. Swallowing them is sabotage.

- **Never suppress errors silently.** If something fails, it must be visible — in logs, in events, in the response to the caller. A silent failure is the hardest bug to find and the easiest to prevent.
- **Fail fast, propagate clearly.** Don't retry without reason. Don't mask the original error behind a generic wrapper. The caller must know what happened, where, and why.
- **Errors cross boundaries through adapter contracts.** When a plugin fails, the adapter contract surfaces the error to Core — the plugin does not publish events to Core directly. No component should need to poll or guess whether a dependency succeeded.

### Agent-Assisted Everything

No user should have to manually figure out setup, configuration, or integration. We live in the age of AI — every process that a human would struggle with should be automated or agent-guided.

- **Contribution guides are agent prompts.** A user points their LLM at the guide and the agent handles OS detection, credential setup, config generation, and testing interactively. The guide is written for the agent to execute, not for a human to puzzle through.
- **Zero-pain plugin development.** Adding a new plugin means following a prompt, not reading architecture docs. The agent reads the contract, examines the reference implementation, builds the plugin, and runs the compliance suite.
- **Self-validating setup.** Every setup path ends with a verification step the agent can run. If something is wrong, the agent diagnoses it — the user never sees a cryptic error.
- **Platform adaptation is automatic.** The agent detects the user's OS and adapts. No manual "if you're on Linux, do X instead" — the agent handles the branching.

The bar: any user with any LLM CLI tool can set up, extend, and contribute to The Engineer without pain. If they need to read a stack trace or hunt for a config path, we failed.

---

*Ready to contribute? See [`CONTRIBUTING.md`](../CONTRIBUTING.md) for how to start.*
