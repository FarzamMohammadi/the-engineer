const BASE_URL = "/api";

/** Outcome of a blob fetch — kept explicit so the viewer can distinguish "empty ref" from "404" from "loaded". */
export type BlobResult =
  | { readonly status: "empty" }
  | { readonly status: "loaded"; readonly text: string }
  | { readonly status: "not_found" }
  | { readonly status: "error"; readonly message: string };

/** True when a blob ref is a real `prefix/hash` pair worth fetching (the agent span stores `""` when absent). */
export function isBlobRef(ref: string | null | undefined): ref is string {
  if (ref == null || ref === "") {
    return false;
  }
  const slash = ref.indexOf("/");
  return slash > 0 && slash < ref.length - 1;
}

/**
 * Fetch blob text from `GET /api/blob/:prefix/:hash`. The endpoint returns raw text on success (not JSON,
 * so this bypasses `apiFetch`) and a 404 JSON body when the ref is unknown. An empty/malformed ref short
 * circuits to `{ status: "empty" }` without a network call, so the viewer renders a placeholder instead.
 */
export async function fetchBlob(ref: string | null | undefined): Promise<BlobResult> {
  if (!isBlobRef(ref)) {
    return { status: "empty" };
  }

  let response: Response;
  try {
    response = await fetch(`${BASE_URL}/blob/${ref}`);
  } catch (error) {
    return { status: "error", message: error instanceof Error ? error.message : "Network error" };
  }

  if (response.status === 404) {
    return { status: "not_found" };
  }
  if (!response.ok) {
    return { status: "error", message: `${String(response.status)} ${response.statusText}` };
  }

  const text = await response.text();
  return { status: "loaded", text };
}
