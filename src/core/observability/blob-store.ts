/**
 * Content-addressable blob store for LLM prompt/response storage.
 *
 * Git object model applied to observability: content is SHA-256 hashed,
 * stored as files on disk, and referenced by hash in the database.
 * Automatic dedup — identical content (e.g. system prompts) stored once.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// ── Pure Functions ───────────────────────────────────────────────────────────

/** Compute SHA-256 hex hash of content. */
export function computeHash(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

/** Convert a blob reference to its filesystem path. */
export function refToPath(ref: string, blobsDir: string): string {
  return join(blobsDir, `${ref}.txt`);
}

/** Convert a hash to a blob reference (first 2 chars as subdirectory). */
export function hashToRef(hash: string): string {
  return `${hash.slice(0, 2)}/${hash}`;
}

// ── BlobStore ────────────────────────────────────────────────────────────────

export class BlobStore {
  private readonly blobsDir: string;

  constructor(tracesDir: string) {
    this.blobsDir = join(tracesDir, "blobs");
    mkdirSync(this.blobsDir, { recursive: true });
  }

  /**
   * Store content and return its blob reference.
   * If the blob already exists (content-addressable dedup), skips writing.
   */
  store(content: string): string {
    const hash = computeHash(content);
    const ref = hashToRef(hash);
    const filePath = refToPath(ref, this.blobsDir);

    if (!existsSync(filePath)) {
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, content, "utf-8");
    }

    return ref;
  }

  /** Read content by blob reference. Returns null if the blob is missing. */
  read(ref: string): string | null {
    const filePath = refToPath(ref, this.blobsDir);
    if (!existsSync(filePath)) {
      return null;
    }
    return readFileSync(filePath, "utf-8");
  }

  /** Check if a blob exists. */
  exists(ref: string): boolean {
    return existsSync(refToPath(ref, this.blobsDir));
  }
}
