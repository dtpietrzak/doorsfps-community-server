import type { MmsRankId } from "../shared/progression/mmsRanks.ts";
import type { SkillId, SkillProductId } from "../shared/sim/skills.ts";

/** Transport plugin id. Gameplay must not branch on this. */
export type SessionTransportKind = "websocket" | "webtransport";

/**
 * Typed join bag previously stored on Socket.IO `socket.data`.
 * Mutable so gameplay can flip flags (e.g. intentional leave) after connect.
 */
export type SessionData = {
  playerName?: string;
  isSpectator?: boolean;
  reclaimPlayerId?: string;
  accountUserId?: string;
  partyId?: string;
  partySize?: number;
  assignmentId?: string;
  botsEvictedForJoin?: number;
  head?: number;
  visor?: number;
  shoulder?: number;
  body?: number;
  leg?: number;
  hue?: number;
  gunHue?: number;
  bulletHue?: number;
  crosshairColor?: number;
  nameHue?: number;
  pistol?: number;
  rifle?: number;
  shotgun?: number;
  /** Rifle optic 0…4. Omitted joins use Standard. */
  scope?: number;
  crosshair?: number;
  ownedAbilities?: SkillProductId[];
  skillLoadout?: Array<SkillId | null>;
  xp?: number;
  mmsRankId?: MmsRankId;
  founderBadge?: boolean;
  /** Join-token synthetic claim. Omitted or false for real accounts. */
  synthetic?: boolean;
  intentionalLeave?: boolean;
};

export type SessionAuth = Record<string, unknown>;

export type SessionAuthResult =
  | { ok: true; data: Partial<SessionData> }
  | { ok: false; error: string };

export type SessionAuthenticator = (
  auth: SessionAuth,
) => SessionAuthResult | Promise<SessionAuthResult>;

export type SessionEventHandler = (payload?: unknown) => void;

/** One connected peer. Ids are opaque; the Socket.IO plugin uses Engine.IO ids. */
export interface ClientSession {
  readonly id: string;
  readonly kind: SessionTransportKind;
  readonly auth: Readonly<SessionAuth>;
  readonly data: SessionData;

  emit(event: string, payload?: unknown): void;
  emitVolatile(event: string, payload?: unknown): void;
  on(event: string, handler: SessionEventHandler): void;
  disconnect(): void;

  isWritable(): boolean;
  writeBufferLength(): number;
}

/** Process-wide fan-out. HTTP(S) stays with GameServer; the hub only attaches. */
export interface SessionHub {
  readonly size: number;

  authenticate(fn: SessionAuthenticator): void;
  onConnect(handler: (session: ClientSession) => void): void;

  emit(event: string, payload?: unknown): void;
  get(id: string): ClientSession | undefined;
  sessions(): Iterable<ClientSession>;
  close(): Promise<void>;
}
