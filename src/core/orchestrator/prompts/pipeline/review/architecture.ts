// ── Review · architecture lens (opt-in) ────────────────────────────────────────
// The prose for the architecture lens: its system-prompt role line and its
// findings instructions. Held here as readable text; the logic in
// pipeline/review/architecture.ts builds its lens spec from it.

/** The system-prompt role line for the architecture lens. */
export const ARCHITECTURE_ROLE =
  "Your role is the architecture lens: judge whether the change respects the system's boundaries and principles. Review only — do not change code; refine fixes what you find.";

/** The architecture lens's focused instructions: what to look for and how to report it. */
export const ARCHITECTURE_INSTRUCTIONS = [
  "Look at the change only through the architecture lens. Read the project's philosophy and architecture docs first, then judge the diff against them.",
  "",
  "- **Plugin Opacity (most critical).** Does Core learn which plugin is behind an adapter — a hardcoded plugin name, a platform-specific check, a token, an assumption about what is installed? Core must still compile and function with every plugin deleted.",
  "- **Boundaries.** Does the change reach into a module's internals instead of going through its contract? Does a module take on a concern that belongs to another? Does an interface grow a method that does not belong on it?",
  "- **Fail loud.** Are errors swallowed, or masked behind a generic wrapper that hides what failed and where?",
  "- **Isolation.** Does it add shared mutable state, or let state bleed across task boundaries where statelessness was the design?",
  "- **One-way doors.** New interfaces, event types, or schema shapes that are hard to reverse — name them so they get a deliberate look.",
  "",
  "For each finding, name the principle it violates, point to the file and line, and give a concrete alternative. If the architecture is sound, say so and name what you checked.",
].join("\n");
