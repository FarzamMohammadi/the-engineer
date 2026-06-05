import { z } from "zod";

// ── Complexity Enum ────────────────────────────────────────────────────────────────

export const ComplexitySchema = z.enum(["trivial", "moderate", "complex"]);
export type Complexity = z.infer<typeof ComplexitySchema>;

/** Constant enum values for Complexity. Use instead of raw strings. */
export const Complexities = ComplexitySchema.enum;

// ── Phase Directory Constants ────────────────────────────────────────────────────

/**
 * Subdirectory names inside the thoughts/ directory — one per pipeline phase.
 * Shared between WorkspaceManager (directory creation) and the pipeline sub-phases (file routing).
 */
export const PHASE_DIRECTORIES = ["requirements", "research", "planning", "execution", "review", "delivery"] as const;
