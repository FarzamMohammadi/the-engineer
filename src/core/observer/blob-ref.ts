/**
 * The blob-reference naming convention — the single source of truth shared by every server-side
 * reader of observation blob refs.
 *
 * A blob ref is stored as a string value under a key ending in `_blob` inside an observation's
 * `input`/`output` JSON: the pipeline writes `prompt_blob`/`result_blob`/`transcript_blob`
 * (see `agent-step.ts`) and agent-activity rows spill `text_blob`/`input_blob`/`output_blob`
 * (see `agent-activity/mapping.ts`). The ref's value is `<2-hex-prefix>/<64-hex-sha256>`
 * (see {@link "./blob-store.ts"}).
 *
 * Both the data-lifecycle orphan sweep (which blob files to keep) and the OTLP exporter (which
 * attributes to turn into drill-down URLs) used to hardcode their own key list, and both drifted
 * to keys nothing writes — silently deleting blobs / never URL-izing them. Matching the *convention*
 * here, in one place, means a new `*_blob` field is recognized everywhere with no reader changes.
 */

/** The suffix that marks an observation `data` key as carrying a blob reference. */
export const BLOB_REF_KEY_SUFFIX = "_blob";

/** A blob ref value: `<2-hex-prefix>/<64-hex-sha256>` (see `blob-store.ts`). */
export const BLOB_REF_PATTERN = /^[a-f0-9]{2}\/[a-f0-9]{64}$/;

/** True when `key` names a blob-ref slot by the `*_blob` convention. */
export function isBlobRefKey(key: string): boolean {
  return key.endsWith(BLOB_REF_KEY_SUFFIX);
}

/** True when `value` is a well-formed blob ref string. Failed captures write `""`, which is excluded. */
export function isBlobRef(value: unknown): value is string {
  return typeof value === "string" && BLOB_REF_PATTERN.test(value);
}
