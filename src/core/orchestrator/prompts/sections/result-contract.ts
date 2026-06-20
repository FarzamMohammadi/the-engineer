import path from "node:path";

/** Options describing where an agent sub-phase records its work. */
export interface ResultContractOptions {
  /** Absolute directory holding the deliverable and `session-result.json`. */
  readonly directory: string;
  /** Deliverable filename written alongside the result (e.g. `requirements.md`). */
  readonly deliverable: string;
  /** Optional one-line hint describing the `details` payload this step should include. */
  readonly detailsHint?: string;
}

/** Build the "Where To Put Your Work" body: the deliverable path and the `session-result.json` contract. */
export function buildResultContractBody(options: ResultContractOptions): string {
  const detailsLine = options.detailsHint
    ? `  "details": { ${options.detailsHint} }`
    : '  "details": { }            // optional, omit if you have nothing to add';
  return [
    `Write your deliverable to \`${path.join(options.directory, options.deliverable)}\` — accumulate across re-runs, do not overwrite prior context.`,
    `Then write \`${path.join(options.directory, "session-result.json")}\` with this shape:`,
    "",
    "```json",
    "{",
    '  "status": "ok" | "needs_human" | "failed",',
    '  "summary": "<one honest line on what happened>",',
    detailsLine,
    "}",
    "```",
    "",
    "Use both paths exactly as written, including the full `thoughts/<id>/<phase>/` prefix — do not shorten, relativize, or relocate them. A result written anywhere else is invisible to The Engineer, so the step fails even when your work was sound.",
    "",
    "- `ok` — you did the job; The Engineer proceeds.",
    "- `needs_human` — a person must answer before work can continue; put the question(s) in your deliverable. The Engineer reaches out and resumes when they reply.",
    "- `failed` — you could not complete the step; explain why in `summary`.",
    "",
    "Report what happened. Never name or choose the next phase — that is The Engineer's to decide.",
  ].join("\n");
}
