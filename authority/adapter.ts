/**
 * Runtime → authority adapter boundary (see authority.md).
 *
 * - NoopAuthorityAdapter: community / self-hosted servers (never write progression)
 * - HttpAuthorityAdapter: official authentic runtimes POST match reports
 *   (ranked ladder + unranked open match/win + kill/door XP)
 *
 * Match report body shape matches server-authority/db/matchReport.ts.
 * Scored (ranked end), unranked (open official end), and no_score (abandon)
 * are all live. Both paths use the same durable, retrying delivery worker.
 */

import type {
  HeatmapIngestBody,
  HeatmapMapWalkLayers,
} from "../shared/world/heatmaps.ts";
import type { MatchReportBody } from "../shared/replay/matchReport.ts";
import type {
  OpenReservationAckBody,
  OpenReservationAckResponse,
} from "../shared/fleet/openPlacement.ts";
import {
  HttpReplayLifecycleClient,
  type ReplayLifecycleClient,
} from "../replay/replayLifecycleClient.ts";
export type {
  MatchReportBody,
  MatchReportPlayer,
  MatchReportPlayerRef,
} from "../shared/replay/matchReport.ts";
export type {
  OpenReservationAckBody,
  OpenReservationAckResponse,
} from "../shared/fleet/openPlacement.ts";

/** Per-player progression fields returned by authority match-report. */
export type MatchReportProgressPlayer = {
  playerId?: number;
  /** Clerk id echoed from the report request. Join key for progression. */
  clerkUserId?: string;
  result?: string;
  mmrBefore?: number;
  mmrAfter?: number;
  mmrDelta?: number;
  skillBefore?: number;
  skillDelta?: number;
  skillAfter?: number;
  xpBefore?: number;
  xpEarned?: number;
  xpAfter?: number;
  coinsBefore?: number;
  coinsEarned?: number;
  coinsAfter?: number;
  teamSkillPot?: number;
  teamShare?: number;
  doorBonus?: number;
  shareOfPot?: number;
  performanceRank?: number;
  teamSize?: number;
};

/**
 * Pair one reported player with an authority progression row.
 * Rows that echo clerkUserId are joined on that id. A response with no
 * clerk ids (older authority) stays positional.
 */
export function matchReportProgressRow<T>(
  reportPlayers: readonly { clerkUserId?: string }[],
  rows: readonly T[],
  index: number,
): T | undefined {
  const reported = reportPlayers[index];
  if (!reported) return undefined;
  const keyed = rows.some((row) => clerkKey(clerkOf(row)) !== "");
  if (!keyed) return rows[index];
  const clerk = clerkKey(reported.clerkUserId);
  if (!clerk) return undefined;
  return rows.find((row) => clerkKey(clerkOf(row)) === clerk);
}

function clerkOf(row: unknown): string | undefined {
  if (!row || typeof row !== "object") return undefined;
  const value = (row as { clerkUserId?: unknown }).clerkUserId;
  return typeof value === "string" ? value : undefined;
}

function clerkKey(value: string | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

export type MatchReportResponse = {
  ok: boolean;
  matchId?: number;
  outcome?: string;
  error?: string;
  /** Per-player progression snapshot from authority when present. */
  players?: MatchReportProgressPlayer[];
};

export type HeatmapReportResponse = {
  ok: boolean;
  inserted?: number;
  error?: string;
};

export type { HeatmapIngestBody, HeatmapMapWalkLayers };

export interface AuthorityAdapter {
  /** True when this adapter can reach authority (official authentic mode). */
  readonly enabled: boolean;
  reportMatch(body: MatchReportBody): Promise<MatchReportResponse>;
  reportHeatmaps(body: HeatmapIngestBody): Promise<HeatmapReportResponse>;
  /**
   * Best-effort open seat reservation progress (S6-PR2). Optional so community
   * and older adapters remain compatible; not durable-outbox'd.
   */
  reportOpenReservationAck?(
    body: OpenReservationAckBody,
  ): Promise<OpenReservationAckResponse>;
  /**
   * Official-only replay lifecycle client (HTTP to authority). Noop / community
   * returns null — recording must not open SQLite on the game host.
   */
  createReplayLifecycleClient?(): ReplayLifecycleClient | null;
  /** Stop delivery work after a bounded flush; disk outbox remains replayable. */
  close?(flushMs?: number): Promise<void>;
}

/** Community / self-hosted servers — no progression writes. */
export class NoopAuthorityAdapter implements AuthorityAdapter {
  readonly enabled = false;

  reportMatch(_body: MatchReportBody): Promise<MatchReportResponse> {
    return Promise.resolve({ ok: true });
  }

  reportHeatmaps(_body: HeatmapIngestBody): Promise<HeatmapReportResponse> {
    return Promise.resolve({ ok: true, inserted: 0 });
  }

  reportOpenReservationAck(
    _body: OpenReservationAckBody,
  ): Promise<OpenReservationAckResponse> {
    return Promise.resolve({ ok: true, reservation: null, request: null });
  }

  createReplayLifecycleClient(): null {
    return null;
  }
}

/**
 * Official authentic runtime: post with separate match/heatmap credentials.
 */
export class HttpAuthorityAdapter implements AuthorityAdapter {
  readonly enabled = true;
  private readonly baseUrl: string;
  private readonly credentials: AuthorityAdapterCredentials;
  private readonly hostId: string;
  private readonly runtimeId: string;
  private readonly outboxDir: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly random: () => number;
  private readonly pending = new Map<string, PendingDelivery>();
  private readonly ready: Promise<void>;
  private worker: Promise<void> | null = null;
  private activeAbort: AbortController | null = null;
  private accepting = true;
  private closing = false;

  constructor(
    baseUrl: string,
    credentials: AuthorityAdapterCredentials,
    options: HttpAuthorityAdapterOptions = {},
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.credentials = credentials;
    this.hostId = options.hostId?.trim() ||
      Deno.env.get("DOORS_HOST_ID")?.trim() || "local";
    this.runtimeId = options.runtimeId?.trim() ||
      Deno.env.get("DOORS_RUNTIME_ID")?.trim() ||
      Deno.env.get("RANKED_SERVER_ID")?.trim() || "runtime";
    this.outboxDir = options.outboxDir?.trim() ||
      Deno.env.get("AUTHORITY_OUTBOX_DIR")?.trim() || ".authority-outbox";
    this.fetchFn = options.fetchFn ?? fetch;
    this.timeoutMs = Math.max(1, options.timeoutMs ?? 8_000);
    this.retryBaseMs = Math.max(1, options.retryBaseMs ?? 500);
    this.retryMaxMs = Math.max(this.retryBaseMs, options.retryMaxMs ?? 30_000);
    this.random = options.random ?? Math.random;
    this.ready = this.loadOutbox();
    void this.ready.then(() => this.kickWorker());
  }

  async reportMatch(body: MatchReportBody): Promise<MatchReportResponse> {
    const enriched: MatchReportBody = {
      ...body,
      hostId: this.hostId,
      runtimeId: this.runtimeId,
      runtimeMatchId: body.runtimeMatchId?.trim() || crypto.randomUUID(),
    };
    try {
      return await this.enqueue<MatchReportResponse>("match", enriched);
    } catch (err) {
      return {
        ok: false,
        error: `Authority outbox error: ${errorMessage(err)}`,
      };
    }
  }

  createReplayLifecycleClient(): ReplayLifecycleClient {
    return new HttpReplayLifecycleClient({
      baseUrl: this.baseUrl,
      credential: this.credentials.matchReport,
      hostId: this.hostId,
      runtimeId: this.runtimeId,
      serverId: this.runtimeId,
      fetchFn: this.fetchFn,
      timeoutMs: this.timeoutMs,
    });
  }

  async reportHeatmaps(
    body: HeatmapIngestBody,
  ): Promise<HeatmapReportResponse> {
    const enriched: HeatmapIngestBody = {
      ...body,
      hostId: this.hostId,
      runtimeId: this.runtimeId,
      batchId: body.batchId?.trim() || crypto.randomUUID(),
    };
    try {
      return await this.enqueue<HeatmapReportResponse>("heatmap", enriched);
    } catch (err) {
      return {
        ok: false,
        error: `Authority outbox error: ${errorMessage(err)}`,
      };
    }
  }

  /**
   * Fire-and-forget style reservation ack (no durable outbox). Seat holds are
   * already authoritative; this only advances connected_count / terminal state.
   */
  async reportOpenReservationAck(
    body: OpenReservationAckBody,
  ): Promise<OpenReservationAckResponse> {
    const enriched: OpenReservationAckBody = {
      ...body,
      hostId: body.hostId?.trim() || this.hostId,
      runtimeId: body.runtimeId?.trim() || this.runtimeId,
      serverId: body.serverId?.trim() || this.runtimeId,
    };
    const controller = new AbortController();
    const timeout = setTimeout(
      () =>
        controller.abort(
          new Error(`Authority request timed out after ${this.timeoutMs}ms`),
        ),
      this.timeoutMs,
    );
    try {
      const res = await this.fetchFn(
        `${this.baseUrl}/api/open/reservation-ack`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.credentials.matchReport.secret}`,
            "x-doors-credential-id": this.credentials.matchReport.id,
          },
          body: JSON.stringify(enriched),
          signal: controller.signal,
        },
      );
      const data = (await res.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      if (!res.ok) {
        return {
          ok: false,
          reservation: null,
          request: null,
          error: typeof data.error === "string"
            ? data.error
            : `HTTP ${res.status}`,
        };
      }
      return {
        ok: data.ok !== false,
        reservation: (data.reservation as OpenReservationAckResponse[
          "reservation"
        ]) ?? null,
        request:
          (data.request as OpenReservationAckResponse["request"]) ?? null,
        error: typeof data.error === "string" ? data.error : undefined,
      };
    } catch (err) {
      return {
        ok: false,
        reservation: null,
        request: null,
        error: errorMessage(err),
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  async close(flushMs = 2_000): Promise<void> {
    this.accepting = false;
    const deadline = Date.now() + Math.max(0, flushMs);
    while (this.pending.size > 0 && Date.now() < deadline) {
      this.kickWorker();
      await delay(Math.min(25, Math.max(1, deadline - Date.now())));
    }
    this.closing = true;
    this.activeAbort?.abort(new Error("Authority adapter closing"));
    if (this.worker) {
      await Promise.race([this.worker.catch(() => undefined), delay(50)]);
    }
  }

  private async enqueue<T extends MatchReportResponse | HeatmapReportResponse>(
    kind: DeliveryKind,
    body: MatchReportBody | HeatmapIngestBody,
  ): Promise<T> {
    if (!this.accepting) {
      return { ok: false, error: "Authority adapter is closing" } as T;
    }
    await this.ready;
    const deliveryId = kind === "match"
      ? (body as MatchReportBody).runtimeMatchId!
      : (body as HeatmapIngestBody).batchId!;
    const key = `${kind}:${deliveryId}`;
    const existing = this.pending.get(key);
    if (existing) {
      return await new Promise<T>((resolve) => {
        existing.waiters.push(resolve as DeliveryResolver);
      });
    }

    const delivery: PendingDelivery = {
      version: 1,
      kind,
      body,
      createdAt: new Date().toISOString(),
      attempts: 0,
      waiters: [],
    };
    await this.persist(delivery);
    this.pending.set(key, delivery);
    const result = new Promise<T>((resolve) => {
      delivery.waiters.push(resolve as DeliveryResolver);
    });
    this.kickWorker();
    return await result;
  }

  private async loadOutbox(): Promise<void> {
    await Deno.mkdir(this.outboxDir, { recursive: true });
    for await (const entry of Deno.readDir(this.outboxDir)) {
      if (!entry.isFile || !entry.name.endsWith(".json")) continue;
      try {
        const raw = JSON.parse(
          await Deno.readTextFile(`${this.outboxDir}/${entry.name}`),
        ) as StoredDelivery;
        if (
          raw.version !== 1 || (raw.kind !== "match" && raw.kind !== "heatmap")
        ) {
          continue;
        }
        const delivery: PendingDelivery = {
          ...raw,
          attempts: 0,
          waiters: [],
        };
        this.pending.set(this.deliveryKey(delivery), delivery);
      } catch (err) {
        console.warn(
          `[server] Ignoring unreadable authority outbox entry ${entry.name}: ${
            errorMessage(err)
          }`,
        );
      }
    }
    if (this.pending.size > 0) {
      console.log(
        `[server] Replaying ${this.pending.size} authority outbox item(s)`,
      );
    }
  }

  private kickWorker(): void {
    if (this.worker || this.closing || this.pending.size === 0) return;
    this.worker = this.processOutbox()
      .catch((err) => {
        console.warn(
          `[server] Authority outbox worker error: ${errorMessage(err)}`,
        );
      })
      .finally(() => {
        this.worker = null;
        if (!this.closing && this.pending.size > 0) this.kickWorker();
      });
  }

  private async processOutbox(): Promise<void> {
    while (!this.closing && this.pending.size > 0) {
      const delivery = this.pending.values().next().value as
        | PendingDelivery
        | undefined;
      if (!delivery) return;
      const result = await this.deliverOnce(delivery);
      if (result.retry) {
        delivery.attempts += 1;
        const exponential = Math.min(
          this.retryMaxMs,
          this.retryBaseMs * 2 ** Math.min(10, delivery.attempts - 1),
        );
        const jittered = Math.round(exponential * (0.75 + this.random() * 0.5));
        await delay(jittered);
        continue;
      }

      await this.removePersisted(delivery);
      this.pending.delete(this.deliveryKey(delivery));
      for (const resolve of delivery.waiters) resolve(result.response);
    }
  }

  private async deliverOnce(
    delivery: PendingDelivery,
  ): Promise<
    { retry: boolean; response: MatchReportResponse | HeatmapReportResponse }
  > {
    const path = delivery.kind === "match"
      ? "/api/ranked/match-report"
      : "/api/heatmaps/ingest";
    const credential = delivery.kind === "match"
      ? this.credentials.matchReport
      : this.credentials.heatmap;
    const controller = new AbortController();
    this.activeAbort = controller;
    const timeout = setTimeout(
      () =>
        controller.abort(
          new Error(`Authority request timed out after ${this.timeoutMs}ms`),
        ),
      this.timeoutMs,
    );
    try {
      const res = await this.fetchFn(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${credential.secret}`,
          "x-doors-credential-id": credential.id,
          "idempotency-key": this.deliveryKey(delivery),
        },
        body: JSON.stringify(delivery.body),
        signal: controller.signal,
      });
      const data = (await res.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      if (!res.ok) {
        const response = {
          ok: false,
          error: typeof data.error === "string"
            ? data.error
            : `HTTP ${res.status}`,
        };
        return {
          retry: res.status === 408 || res.status === 425 ||
            res.status === 429 ||
            res.status >= 500,
          response,
        };
      }
      if (delivery.kind === "match") {
        return {
          retry: false,
          response: {
            ok: true,
            matchId: typeof data.matchId === "number"
              ? data.matchId
              : undefined,
            outcome: typeof data.outcome === "string"
              ? data.outcome
              : undefined,
            players: Array.isArray(data.players)
              ? data.players as MatchReportProgressPlayer[]
              : undefined,
          },
        };
      }
      return {
        retry: false,
        response: {
          ok: true,
          inserted: typeof data.inserted === "number"
            ? data.inserted
            : undefined,
        },
      };
    } catch (err) {
      // Transport failures never discard the durable entry, including an
      // in-flight request aborted by graceful shutdown.
      return { retry: true, response: { ok: false, error: errorMessage(err) } };
    } finally {
      clearTimeout(timeout);
      if (this.activeAbort === controller) this.activeAbort = null;
    }
  }

  private deliveryKey(delivery: Pick<StoredDelivery, "kind" | "body">): string {
    const id = delivery.kind === "match"
      ? (delivery.body as MatchReportBody).runtimeMatchId
      : (delivery.body as HeatmapIngestBody).batchId;
    return `${delivery.kind}:${id}`;
  }

  private filePath(delivery: Pick<StoredDelivery, "kind" | "body">): string {
    return `${this.outboxDir}/${
      this.deliveryKey(delivery).replace(/[^a-zA-Z0-9_.-]/g, "_")
    }.json`;
  }

  private async persist(delivery: StoredDelivery): Promise<void> {
    await Deno.mkdir(this.outboxDir, { recursive: true });
    const path = this.filePath(delivery);
    const temp = `${path}.${crypto.randomUUID()}.tmp`;
    await Deno.writeTextFile(
      temp,
      JSON.stringify({
        version: delivery.version,
        kind: delivery.kind,
        body: delivery.body,
        createdAt: delivery.createdAt,
      }),
    );
    await Deno.rename(temp, path);
  }

  private async removePersisted(delivery: StoredDelivery): Promise<void> {
    try {
      await Deno.remove(this.filePath(delivery));
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
    }
  }
}

type DeliveryKind = "match" | "heatmap";
type DeliveryResolver = (
  value: MatchReportResponse | HeatmapReportResponse,
) => void;
type StoredDelivery = {
  version: 1;
  kind: DeliveryKind;
  body: MatchReportBody | HeatmapIngestBody;
  createdAt: string;
};
type PendingDelivery = StoredDelivery & {
  attempts: number;
  waiters: DeliveryResolver[];
};

export type HttpAuthorityAdapterOptions = {
  hostId?: string;
  runtimeId?: string;
  outboxDir?: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  random?: () => number;
};

export type ScopedAuthorityCredential = {
  id: string;
  secret: string;
};

export type AuthorityAdapterCredentials = {
  matchReport: ScopedAuthorityCredential;
  heatmap: ScopedAuthorityCredential;
};

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

export function loadAuthorityUrlFromEnv(): string | null {
  const raw = Deno.env.get("AUTHORITY_URL")?.trim() ||
    Deno.env.get("AUTHORITY_BASE_URL")?.trim() ||
    "";
  if (raw) return raw.replace(/\/$/, "");
  return null;
}

/**
 * Build the adapter for this process.
 * Official authentic (ranked or open) + scoped credentials + URL → HTTP;
 * otherwise noop. Community downloadables never ship these credentials.
 */
export function createAuthorityAdapter(opts: {
  /**
   * When true, prefer HTTP reporting if credentials exist.
   * Ranked always wants reporting; open official also does (XP only).
   */
  official: boolean;
  authorityUrl?: string | null;
}): AuthorityAdapter {
  if (!opts.official) return new NoopAuthorityAdapter();
  const url = (opts.authorityUrl ?? loadAuthorityUrlFromEnv())?.trim() || null;
  const matchReport = loadScopedCredentialFromEnv("MATCH_REPORT");
  const heatmap = loadScopedCredentialFromEnv("HEATMAP");
  if (!matchReport || !heatmap || !url) {
    console.warn(
      "[server] Official mode without AUTHORITY_URL and scoped reporting credentials — " +
        "match results will not be reported to authority.",
    );
    return new NoopAuthorityAdapter();
  }
  console.log(`[server] Authority match reports → ${url}`);
  return new HttpAuthorityAdapter(url, { matchReport, heatmap }, {
    runtimeId: Deno.env.get("DOORS_RUNTIME_ID")?.trim() ||
      Deno.env.get("RANKED_SERVER_ID")?.trim() || undefined,
  });
}

function loadScopedCredentialFromEnv(
  capability: "MATCH_REPORT" | "HEATMAP",
): ScopedAuthorityCredential | null {
  const id = Deno.env.get(`AUTHORITY_${capability}_CREDENTIAL_ID`)?.trim();
  const secret = Deno.env.get(`AUTHORITY_${capability}_SECRET`)?.trim();
  return id && secret ? { id, secret } : null;
}
