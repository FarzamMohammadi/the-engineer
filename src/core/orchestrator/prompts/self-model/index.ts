// ── Agent Self-Model ─────────────────────────────────────────────────────────
// The agent's identity, held as readable .ts prose modules. PERSONA is the static
// identity (who it is + how it works), pre-joined in reading order. MY_ASSIGNMENT
// is the "my brief" doc, kept separate because a later step injects the owner's
// live setup into it before it reaches the agent.

import { HOW_I_WORK } from "./how-i-work.js";
import { THE_ENGINEER } from "./the-engineer.js";

export { MY_ASSIGNMENT } from "./my-assignment.js";

/** The static self-model: who the agent is and how it works, joined in reading order. */
export const PERSONA = [THE_ENGINEER, HOW_I_WORK].join("\n\n");
