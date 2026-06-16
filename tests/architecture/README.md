# Architecture Boundary Tests

Build-time guards for the project's **whole-codebase architectural invariants** — the rules that must hold across every file, not the behavior of any one component. Each test here scans the source and fails the build the moment an architectural boundary is crossed. They are the enforcement behind [Plugin Opacity](../../docs/philosophy.md#plugin-opacity--core-sees-only-adapters) and the [three-tier model](../../docs/architecture/three-tier-model.md).

| Guard | Enforces | Mechanism |
|-------|----------|-----------|
| [`tier-import-rules.test.ts`](tier-import-rules.test.ts) | The three-tier import model — adapters never import Core, Core never imports plugins or test code, the SDK barrel never re-exports Core internals. **The structural half of Plugin Opacity.** | Walks the **import graph** of every source file. |
| [`plugin-opacity.test.ts`](plugin-opacity.test.ts) | No platform name (`"github"`, `"gitlab"`, `"slack"`, …) hardcoded as a string literal anywhere in `src/core/`. **The semantic half of Plugin Opacity.** | Scans the **source text** of every `src/core/` file. |

The two are complementary, not redundant: a hardcoded channel like `=== "github"` crosses no import boundary, so the structural guard cannot see it — that exact gap is how one once reached Core. They stay separate files because they use different mechanisms, and the import-rules guard is broader than opacity (it covers all three-tier import rules).

## What does *not* belong here

Only whole-codebase invariants. Tests of a single component's *behavior* — even opacity-adjacent behavior like the registry returning empty when no plugin of a type is installed (graceful degradation) — live with that component under `tests/unit/`. The dividing line: if the test reads one module, it is a unit test; if it scans the whole tree for a global property, it is a boundary test and belongs here.
