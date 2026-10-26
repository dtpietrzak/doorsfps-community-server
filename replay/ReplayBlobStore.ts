/**
 * Epic 8.6 — narrow blob interface for finalized replay files.
 *
 * Contract (see notes/replay/08-replay-recording/08-06-replay-finalization.md):
 * - All replay file I/O goes through ReplayBlobStore (scan-locked; no scattered
 *   Deno.write* at finalize/call sites).
 * - put() is atomic by construction: temp write → verify → rename → size.
 * - Day-one backend is a flat local directory the caller names. Authority
 *   picks it (`server-authority/replays/replayBlobDir.ts`). #16 reuses this
 *   interface for retention/serving; callers do not change.
 * - Names are `<runtimeMatchId>.replay.json`-class only — never caller paths.
 */

import { dirname, join } from "@std/path";

/** Safe object name: no path separators, no `..`, ends with `.replay.json`. */
const SAFE_BLOB_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}\.replay\.json$/;

export type ReplayBlobStore = {
  /** Atomic temp + rename put. Throws on write/verify failure. */
  put(name: string, bytes: Uint8Array): void;
  get(name: string): Uint8Array | null;
  exists(name: string): boolean;
  /** Byte length of an existing object, or null if missing. */
  size(name: string): number | null;
  /**
   * Read [start, endExclusive) without loading the rest of the object.
   * Null when the object is missing. 16.5 range serving uses this.
   */
  read(name: string, start: number, endExclusive: number): Uint8Array | null;
  delete(name: string): void;
  /** Absolute path stamped onto the `replays` row (after successful put). */
  resolvePath(name: string): string;
  /** Boot sweep: delete orphan `*.tmp.*` files. Returns count removed. */
  sweepTempFiles(): number;
  /** Base directory (for tests / orphan logging). */
  baseDir(): string;
};

export function assertSafeBlobName(name: string): void {
  if (!SAFE_BLOB_NAME.test(name)) {
    throw new Error(`replay-blob: rejected name ${JSON.stringify(name)}`);
  }
}

export function replayBlobObjectName(runtimeMatchId: string): string {
  const name = `${runtimeMatchId}.replay.json`;
  assertSafeBlobName(name);
  return name;
}

function ensureDir(path: string): void {
  try {
    Deno.mkdirSync(path, { recursive: true });
  } catch {
    // exists
  }
}

function randomTempSuffix(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Local-directory ReplayBlobStore. Parent dirs created on open.
 * Optional fault hooks exist only for 8.6 failure-injection tests.
 */
export type LocalReplayBlobStoreOptions = {
  /** Injected after temp write, before rename (tests). */
  beforeRename?: (tempPath: string, finalPath: string) => void;
  /** Injected to force a post-rename size lie (tests). */
  lieSizeAfterRename?: number;
};

export class LocalReplayBlobStore implements ReplayBlobStore {
  readonly #dir: string;
  readonly #beforeRename: LocalReplayBlobStoreOptions["beforeRename"];
  readonly #lieSizeAfterRename: number | undefined;

  constructor(
    dirPath: string,
    opts?: LocalReplayBlobStoreOptions,
  ) {
    this.#dir = dirPath;
    this.#beforeRename = opts?.beforeRename;
    this.#lieSizeAfterRename = opts?.lieSizeAfterRename;
    ensureDir(this.#dir);
  }

  baseDir(): string {
    return this.#dir;
  }

  resolvePath(name: string): string {
    assertSafeBlobName(name);
    return join(this.#dir, name);
  }

  put(name: string, bytes: Uint8Array): void {
    assertSafeBlobName(name);
    if (bytes.byteLength === 0) {
      throw new Error("replay-blob: refuse empty put");
    }
    ensureDir(this.#dir);
    const finalPath = this.resolvePath(name);
    const tempPath = `${finalPath}.tmp.${randomTempSuffix()}`;
    try {
      Deno.writeFileSync(tempPath, bytes);
      const written = Deno.statSync(tempPath).size;
      if (written !== bytes.byteLength) {
        throw new Error(
          `replay-blob: temp size mismatch wrote=${written} expected=${bytes.byteLength}`,
        );
      }
      this.#beforeRename?.(tempPath, finalPath);
      Deno.renameSync(tempPath, finalPath);
      const finalSize = this.#lieSizeAfterRename ?? Deno.statSync(finalPath).size;
      if (finalSize !== bytes.byteLength) {
        try {
          Deno.removeSync(finalPath);
        } catch {
          // best-effort
        }
        throw new Error(
          `replay-blob: final size mismatch got=${finalSize} expected=${bytes.byteLength}`,
        );
      }
    } catch (err) {
      try {
        Deno.removeSync(tempPath);
      } catch {
        // temp may already be gone after rename
      }
      throw err;
    }
  }

  get(name: string): Uint8Array | null {
    assertSafeBlobName(name);
    try {
      return Deno.readFileSync(this.resolvePath(name));
    } catch {
      return null;
    }
  }

  exists(name: string): boolean {
    assertSafeBlobName(name);
    try {
      return Deno.statSync(this.resolvePath(name)).isFile;
    } catch {
      return false;
    }
  }

  size(name: string): number | null {
    assertSafeBlobName(name);
    try {
      const st = Deno.statSync(this.resolvePath(name));
      return st.isFile ? st.size : null;
    } catch {
      return null;
    }
  }

  read(name: string, start: number, endExclusive: number): Uint8Array | null {
    assertSafeBlobName(name);
    if (!Number.isInteger(start) || start < 0) {
      throw new Error("replay-blob: bad range start");
    }
    if (!Number.isInteger(endExclusive) || endExclusive < start) {
      throw new Error("replay-blob: bad range end");
    }
    let file: Deno.FsFile;
    try {
      file = Deno.openSync(this.resolvePath(name), { read: true });
    } catch {
      return null;
    }
    try {
      const size = file.statSync().size;
      if (start > size) {
        throw new Error("replay-blob: range start past end");
      }
      const end = Math.min(endExclusive, size);
      const len = end - start;
      const buf = new Uint8Array(len);
      if (len === 0) return buf;
      file.seekSync(start, Deno.SeekMode.Start);
      let off = 0;
      while (off < len) {
        const n = file.readSync(buf.subarray(off));
        if (n === null) break;
        off += n;
      }
      if (off !== len) {
        throw new Error(
          `replay-blob: short read got=${off} expected=${len}`,
        );
      }
      return buf;
    } finally {
      file.close();
    }
  }

  delete(name: string): void {
    assertSafeBlobName(name);
    try {
      Deno.removeSync(this.resolvePath(name));
    } catch {
      // missing is fine
    }
  }

  sweepTempFiles(): number {
    let removed = 0;
    try {
      for (const entry of Deno.readDirSync(this.#dir)) {
        if (!entry.isFile) continue;
        // Orphan temps from crashed puts: `<name>.tmp.<rand>`
        if (!entry.name.includes(".tmp.")) continue;
        try {
          Deno.removeSync(join(this.#dir, entry.name));
          removed++;
        } catch {
          // best-effort
        }
      }
    } catch {
      // dir missing
    }
    return removed;
  }
}

/** Ensure parent of a file path exists (same discipline as storeFactory). */
export function ensureParentDir(path: string): void {
  const dir = dirname(path);
  ensureDir(dir);
}
