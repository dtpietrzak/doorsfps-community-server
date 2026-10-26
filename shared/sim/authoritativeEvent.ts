/**
 * Canonical non-input authoritative events (replay epic 5.5).
 *
 * One serializable vocabulary for every server-owned state change the sim
 * consumes that is not a per-tick player action. Recording (8.2/8.4) and
 * replay (11.2) will persist / re-apply this stream alongside inputs.
 *
 * Epic 7.3 extends the inventory with sim-outcome kinds (`combatBurst`,
 * `playerDied`, `score`, `gameOver`, `playerRespawned`) mapped from
 * `SimTickResult` via `drainTickAuthoritativeEvents`.
 *
 * Excluded (owned by other epics):
 * - CanonicalPlayerInput / tick association / adapters → 5.1–5.4
 * - Match-metadata packaging / recorder interface → 7.4–7.5
 * - Persistence, checkpoints, file format, playback → #8–#11
 *
 * See `AUTHORITATIVE_EVENTS.md` for ordering, spawn-RNG rules, and handoffs.
 */

import {
  defaultPlayerEquipment,
  normalizePlayerEquipment,
  type PlayerEquipment,
} from "./game.ts";
import {
  emptySkillLoadout,
  isSkillId,
  normalizeSkillLoadout,
  type SkillId,
  type SkillLoadout,
  type SkillProductId,
} from "./skills.ts";
import type { MapFormatVersion } from "../world/doorsMapFormat.ts";
import { isSupportedMapFormatVersion } from "../world/doorsMapFormat.ts";

/** Team ids restricted to A/B (matches live `TeamId`). */
export type AuthoritativeTeamId = "A" | "B";

/** Match end result when not a dedicated `matchDraw` event. */
export type AuthoritativeMatchWinner = AuthoritativeTeamId;

/** Match phase for init / start payloads. */
export type AuthoritativeMatchPhase = "prematch" | "live" | "intermission";

/** Raid / debug door policy (matches `PlayerManager.raidDoorPolicy`). */
export type AuthoritativeRaidDoorPolicy = "off" | "idle" | "open";

/**
 * Closed inventory of non-input authoritative event kinds.
 * Every live sim mutation in the 5.5 inventory maps to exactly one of these.
 */
export const AUTHORITATIVE_EVENT_KINDS = [
  "matchInit",
  "matchConfig",
  "humanJoin",
  "botAdd",
  "agentAdd",
  "agentRemove",
  "playerRemove",
  "connectionStatus",
  "teamAssign",
  "loadoutCommit",
  "readyVote",
  "matchStart",
  "matchEnd",
  "matchDraw",
  /** Sim-tick outcomes (epic 7.3) — mapped from `SimTickResult`, not the 5.5 buffer. */
  "combatBurst",
  "playerDied",
  "score",
  "gameOver",
  "playerRespawned",
] as const;

export type AuthoritativeEventKind =
  (typeof AUTHORITATIVE_EVENT_KINDS)[number];

/**
 * Intra-tick application categories (Decision 2).
 * Lifecycle/config → roster (ascending id) → loadout/team commits.
 * Application point is the tick boundary **before** player updates.
 */
export const AUTHORITATIVE_INTRA_TICK_CATEGORIES = [
  "lifecycleConfig",
  "roster",
  "commit",
  /** After commits: weapons / deaths / scores / game-over / respawns (epic 7.3). */
  "simOutcome",
] as const;

export type AuthoritativeIntraTickCategory =
  (typeof AUTHORITATIVE_INTRA_TICK_CATEGORIES)[number];

/** Kind → intra-tick category. */
export const AUTHORITATIVE_KIND_CATEGORY: Record<
  AuthoritativeEventKind,
  AuthoritativeIntraTickCategory
> = {
  matchInit: "lifecycleConfig",
  matchConfig: "lifecycleConfig",
  matchStart: "lifecycleConfig",
  matchEnd: "lifecycleConfig",
  matchDraw: "lifecycleConfig",
  humanJoin: "roster",
  botAdd: "roster",
  agentAdd: "roster",
  agentRemove: "roster",
  playerRemove: "roster",
  connectionStatus: "roster",
  teamAssign: "commit",
  loadoutCommit: "commit",
  readyVote: "commit",
  combatBurst: "simOutcome",
  playerDied: "simOutcome",
  score: "simOutcome",
  gameOver: "simOutcome",
  playerRespawned: "simOutcome",
};

/** Stable order within the lifecycle/config category. */
const LIFECYCLE_KIND_ORDER: Record<string, number> = {
  matchInit: 0,
  matchConfig: 1,
  matchStart: 2,
  matchEnd: 3,
  matchDraw: 4,
};

/** Stable order within the commit category. */
const COMMIT_KIND_ORDER: Record<string, number> = {
  teamAssign: 0,
  loadoutCommit: 1,
  readyVote: 2,
};

/**
 * Stable order within the simOutcome category.
 * Mirrors `SIM_TICK_EVENT_ORDER` (CombatBurst → PlayerDied → Score → GameOver → PlayerRespawned).
 */
const SIM_OUTCOME_KIND_ORDER: Record<string, number> = {
  combatBurst: 0,
  playerDied: 1,
  score: 2,
  gameOver: 3,
  playerRespawned: 4,
};

/** Finite spawn / pose snapshot recorded on roster ops (Decision 4). */
export type AuthoritativePose = {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
};

/**
 * Sim-relevant roster snapshot (Decision 3).
 * Excludes operational wall-clock metadata (AFK, participation, party expiry,
 * connection grace deadlines, `liveStartedAtMs`).
 */
export type AuthoritativeRosterSnapshot = {
  id: string;
  name: string;
  team: AuthoritativeTeamId;
  /** Raid-bot role (sim-relevant), not "AI-controlled" — see the keys-only note. */
  isBot: boolean;
  isAgent: boolean;
  isBalanceBot: boolean;
  alive: boolean;
  connectionIssue: boolean;
  unlimitedAmmo: boolean;
  maxHealth: number;
  modelScale: number;
  moveSpeedScale: number;
  pose: AuthoritativePose;
  equipment: PlayerEquipment;
  /** Validated stored loadout, or null when unrestricted / unset. */
  skillLoadout: SkillLoadout | null;
  /** Explicit owned product list, or null when unrestricted. */
  ownedAbilities: SkillProductId[] | null;
};

export type AuthoritativeTeamScores = {
  A: number;
  B: number;
};

export type AuthoritativeMapIdentity = {
  name: string;
  version: MapFormatVersion;
};

/** Mid-match door / debug policy change. */
export type MatchConfigEvent = {
  kind: "matchConfig";
  appliedTick: number;
  raidDoorPolicy?: AuthoritativeRaidDoorPolicy;
  debugForceDoorsOpen?: boolean;
};

/** Full match-init snapshot (Decision 6) — shape for 8.2 / 11.1, not bytes. */
export type MatchInitEvent = {
  kind: "matchInit";
  appliedTick: number;
  map: AuthoritativeMapIdentity;
  matchSeed: number;
  matchDurationTicks: number;
  prematchEnabled: boolean;
  phase: AuthoritativeMatchPhase;
  raidDoorPolicy: AuthoritativeRaidDoorPolicy;
  debugForceDoorsOpen: boolean;
  scores: AuthoritativeTeamScores;
  roster: AuthoritativeRosterSnapshot[];
};

export type HumanJoinEvent = {
  kind: "humanJoin";
  appliedTick: number;
  player: AuthoritativeRosterSnapshot;
};

export type BotAddEvent = {
  kind: "botAdd";
  appliedTick: number;
  player: AuthoritativeRosterSnapshot;
};

export type AgentAddEvent = {
  kind: "agentAdd";
  appliedTick: number;
  player: AuthoritativeRosterSnapshot;
};

export type AgentRemoveEvent = {
  kind: "agentRemove";
  appliedTick: number;
  playerId: string;
};

export type PlayerRemoveEvent = {
  kind: "playerRemove";
  appliedTick: number;
  playerId: string;
};

export type ConnectionStatusEvent = {
  kind: "connectionStatus";
  appliedTick: number;
  playerId: string;
  /** Resulting connection-issue flag after the transition. */
  connectionIssue: boolean;
  /** Transport socket after restore; null while issued / for bots. */
  socketId: string | null;
  /** True when reconnect also triggered a door-open respawn. */
  respawned: boolean;
  /** Resulting sim-relevant snapshot (includes pose if respawned). */
  player: AuthoritativeRosterSnapshot;
};

/**
 * Team assignment after join (switch, voted rebalance, bot rebalance, force).
 * Join-time team pick is carried on `humanJoin` / `botAdd` / `agentAdd`.
 */
export type TeamAssignEvent = {
  kind: "teamAssign";
  appliedTick: number;
  reason:
    | "switch"
    | "votedRebalance"
    | "botRebalance"
    | "force"
    | "forceGroup";
  playerId: string;
  from: AuthoritativeTeamId;
  to: AuthoritativeTeamId;
  /** Resulting roster snapshot (includes post-respawn pose). */
  player: AuthoritativeRosterSnapshot;
};

/** Validated skill-loadout commit (5.1 Decision 6 handoff). */
export type LoadoutCommitEvent = {
  kind: "loadoutCommit";
  appliedTick: number;
  playerId: string;
  /** Post-`setSkillLoadout` stored loadout (never raw client payload). */
  loadout: SkillLoadout | null;
};

export type ReadyVoteEvent = {
  kind: "readyVote";
  appliedTick: number;
  /** Set/clear one human vote. Omitted when `clearAll` is true. */
  playerId?: string;
  ready: boolean;
  /** Prematch roster-change wipe of every ready vote. */
  clearAll?: boolean;
};

export type MatchStartEvent = {
  kind: "matchStart";
  appliedTick: number;
  phase: "prematch" | "live";
  matchSeed: number;
  matchEndTick: number;
  doorCycleOriginTick: number;
  scores: AuthoritativeTeamScores;
  /** Full roster after start respawns (poses recorded). */
  roster: AuthoritativeRosterSnapshot[];
};

export type MatchEndEvent = {
  kind: "matchEnd";
  appliedTick: number;
  winner: AuthoritativeMatchWinner;
  scheduleRestart: boolean;
  restartSeconds: number;
  restartAtTick: number | null;
  scores: AuthoritativeTeamScores;
};

export type MatchDrawEvent = {
  kind: "matchDraw";
  appliedTick: number;
  scheduleRestart: boolean;
  restartSeconds: number;
  restartAtTick: number | null;
  scores: AuthoritativeTeamScores;
};

/** Hit zone for combat / death sim outcomes (epic 7.3). */
export type AuthoritativeHitZone = "head" | "body";

/** Serializable shot fired payload (mirrors live `ShotFiredPacket`). */
export type AuthoritativeShotFired = {
  shooterId: string;
  origin: [number, number, number];
  direction: [number, number, number];
  weapon: number;
  hitId: string | null;
  hitZone: AuthoritativeHitZone | null;
  hitPoint: [number, number, number] | null;
  melee?: boolean;
  /** Multi-pellet shots only; index 0 = centre pellet (= top-level fields). */
  pellets?: AuthoritativeShotPellet[];
};

/** One pellet of a multi-pellet shot (mirrors live `ShotPellet`). */
export type AuthoritativeShotPellet = {
  direction: [number, number, number];
  hitId: string | null;
  hitZone: AuthoritativeHitZone | null;
  hitPoint: [number, number, number] | null;
};

/** Serializable damage row inside a combat outcome (mirrors live `DamageOutcome`). */
export type AuthoritativeDamageOutcome = {
  targetId: string;
  shooterId: string;
  damage: number;
  health: number;
  zone: AuthoritativeHitZone;
  alive: boolean;
  killed: boolean;
  critical: boolean;
  hitSlowStacks?: number;
  hitSlowEndsAtTick?: number;
};

/** One shot + optional damages (mirrors live `ShootOutcome` / combat outcome). */
export type AuthoritativeCombatOutcome = {
  shot: AuthoritativeShotFired;
  damages?: AuthoritativeDamageOutcome[];
  leech?: boolean;
};

/** Weapons-phase combat burst (mapped from `SimTickResult` CombatBurst). */
export type CombatBurstEvent = {
  kind: "combatBurst";
  appliedTick: number;
  outcomes: AuthoritativeCombatOutcome[];
};

/** Kill / overlap death (mapped from `SimTickResult` PlayerDied). */
export type PlayerDiedEvent = {
  kind: "playerDied";
  appliedTick: number;
  victimId: string;
  killerId: string;
  zone: AuthoritativeHitZone;
  weapon: number;
  killerName: string;
  victimName: string;
  killerTeam: AuthoritativeTeamId;
  victimTeam: AuthoritativeTeamId;
  killerIsAgent?: boolean;
  victimIsAgent?: boolean;
};

/** Door-capture score (mapped from `SimTickResult` Score). */
export type ScoreEvent = {
  kind: "score";
  appliedTick: number;
  scorerId: string;
  team: AuthoritativeTeamId;
  scores: AuthoritativeTeamScores;
  /** Scorer pose after capture teleport (Decision 4). */
  playerPose: AuthoritativePose;
  playerAlive: boolean;
  /** Raid co-op reset poses (id + pose), when present on the live packet. */
  resetPlayerPoses?: Array<{ id: string; pose: AuthoritativePose }>;
};

/**
 * Wire GameOver fact (mapped from `SimTickResult` GameOver).
 * Deduped against `matchEnd` / `matchDraw` in the unified drain when both exist.
 */
export type GameOverEvent = {
  kind: "gameOver";
  appliedTick: number;
  winner: AuthoritativeTeamId | "draw";
  scores: AuthoritativeTeamScores;
  restartInSeconds: number;
  returnToMenu?: boolean;
  matchKind?: "raid";
};

/** Respawn with recorded pose (mapped from `SimTickResult` PlayerRespawned). */
export type PlayerRespawnedEvent = {
  kind: "playerRespawned";
  appliedTick: number;
  player: AuthoritativeRosterSnapshot;
};

/** Discriminated union — the only vocabulary for non-input sim mutations. */
export type AuthoritativeEvent =
  | MatchInitEvent
  | MatchConfigEvent
  | HumanJoinEvent
  | BotAddEvent
  | AgentAddEvent
  | AgentRemoveEvent
  | PlayerRemoveEvent
  | ConnectionStatusEvent
  | TeamAssignEvent
  | LoadoutCommitEvent
  | ReadyVoteEvent
  | MatchStartEvent
  | MatchEndEvent
  | MatchDrawEvent
  | CombatBurstEvent
  | PlayerDiedEvent
  | ScoreEvent
  | GameOverEvent
  | PlayerRespawnedEvent;

/** Loose constructor / normalize input (unknown JSON). */
export type AuthoritativeEventInit = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function asBool(value: unknown): boolean {
  return value === true;
}

function finiteOr(
  value: unknown,
  fallback: number,
): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Non-negative integer tick, or null when rejected. */
export function normalizeAppliedTick(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  if (raw < 0) return null;
  return Math.trunc(raw);
}

export function normalizeAuthoritativeTeamId(
  raw: unknown,
): AuthoritativeTeamId | null {
  return raw === "A" || raw === "B" ? raw : null;
}

export function normalizeAuthoritativePose(
  raw: unknown,
): AuthoritativePose | null {
  if (raw == null || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const x = o.x;
  const y = o.y;
  const z = o.z;
  const yaw = o.yaw;
  const pitch = o.pitch;
  if (
    typeof x !== "number" || !Number.isFinite(x) ||
    typeof y !== "number" || !Number.isFinite(y) ||
    typeof z !== "number" || !Number.isFinite(z) ||
    typeof yaw !== "number" || !Number.isFinite(yaw) ||
    typeof pitch !== "number" || !Number.isFinite(pitch)
  ) {
    return null;
  }
  return { x, y, z, yaw, pitch };
}

function normalizeOwnedAbilities(
  raw: unknown,
): SkillProductId[] | null {
  if (raw == null) return null;
  if (!Array.isArray(raw)) return null;
  const out: SkillProductId[] = [];
  for (const item of raw) {
    if (typeof item === "string" && item.length > 0) {
      out.push(item as SkillProductId);
    }
  }
  return out;
}

function normalizeLoadoutField(
  raw: unknown,
  owned: SkillProductId[] | null,
): SkillLoadout | null {
  if (raw == null) return null;
  if (!Array.isArray(raw)) return null;
  // Unknown / duplicate / unowned slots → null slot (live setSkillLoadout).
  return normalizeSkillLoadout(raw, owned);
}

export function normalizeAuthoritativeRosterSnapshot(
  raw: unknown,
): AuthoritativeRosterSnapshot | null {
  if (raw == null || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== "string" || o.id.length === 0) return null;
  if (typeof o.name !== "string") return null;
  const team = normalizeAuthoritativeTeamId(o.team);
  if (!team) return null;
  const pose = normalizeAuthoritativePose(o.pose);
  if (!pose) return null;
  const ownedAbilities = normalizeOwnedAbilities(o.ownedAbilities);
  const equipment = normalizePlayerEquipment(o.equipment);
  const skillLoadout = normalizeLoadoutField(o.skillLoadout, ownedAbilities);
  return {
    id: o.id,
    name: o.name,
    team,
    // Raid-bot role, not "AI-controlled" — see the keys-only note.
    isBot: asBool(o.isBot),
    isAgent: asBool(o.isAgent),
    isBalanceBot: asBool(o.isBalanceBot) && !asBool(o.isAgent),
    alive: o.alive === false ? false : true,
    connectionIssue: asBool(o.connectionIssue),
    unlimitedAmmo: asBool(o.unlimitedAmmo),
    maxHealth: Math.max(1, Math.round(finiteOr(o.maxHealth, 100))),
    modelScale: Math.max(0.1, finiteOr(o.modelScale, 1)),
    moveSpeedScale: Math.max(0.1, finiteOr(o.moveSpeedScale, 1)),
    pose,
    equipment,
    skillLoadout,
    ownedAbilities,
  };
}

function normalizeScores(raw: unknown): AuthoritativeTeamScores {
  if (raw == null || typeof raw !== "object") return { A: 0, B: 0 };
  const o = raw as Record<string, unknown>;
  return {
    A: Math.max(0, Math.trunc(finiteOr(o.A, 0))),
    B: Math.max(0, Math.trunc(finiteOr(o.B, 0))),
  };
}

function normalizeRaidPolicy(
  raw: unknown,
): AuthoritativeRaidDoorPolicy | null {
  return raw === "off" || raw === "idle" || raw === "open" ? raw : null;
}

function normalizePhase(raw: unknown): AuthoritativeMatchPhase | null {
  return raw === "prematch" || raw === "live" || raw === "intermission"
    ? raw
    : null;
}

function normalizeMapIdentity(raw: unknown): AuthoritativeMapIdentity | null {
  if (raw == null || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.name !== "string") return null;
  if (!isSupportedMapFormatVersion(o.version)) return null;
  return { name: o.name, version: o.version };
}

function normalizeRosterList(
  raw: unknown,
): AuthoritativeRosterSnapshot[] | null {
  if (!Array.isArray(raw)) return null;
  const out: AuthoritativeRosterSnapshot[] = [];
  for (const item of raw) {
    const snap = normalizeAuthoritativeRosterSnapshot(item);
    if (!snap) return null;
    out.push(snap);
  }
  return out;
}

function eventPlayerId(event: AuthoritativeEvent): string {
  switch (event.kind) {
    case "humanJoin":
    case "botAdd":
    case "agentAdd":
    case "playerRespawned":
      return event.player.id;
    case "agentRemove":
    case "playerRemove":
    case "connectionStatus":
    case "teamAssign":
    case "loadoutCommit":
      return event.playerId;
    case "readyVote":
      return event.playerId ?? "";
    case "playerDied":
      return event.victimId;
    case "score":
      return event.scorerId;
    default:
      return "";
  }
}

/**
 * Canonical same-tick ordering (Decision 2 + spawn-request rule).
 * Sort key: appliedTick → category → kind-within-category → ascending id.
 */
export function compareAuthoritativeEvents(
  a: AuthoritativeEvent,
  b: AuthoritativeEvent,
): number {
  if (a.appliedTick !== b.appliedTick) {
    return a.appliedTick - b.appliedTick;
  }
  const catA = AUTHORITATIVE_KIND_CATEGORY[a.kind];
  const catB = AUTHORITATIVE_KIND_CATEGORY[b.kind];
  const catOrder = AUTHORITATIVE_INTRA_TICK_CATEGORIES.indexOf(catA) -
    AUTHORITATIVE_INTRA_TICK_CATEGORIES.indexOf(catB);
  if (catOrder !== 0) return catOrder;

  if (catA === "lifecycleConfig") {
    const ko = (LIFECYCLE_KIND_ORDER[a.kind] ?? 99) -
      (LIFECYCLE_KIND_ORDER[b.kind] ?? 99);
    if (ko !== 0) return ko;
  } else if (catA === "commit") {
    const ko = (COMMIT_KIND_ORDER[a.kind] ?? 99) -
      (COMMIT_KIND_ORDER[b.kind] ?? 99);
    if (ko !== 0) return ko;
  } else if (catA === "simOutcome") {
    const ko = (SIM_OUTCOME_KIND_ORDER[a.kind] ?? 99) -
      (SIM_OUTCOME_KIND_ORDER[b.kind] ?? 99);
    if (ko !== 0) return ko;
  }

  const idA = eventPlayerId(a);
  const idB = eventPlayerId(b);
  if (idA < idB) return -1;
  if (idA > idB) return 1;
  return 0;
}

export function sortAuthoritativeEvents(
  events: readonly AuthoritativeEvent[],
): AuthoritativeEvent[] {
  return events.slice().sort(compareAuthoritativeEvents);
}

/**
 * Total normalization. Returns null when the event is structurally invalid
 * (bad kind, negative tick, non-finite pose, bad team, etc.).
 * Result is JSON-serializable with no `undefined` holes on required fields.
 */
function normalizeHitZone(raw: unknown): AuthoritativeHitZone | null {
  return raw === "head" || raw === "body" ? raw : null;
}

function normalizeVec3(
  raw: unknown,
): [number, number, number] | null {
  if (!Array.isArray(raw) || raw.length < 3) return null;
  const x = raw[0];
  const y = raw[1];
  const z = raw[2];
  if (
    typeof x !== "number" || !Number.isFinite(x) ||
    typeof y !== "number" || !Number.isFinite(y) ||
    typeof z !== "number" || !Number.isFinite(z)
  ) {
    return null;
  }
  return [x, y, z];
}

function normalizeShotFired(raw: unknown): AuthoritativeShotFired | null {
  if (raw == null || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.shooterId !== "string" || o.shooterId.length === 0) return null;
  const origin = normalizeVec3(o.origin);
  const direction = normalizeVec3(o.direction);
  if (!origin || !direction) return null;
  const hitZone = o.hitZone == null ? null : normalizeHitZone(o.hitZone);
  if (o.hitZone != null && hitZone == null) return null;
  const hitPoint = o.hitPoint == null ? null : normalizeVec3(o.hitPoint);
  if (o.hitPoint != null && hitPoint == null) return null;
  const shot: AuthoritativeShotFired = {
    shooterId: o.shooterId,
    origin,
    direction,
    weapon: Math.trunc(finiteOr(o.weapon, 0)),
    hitId: typeof o.hitId === "string" ? o.hitId : null,
    hitZone,
    hitPoint,
  };
  if ("melee" in o) shot.melee = asBool(o.melee);
  if ("pellets" in o) {
    if (!Array.isArray(o.pellets)) return null;
    const pellets: AuthoritativeShotPellet[] = [];
    for (const p of o.pellets) {
      const mapped = normalizeShotPellet(p);
      if (!mapped) return null;
      pellets.push(mapped);
    }
    shot.pellets = pellets;
  }
  return shot;
}

function normalizeShotPellet(raw: unknown): AuthoritativeShotPellet | null {
  if (raw == null || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const direction = normalizeVec3(o.direction);
  if (!direction) return null;
  const hitZone = o.hitZone == null ? null : normalizeHitZone(o.hitZone);
  if (o.hitZone != null && hitZone == null) return null;
  const hitPoint = o.hitPoint == null ? null : normalizeVec3(o.hitPoint);
  if (o.hitPoint != null && hitPoint == null) return null;
  return {
    direction,
    hitId: typeof o.hitId === "string" ? o.hitId : null,
    hitZone,
    hitPoint,
  };
}

function normalizeDamageOutcome(
  raw: unknown,
): AuthoritativeDamageOutcome | null {
  if (raw == null || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.targetId !== "string" || o.targetId.length === 0) return null;
  if (typeof o.shooterId !== "string" || o.shooterId.length === 0) return null;
  const zone = normalizeHitZone(o.zone);
  if (!zone) return null;
  const damage: AuthoritativeDamageOutcome = {
    targetId: o.targetId,
    shooterId: o.shooterId,
    damage: finiteOr(o.damage, 0),
    health: finiteOr(o.health, 0),
    zone,
    alive: asBool(o.alive),
    killed: asBool(o.killed),
    critical: asBool(o.critical),
  };
  if ("hitSlowStacks" in o) {
    damage.hitSlowStacks = Math.trunc(finiteOr(o.hitSlowStacks, 0));
  }
  if ("hitSlowEndsAtTick" in o) {
    damage.hitSlowEndsAtTick = Math.trunc(finiteOr(o.hitSlowEndsAtTick, 0));
  }
  return damage;
}

function normalizeCombatOutcome(
  raw: unknown,
): AuthoritativeCombatOutcome | null {
  if (raw == null || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const shot = normalizeShotFired(o.shot);
  if (!shot) return null;
  const outcome: AuthoritativeCombatOutcome = { shot };
  if ("damages" in o) {
    if (!Array.isArray(o.damages)) return null;
    const damages: AuthoritativeDamageOutcome[] = [];
    for (const d of o.damages) {
      const mapped = normalizeDamageOutcome(d);
      if (!mapped) return null;
      damages.push(mapped);
    }
    outcome.damages = damages;
  }
  if ("leech" in o) outcome.leech = asBool(o.leech);
  return outcome;
}

export function normalizeAuthoritativeEvent(
  raw: unknown,
): AuthoritativeEvent | null {
  if (raw == null || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const kind = o.kind;
  if (
    typeof kind !== "string" ||
    !(AUTHORITATIVE_EVENT_KINDS as readonly string[]).includes(kind)
  ) {
    return null;
  }
  const appliedTick = normalizeAppliedTick(o.appliedTick);
  if (appliedTick == null) return null;

  switch (kind as AuthoritativeEventKind) {
    case "matchInit": {
      const map = normalizeMapIdentity(o.map);
      const phase = normalizePhase(o.phase);
      const raidDoorPolicy = normalizeRaidPolicy(o.raidDoorPolicy) ?? "off";
      const roster = normalizeRosterList(o.roster);
      if (!map || !phase || !roster) return null;
      const matchSeed = Math.trunc(finiteOr(o.matchSeed, 0));
      const matchDurationTicks = Math.max(
        1,
        Math.trunc(finiteOr(o.matchDurationTicks, 1)),
      );
      return {
        kind: "matchInit",
        appliedTick,
        map,
        matchSeed,
        matchDurationTicks,
        prematchEnabled: asBool(o.prematchEnabled),
        phase,
        raidDoorPolicy,
        debugForceDoorsOpen: asBool(o.debugForceDoorsOpen),
        scores: normalizeScores(o.scores),
        roster,
      };
    }
    case "matchConfig": {
      const event: MatchConfigEvent = { kind: "matchConfig", appliedTick };
      const policy = normalizeRaidPolicy(o.raidDoorPolicy);
      if (policy) event.raidDoorPolicy = policy;
      if ("debugForceDoorsOpen" in o) {
        event.debugForceDoorsOpen = asBool(o.debugForceDoorsOpen);
      }
      if (event.raidDoorPolicy === undefined &&
        event.debugForceDoorsOpen === undefined) {
        return null;
      }
      return event;
    }
    case "humanJoin":
    case "botAdd":
    case "agentAdd": {
      const player = normalizeAuthoritativeRosterSnapshot(o.player);
      if (!player) return null;
      if (kind === "humanJoin") {
        return {
          kind: "humanJoin",
          appliedTick,
          player: { ...player, isBot: false, isAgent: false, isBalanceBot: false },
        };
      }
      if (kind === "botAdd") {
        return {
          kind: "botAdd",
          appliedTick,
          player: { ...player, isAgent: false },
        };
      }
      return {
        kind: "agentAdd",
        appliedTick,
        player: {
          ...player,
          isAgent: true,
          isBalanceBot: false,
          unlimitedAmmo: true,
        },
      };
    }
    case "agentRemove":
    case "playerRemove": {
      if (typeof o.playerId !== "string" || o.playerId.length === 0) {
        return null;
      }
      return { kind, appliedTick, playerId: o.playerId } as
        | AgentRemoveEvent
        | PlayerRemoveEvent;
    }
    case "connectionStatus": {
      if (typeof o.playerId !== "string" || o.playerId.length === 0) {
        return null;
      }
      const player = normalizeAuthoritativeRosterSnapshot(o.player);
      if (!player) return null;
      return {
        kind: "connectionStatus",
        appliedTick,
        playerId: o.playerId,
        connectionIssue: asBool(o.connectionIssue),
        socketId: typeof o.socketId === "string" ? o.socketId : null,
        respawned: asBool(o.respawned),
        player,
      };
    }
    case "teamAssign": {
      if (typeof o.playerId !== "string" || o.playerId.length === 0) {
        return null;
      }
      const from = normalizeAuthoritativeTeamId(o.from);
      const to = normalizeAuthoritativeTeamId(o.to);
      const player = normalizeAuthoritativeRosterSnapshot(o.player);
      if (!from || !to || !player) return null;
      const reason = o.reason;
      if (
        reason !== "switch" && reason !== "votedRebalance" &&
        reason !== "botRebalance" && reason !== "force" &&
        reason !== "forceGroup"
      ) {
        return null;
      }
      return {
        kind: "teamAssign",
        appliedTick,
        reason,
        playerId: o.playerId,
        from,
        to,
        player,
      };
    }
    case "loadoutCommit": {
      if (typeof o.playerId !== "string" || o.playerId.length === 0) {
        return null;
      }
      // Store validated loadout; unknown skill ids → null slots via normalize.
      let loadout: SkillLoadout | null = null;
      if (o.loadout != null) {
        if (!Array.isArray(o.loadout)) return null;
        const slots = emptySkillLoadout();
        const seen = new Set<SkillId>();
        const len = Math.min(o.loadout.length, slots.length);
        for (let i = 0; i < len; i++) {
          const item = o.loadout[i];
          if (item == null || item === "") {
            slots[i] = null;
            continue;
          }
          if (typeof item !== "string" || !isSkillId(item) || seen.has(item)) {
            slots[i] = null;
            continue;
          }
          slots[i] = item;
          seen.add(item);
        }
        loadout = slots;
      }
      return {
        kind: "loadoutCommit",
        appliedTick,
        playerId: o.playerId,
        loadout,
      };
    }
    case "readyVote": {
      const clearAll = asBool(o.clearAll);
      if (clearAll) {
        return {
          kind: "readyVote",
          appliedTick,
          ready: false,
          clearAll: true,
        };
      }
      if (typeof o.playerId !== "string" || o.playerId.length === 0) {
        return null;
      }
      return {
        kind: "readyVote",
        appliedTick,
        playerId: o.playerId,
        ready: asBool(o.ready),
      };
    }
    case "matchStart": {
      const phase = o.phase === "prematch" || o.phase === "live"
        ? o.phase
        : null;
      const roster = normalizeRosterList(o.roster);
      if (!phase || !roster) return null;
      return {
        kind: "matchStart",
        appliedTick,
        phase,
        matchSeed: Math.trunc(finiteOr(o.matchSeed, 0)),
        matchEndTick: Math.trunc(finiteOr(o.matchEndTick, appliedTick)),
        doorCycleOriginTick: Math.trunc(
          finiteOr(o.doorCycleOriginTick, appliedTick),
        ),
        scores: normalizeScores(o.scores),
        roster,
      };
    }
    case "matchEnd": {
      const winner = normalizeAuthoritativeTeamId(o.winner);
      if (!winner) return null;
      const scheduleRestart = o.scheduleRestart !== false;
      const restartSeconds = Math.max(
        0,
        Math.trunc(finiteOr(o.restartSeconds, 0)),
      );
      let restartAtTick: number | null = null;
      if (o.restartAtTick != null) {
        const t = normalizeAppliedTick(o.restartAtTick);
        if (t == null) return null;
        restartAtTick = t;
      } else if (scheduleRestart) {
        return null;
      }
      return {
        kind: "matchEnd",
        appliedTick,
        winner,
        scheduleRestart,
        restartSeconds,
        restartAtTick,
        scores: normalizeScores(o.scores),
      };
    }
    case "matchDraw": {
      const scheduleRestart = o.scheduleRestart === true;
      const restartSeconds = Math.max(
        0,
        Math.trunc(finiteOr(o.restartSeconds, 0)),
      );
      let restartAtTick: number | null = null;
      if (o.restartAtTick != null) {
        const t = normalizeAppliedTick(o.restartAtTick);
        if (t == null) return null;
        restartAtTick = t;
      }
      return {
        kind: "matchDraw",
        appliedTick,
        scheduleRestart,
        restartSeconds,
        restartAtTick,
        scores: normalizeScores(o.scores),
      };
    }
    case "combatBurst": {
      if (!Array.isArray(o.outcomes)) return null;
      const outcomes: AuthoritativeCombatOutcome[] = [];
      for (const rawOutcome of o.outcomes) {
        const mapped = normalizeCombatOutcome(rawOutcome);
        if (!mapped) return null;
        outcomes.push(mapped);
      }
      return { kind: "combatBurst", appliedTick, outcomes };
    }
    case "playerDied": {
      if (typeof o.victimId !== "string" || o.victimId.length === 0) {
        return null;
      }
      if (typeof o.killerId !== "string" || o.killerId.length === 0) {
        return null;
      }
      const zone = normalizeHitZone(o.zone);
      const killerTeam = normalizeAuthoritativeTeamId(o.killerTeam);
      const victimTeam = normalizeAuthoritativeTeamId(o.victimTeam);
      if (!zone || !killerTeam || !victimTeam) return null;
      if (typeof o.killerName !== "string" || typeof o.victimName !== "string") {
        return null;
      }
      const event: PlayerDiedEvent = {
        kind: "playerDied",
        appliedTick,
        victimId: o.victimId,
        killerId: o.killerId,
        zone,
        weapon: Math.trunc(finiteOr(o.weapon, 0)),
        killerName: o.killerName,
        victimName: o.victimName,
        killerTeam,
        victimTeam,
      };
      if ("killerIsAgent" in o) event.killerIsAgent = asBool(o.killerIsAgent);
      if ("victimIsAgent" in o) event.victimIsAgent = asBool(o.victimIsAgent);
      return event;
    }
    case "score": {
      if (typeof o.scorerId !== "string" || o.scorerId.length === 0) {
        return null;
      }
      const team = normalizeAuthoritativeTeamId(o.team);
      const playerPose = normalizeAuthoritativePose(o.playerPose);
      if (!team || !playerPose) return null;
      const event: ScoreEvent = {
        kind: "score",
        appliedTick,
        scorerId: o.scorerId,
        team,
        scores: normalizeScores(o.scores),
        playerPose,
        playerAlive: asBool(o.playerAlive),
      };
      if (Array.isArray(o.resetPlayerPoses)) {
        const resets: Array<{ id: string; pose: AuthoritativePose }> = [];
        for (const row of o.resetPlayerPoses) {
          if (row == null || typeof row !== "object") return null;
          const r = row as Record<string, unknown>;
          if (typeof r.id !== "string" || r.id.length === 0) return null;
          const pose = normalizeAuthoritativePose(r.pose);
          if (!pose) return null;
          resets.push({ id: r.id, pose });
        }
        event.resetPlayerPoses = resets;
      }
      return event;
    }
    case "gameOver": {
      const winnerRaw = o.winner;
      const winner = winnerRaw === "draw"
        ? "draw" as const
        : normalizeAuthoritativeTeamId(winnerRaw);
      if (!winner) return null;
      const event: GameOverEvent = {
        kind: "gameOver",
        appliedTick,
        winner,
        scores: normalizeScores(o.scores),
        restartInSeconds: Math.max(
          0,
          Math.trunc(finiteOr(o.restartInSeconds, 0)),
        ),
      };
      if ("returnToMenu" in o) event.returnToMenu = asBool(o.returnToMenu);
      if (o.matchKind === "raid") event.matchKind = "raid";
      return event;
    }
    case "playerRespawned": {
      const player = normalizeAuthoritativeRosterSnapshot(o.player);
      if (!player) return null;
      return { kind: "playerRespawned", appliedTick, player };
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Pure constructors (call-site args / snapshots → event)
// ---------------------------------------------------------------------------

export function makeMatchInitEvent(
  init: Omit<MatchInitEvent, "kind">,
): MatchInitEvent {
  return { kind: "matchInit", ...init };
}

export function makeMatchConfigEvent(
  init: Omit<MatchConfigEvent, "kind">,
): MatchConfigEvent {
  return { kind: "matchConfig", ...init };
}

export function makeHumanJoinEvent(
  init: Omit<HumanJoinEvent, "kind">,
): HumanJoinEvent {
  return { kind: "humanJoin", ...init };
}

export function makeBotAddEvent(
  init: Omit<BotAddEvent, "kind">,
): BotAddEvent {
  return { kind: "botAdd", ...init };
}

export function makeAgentAddEvent(
  init: Omit<AgentAddEvent, "kind">,
): AgentAddEvent {
  return { kind: "agentAdd", ...init };
}

export function makeAgentRemoveEvent(
  appliedTick: number,
  playerId: string,
): AgentRemoveEvent {
  return { kind: "agentRemove", appliedTick, playerId };
}

export function makePlayerRemoveEvent(
  appliedTick: number,
  playerId: string,
): PlayerRemoveEvent {
  return { kind: "playerRemove", appliedTick, playerId };
}

export function makeConnectionStatusEvent(
  init: Omit<ConnectionStatusEvent, "kind">,
): ConnectionStatusEvent {
  return { kind: "connectionStatus", ...init };
}

export function makeTeamAssignEvent(
  init: Omit<TeamAssignEvent, "kind">,
): TeamAssignEvent {
  return { kind: "teamAssign", ...init };
}

export function makeLoadoutCommitEvent(
  init: Omit<LoadoutCommitEvent, "kind">,
): LoadoutCommitEvent {
  return { kind: "loadoutCommit", ...init };
}

export function makeReadyVoteEvent(
  init: Omit<ReadyVoteEvent, "kind">,
): ReadyVoteEvent {
  return { kind: "readyVote", ...init };
}

export function makeMatchStartEvent(
  init: Omit<MatchStartEvent, "kind">,
): MatchStartEvent {
  return { kind: "matchStart", ...init };
}

export function makeMatchEndEvent(
  init: Omit<MatchEndEvent, "kind">,
): MatchEndEvent {
  return { kind: "matchEnd", ...init };
}

export function makeMatchDrawEvent(
  init: Omit<MatchDrawEvent, "kind">,
): MatchDrawEvent {
  return { kind: "matchDraw", ...init };
}

export function makeCombatBurstEvent(
  init: Omit<CombatBurstEvent, "kind">,
): CombatBurstEvent {
  return { kind: "combatBurst", ...init };
}

export function makePlayerDiedEvent(
  init: Omit<PlayerDiedEvent, "kind">,
): PlayerDiedEvent {
  return { kind: "playerDied", ...init };
}

export function makeScoreEvent(
  init: Omit<ScoreEvent, "kind">,
): ScoreEvent {
  return { kind: "score", ...init };
}

export function makeGameOverEvent(
  init: Omit<GameOverEvent, "kind">,
): GameOverEvent {
  return { kind: "gameOver", ...init };
}

export function makePlayerRespawnedEvent(
  init: Omit<PlayerRespawnedEvent, "kind">,
): PlayerRespawnedEvent {
  return { kind: "playerRespawned", ...init };
}

/** Neutral empty pose (tests / defaults). */
export function emptyAuthoritativePose(): AuthoritativePose {
  return { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 };
}

/** Minimal roster snapshot for tests. */
export function emptyAuthoritativeRosterSnapshot(
  overrides: Partial<AuthoritativeRosterSnapshot> & { id: string },
): AuthoritativeRosterSnapshot {
  return {
    id: overrides.id,
    name: overrides.name ?? overrides.id,
    team: overrides.team ?? "A",
    isBot: overrides.isBot ?? false,
    isAgent: overrides.isAgent ?? false,
    isBalanceBot: overrides.isBalanceBot ?? false,
    alive: overrides.alive ?? true,
    connectionIssue: overrides.connectionIssue ?? false,
    unlimitedAmmo: overrides.unlimitedAmmo ?? false,
    maxHealth: overrides.maxHealth ?? 100,
    modelScale: overrides.modelScale ?? 1,
    moveSpeedScale: overrides.moveSpeedScale ?? 1,
    pose: overrides.pose ?? emptyAuthoritativePose(),
    equipment: overrides.equipment ?? defaultPlayerEquipment(),
    skillLoadout: overrides.skillLoadout !== undefined
      ? overrides.skillLoadout
      : null,
    ownedAbilities: overrides.ownedAbilities !== undefined
      ? overrides.ownedAbilities
      : null,
  };
}
