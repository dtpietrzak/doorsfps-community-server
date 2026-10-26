/**
 * Runtime-facing replay lifecycle persistence.
 *
 * Production: {@link HttpReplayLifecycleClient} → authority `/api/replays/*`.
 * Tests: {@link InMemoryReplayLifecycleClient} (optional local blob store for
 * finalize fault injection). Community never opens replays.sqlite.
 */

import type {
  ReplayCounterPatch,
  ReplayLifecyclePublicRow,
  ReplayLifecycleRow,
  ReplayLifecycleUpdatePatch,
  ReplayLifecycleUpdatableStatus,
} from "../shared/replay/replayLifecycle.ts";
import {
  type ReplayBlobStore,
  replayBlobObjectName,
} from "./ReplayBlobStore.ts";

export type {
  ReplayCounterPatch,
  ReplayLifecyclePublicRow,
  ReplayLifecycleRow,
  ReplayLifecycleUpdatePatch,
  ReplayLifecycleUpdatableStatus,
};

export type ReplayFinalizeResult = {
  fileSizeBytes: number;
  filePath?: string | null;
};

export interface ReplayLifecycleClient {
  insertRecording(runtimeMatchId: string): Promise<ReplayLifecycleRow>;
  getByRuntimeMatchId(
    runtimeMatchId: string,
  ): Promise<ReplayLifecycleRow | null>;
  getById(id: number): Promise<ReplayLifecycleRow | null>;
  update(id: number, patch: ReplayLifecycleUpdatePatch): Promise<void>;
  /**
   * Authority (or in-memory stand-in) writes verified bytes and stamps
   * `finalized`. Sole path to `finalized` from the runtime.
   */
  finalize(args: {
    rowId: number;
    runtimeMatchId: string;
    bytes: Uint8Array;
  }): Promise<ReplayFinalizeResult>;
}

// ─── In-memory (unit tests) ─────────────────────────────────────────────────

export type InMemoryReplayLifecycleClientOptions = {
  /**
   * When set, finalize() puts through this store (enables 8.6 fault-injection
   * tests). When omitted, bytes are kept in memory and filePath is synthetic.
   */
  blobStore?: ReplayBlobStore;
  /** Override clock for created/updated stamps. */
  now?: () => string;
};

export class InMemoryReplayLifecycleClient implements ReplayLifecycleClient {
  #rows = new Map<number, ReplayLifecycleRow>();
  #byMatch = new Map<string, number>();
  #nextId = 1;
  #blobStore: ReplayBlobStore | undefined;
  #memoryBytes = new Map<number, Uint8Array>();
  #now: () => string;

  constructor(opts: InMemoryReplayLifecycleClientOptions = {}) {
    this.#blobStore = opts.blobStore;
    this.#now = opts.now ??
      (() => new Date().toISOString().replace(/\.\d{3}Z$/, ".000Z"));
  }

  /** Test helper: all rows newest-last. */
  listAll(): ReplayLifecycleRow[] {
    return [...this.#rows.values()].sort((a, b) => a.id - b.id);
  }

  /** Test helper: bytes retained when no blobStore. */
  getMemoryBytes(rowId: number): Uint8Array | null {
    return this.#memoryBytes.get(rowId) ?? null;
  }

  // deno-lint-ignore require-await -- async keeps throws as rejections
  async insertRecording(runtimeMatchId: string): Promise<ReplayLifecycleRow> {
    const existingId = this.#byMatch.get(runtimeMatchId);
    if (existingId != null) {
      const existing = this.#rows.get(existingId);
      if (existing) return structuredClone(existing);
    }
    const ts = this.#now();
    const row: ReplayLifecycleRow = {
      id: this.#nextId++,
      runtimeMatchId,
      status: "recording",
      createdAt: ts,
      updatedAt: ts,
      ticksObserved: 0,
      inputTicks: 0,
      eventTicks: 0,
      errorCount: 0,
      error: null,
      filePath: null,
      fileSizeBytes: null,
    };
    this.#rows.set(row.id, row);
    this.#byMatch.set(runtimeMatchId, row.id);
    return structuredClone(row);
  }

  // deno-lint-ignore require-await -- async keeps throws as rejections
  async getByRuntimeMatchId(
    runtimeMatchId: string,
  ): Promise<ReplayLifecycleRow | null> {
    const id = this.#byMatch.get(runtimeMatchId);
    if (id == null) return null;
    const row = this.#rows.get(id);
    return row ? structuredClone(row) : null;
  }

  // deno-lint-ignore require-await -- async keeps throws as rejections
  async getById(id: number): Promise<ReplayLifecycleRow | null> {
    const row = this.#rows.get(id);
    return row ? structuredClone(row) : null;
  }

  // deno-lint-ignore require-await -- async keeps throws as rejections
  async update(id: number, patch: ReplayLifecycleUpdatePatch): Promise<void> {
    if (patch.status === ("finalized" as ReplayLifecycleUpdatableStatus)) {
      throw new Error(
        "updateReplayLifecycle refuses status=finalized; use finalize",
      );
    }
    const row = this.#rows.get(id);
    if (!row) throw new Error(`replay row ${id} not found`);
    row.status = patch.status;
    if (patch.error !== undefined) row.error = patch.error;
    if (patch.counters) {
      row.ticksObserved = patch.counters.ticksObserved;
      row.inputTicks = patch.counters.inputTicks;
      row.eventTicks = patch.counters.eventTicks;
      row.errorCount = patch.counters.errorCount;
    }
    row.updatedAt = this.#now();
  }

  // deno-lint-ignore require-await -- async keeps throws as rejections
  async finalize(args: {
    rowId: number;
    runtimeMatchId: string;
    bytes: Uint8Array;
  }): Promise<ReplayFinalizeResult> {
    const row = this.#rows.get(args.rowId);
    if (!row) throw new Error(`replay row ${args.rowId} not found`);
    if (row.status !== "finalizing") {
      throw new Error(
        `finalize: row ${args.rowId} was not finalizing (status=${row.status})`,
      );
    }
    if (row.runtimeMatchId !== args.runtimeMatchId) {
      throw new Error("finalize: runtimeMatchId mismatch");
    }
    if (args.bytes.byteLength <= 0) {
      throw new Error("finalize: empty bytes");
    }

    const objectName = replayBlobObjectName(args.runtimeMatchId);
    let filePath: string;
    let fileSizeBytes: number;

    if (this.#blobStore) {
      try {
        this.#blobStore.put(objectName, args.bytes);
      } catch (err) {
        try {
          this.#blobStore.delete(objectName);
        } catch {
          // best-effort
        }
        throw err;
      }
      const size = this.#blobStore.size(objectName);
      if (
        !this.#blobStore.exists(objectName) ||
        size == null ||
        size !== args.bytes.byteLength
      ) {
        try {
          this.#blobStore.delete(objectName);
        } catch {
          // best-effort
        }
        throw new Error(
          `finalize-verify-failed: size-mismatch expected=${args.bytes.byteLength} got=${size}`,
        );
      }
      filePath = this.#blobStore.resolvePath(objectName);
      fileSizeBytes = size;
    } else {
      this.#memoryBytes.set(args.rowId, args.bytes.slice());
      filePath = `memory://${args.runtimeMatchId}.replay.json`;
      fileSizeBytes = args.bytes.byteLength;
    }

    row.status = "finalized";
    row.error = null;
    row.filePath = filePath;
    row.fileSizeBytes = fileSizeBytes;
    row.updatedAt = this.#now();
    return { fileSizeBytes, filePath };
  }
}

// ─── HTTP (official runtimes) ───────────────────────────────────────────────

export type HttpReplayLifecycleClientOptions = {
  baseUrl: string;
  credential: { id: string; secret: string };
  hostId: string;
  runtimeId: string;
  /** serverId bound in the credential / authentic catalog (usually === runtimeId). */
  serverId: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
};

function identityFields(fields: {
  hostId: string;
  runtimeId: string;
  serverId: string;
}): { hostId: string; runtimeId: string; serverId: string } {
  return {
    hostId: fields.hostId,
    runtimeId: fields.runtimeId,
    serverId: fields.serverId,
  };
}

export class HttpReplayLifecycleClient implements ReplayLifecycleClient {
  readonly #baseUrl: string;
  readonly #credential: { id: string; secret: string };
  readonly #hostId: string;
  readonly #runtimeId: string;
  readonly #serverId: string;
  readonly #fetchFn: typeof fetch;
  readonly #timeoutMs: number;

  constructor(opts: HttpReplayLifecycleClientOptions) {
    this.#baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.#credential = opts.credential;
    this.#hostId = opts.hostId;
    this.#runtimeId = opts.runtimeId;
    this.#serverId = opts.serverId;
    this.#fetchFn = opts.fetchFn ?? fetch;
    this.#timeoutMs = Math.max(1, opts.timeoutMs ?? 8_000);
  }

  #identity(): { hostId: string; runtimeId: string; serverId: string } {
    return identityFields({
      hostId: this.#hostId,
      runtimeId: this.#runtimeId,
      serverId: this.#serverId,
    });
  }

  async insertRecording(runtimeMatchId: string): Promise<ReplayLifecycleRow> {
    const data = await this.#requestJson("POST", "/api/replays/recording", {
      ...this.#identity(),
      runtimeMatchId,
    });
    return parseReplayRow(data.replay);
  }

  async getByRuntimeMatchId(
    runtimeMatchId: string,
  ): Promise<ReplayLifecycleRow | null> {
    const q = new URLSearchParams({
      ...this.#identity(),
    });
    const path =
      `/api/replays/by-match/${encodeURIComponent(runtimeMatchId)}?${q}`;
    try {
      const data = await this.#requestJson("GET", path);
      return parseReplayRow(data.replay);
    } catch (err) {
      if (err instanceof ReplayLifecycleHttpError && err.status === 404) {
        return null;
      }
      throw err;
    }
  }

  // deno-lint-ignore require-await -- async keeps throws as rejections
  async getById(id: number): Promise<ReplayLifecycleRow | null> {
    // No dedicated GET-by-id runtime route; callers use by-match or cache.
    // Keep interface parity for recorder fail paths — treat as unsupported.
    void id;
    return null;
  }

  async update(id: number, patch: ReplayLifecycleUpdatePatch): Promise<void> {
    await this.#requestJson("PATCH", `/api/replays/${id}`, {
      ...this.#identity(),
      status: patch.status,
      error: patch.error ?? null,
      counters: patch.counters,
    });
  }

  async finalize(args: {
    rowId: number;
    runtimeMatchId: string;
    bytes: Uint8Array;
  }): Promise<ReplayFinalizeResult> {
    const q = new URLSearchParams({
      ...this.#identity(),
      runtimeMatchId: args.runtimeMatchId,
    });
    const data = await this.#requestBytes(
      "POST",
      `/api/replays/${args.rowId}/finalize?${q}`,
      args.bytes,
    );
    const fileSizeBytes = Number(data.fileSizeBytes);
    if (!Number.isFinite(fileSizeBytes) || fileSizeBytes <= 0) {
      throw new Error("finalize: authority returned invalid fileSizeBytes");
    }
    return {
      fileSizeBytes,
      filePath: typeof data.filePath === "string" ? data.filePath : null,
    };
  }

  async #requestJson(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () =>
        controller.abort(
          new Error(`Replay lifecycle request timed out after ${this.#timeoutMs}ms`),
        ),
      this.#timeoutMs,
    );
    try {
      const res = await this.#fetchFn(`${this.#baseUrl}${path}`, {
        method,
        headers: {
          ...(body !== undefined
            ? { "content-type": "application/json" }
            : {}),
          authorization: `Bearer ${this.#credential.secret}`,
          "x-doors-credential-id": this.#credential.id,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const data = (await res.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      if (!res.ok) {
        throw new ReplayLifecycleHttpError(
          typeof data.error === "string" ? data.error : `HTTP ${res.status}`,
          res.status,
        );
      }
      return data;
    } finally {
      clearTimeout(timeout);
    }
  }

  async #requestBytes(
    method: string,
    path: string,
    bytes: Uint8Array,
  ): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () =>
        controller.abort(
          new Error(`Replay finalize timed out after ${this.#timeoutMs}ms`),
        ),
      this.#timeoutMs,
    );
    try {
      const res = await this.#fetchFn(`${this.#baseUrl}${path}`, {
        method,
        headers: {
          "content-type": "application/octet-stream",
          authorization: `Bearer ${this.#credential.secret}`,
          "x-doors-credential-id": this.#credential.id,
        },
        body: bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ) as ArrayBuffer,
        signal: controller.signal,
      });
      const data = (await res.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      if (!res.ok) {
        throw new ReplayLifecycleHttpError(
          typeof data.error === "string" ? data.error : `HTTP ${res.status}`,
          res.status,
        );
      }
      return data;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export class ReplayLifecycleHttpError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ReplayLifecycleHttpError";
    this.status = status;
  }
}

function parseReplayRow(raw: unknown): ReplayLifecycleRow {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("replay lifecycle: missing replay row in response");
  }
  const r = raw as Record<string, unknown>;
  const id = Number(r.id);
  const runtimeMatchId = typeof r.runtimeMatchId === "string"
    ? r.runtimeMatchId
    : "";
  const status = r.status;
  if (
    !Number.isFinite(id) ||
    !runtimeMatchId ||
    (status !== "recording" &&
      status !== "finalizing" &&
      status !== "finalized" &&
      status !== "failed" &&
      status !== "abandoned")
  ) {
    throw new Error("replay lifecycle: invalid replay row shape");
  }
  return {
    id,
    runtimeMatchId,
    status,
    createdAt: typeof r.createdAt === "string" ? r.createdAt : "",
    updatedAt: typeof r.updatedAt === "string" ? r.updatedAt : "",
    ticksObserved: Number(r.ticksObserved) || 0,
    inputTicks: Number(r.inputTicks) || 0,
    eventTicks: Number(r.eventTicks) || 0,
    errorCount: Number(r.errorCount) || 0,
    error: typeof r.error === "string" ? r.error : null,
    filePath: typeof r.filePath === "string" ? r.filePath : null,
    fileSizeBytes: typeof r.fileSizeBytes === "number" ? r.fileSizeBytes : null,
  };
}
