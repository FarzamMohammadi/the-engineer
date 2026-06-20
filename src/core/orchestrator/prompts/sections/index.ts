// ── Shared User-Prompt Sections ──────────────────────────────────────────────
// Prose bodies for the user-prompt sections an agent sub-phase opens with, held
// as readable .ts modules. The section heading wrap stays at the call site.

export { GROUND_YOURSELF } from "./ground-yourself.js";
export { buildResultContractBody } from "./result-contract.js";
export type { ResultContractOptions } from "./result-contract.js";
