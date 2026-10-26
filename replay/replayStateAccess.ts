/**
 * Epic 11.5 — replay state access (reconstruction → renderer projection).
 *
 * Pure projectors from a minimal structural `ReplayViewState` into the 6.5 seams:
 * `SnapshotPacket` (state) and `ReplayRenderFeedState` (render). Owns field
 * disposition + pair extraction + focused feed assembly; never steps the
 * runner, never owns clock state, never redefines blend math, never writes
 * meshes/cameras.
 *
 * Contract (see notes/replay/11-replay-playback/11-05-replay-state-access.md):
 * - Input is a structural view (tick + player rows + doors/clock/scores/phase +
 *   projectiles), never `Player` / `PlayerManager` / `GameServer` (scan-locked).
 * - `projectReplaySnapshot` → SnapshotPacket-shaped, verbatim-or-omitted roster
 *   (cosmetics/ping/afk/badges/botDec/connectionIssue omitted as `undefined`).
 * - `extractReplayInterpPairs` → id-matched 11.4 minimal pairs only (join/leave
 *   → no pair; present side is snapshot-only).
 * - `projectReplayRenderFeed` → blend body via 11.4 with caller-supplied `u`,
 *   crouch eye correction in `viewOffset` (compensate smear; discrete crouch
 *   mirrors newer). Additive Q4A `yaw` / `pitch` / `alive` are copied from that
 *   same 11.4 pose (exact-T / leave-between-T-and-T+1 copy the single-view row).
 *   Unknown `playerId` fails loud; null view → null feed.
 * - `projectReplayFocusedDisplay` → focused `{ pose, snapped }` with exact 11.4
 *   semantics (Q1A for 12.3): both-present uses extract pairs + interpolateReplayPose;
 *   join/leave → present side + `snapped: true`; unknown id fails loud. Null view →
 *   null. The 11.5 render feed still does not carry `snapped`.
 * - Outputs deep-frozen and owner-free. No wall clock, I/O, sim mutation, or
 *   render writes (scan-locked).
 *
 * Handoffs: 11.6 projects per frame after stepping (feed + Q1A focused display);
 * 12.1 passes selected playerId; 12.2 first-person CameraPose reads this feed
 * (eyes + Q4A yaw/pitch); 12.3 third-person reads `projectReplayFocusedDisplay`;
 * 13.x relies on discrete-mirror-newer + lifecycle-exact rows;
 * 14.x projects whatever T/T+1 a seek lands on; 18.x asserts exactness.
 */

import { isAbilityActiveAt, type AbilitySnapEntry } from "../shared/sim/abilities.ts";
import { TICK_MS } from "../shared/sim/game.ts";
import { moveEyeHeight } from "../shared/sim/moveStep.ts";
import type { SkillId } from "../shared/sim/skills.ts";
import {
  SPAWN_INVULN_TICKS,
  type MatchPhase,
  type SnapshotPacket,
  type SnapshotPlayer,
  type SnapshotProjectile,
  type TeamScores,
} from "../protocol/network.ts";
import type { CheckpointPlayerState } from "./authoritativeCheckpoint.ts";
import { deepFreeze } from "./recordedInitialState.ts";
import {
  interpolateReplayPose,
  interpolateReplayRoster,
  type ReplayInterpPose,
  type ReplayInterpResult,
} from "./replayInterpolation.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Minimal structural cursor view — satisfied by the 11.2 runner adapter in
 * production and by recorder-built fixtures in tests. Not a checkpoint and not
 * a live owner handle.
 */
export type ReplayViewState = {
  readonly tick: number;
  readonly players: readonly CheckpointPlayerState[];
  readonly scores: TeamScores;
  readonly phase: MatchPhase;
  readonly doorsOpen: boolean;
  readonly doorChangeTick: number;
  readonly matchEndTick: number;
  readonly projectiles: readonly SnapshotProjectile[];
};

/** Id-matched 11.4 pair produced by extraction (both sides present). */
export type ReplayExtractedInterpPair = {
  readonly prev: ReplayInterpPose;
  readonly next: ReplayInterpPose;
};

/**
 * Q1A focused display pose (exact 11.4 `{ pose, snapped }`). Shared with 12.3.
 * Eye height is not included — callers pass 11.5 `viewOffset` into the camera.
 */
export type ReplayFocusedDisplay = ReplayInterpResult;

/**
 * 6.5 render-seam shape (structurally identical to client `ReplayRenderFeedState`).
 * Defined here so the isomorphic module never imports `client/`.
 *
 * Q4A (12.2): `yaw` / `pitch` / `alive` are additive copies of the 11.4 pose
 * `projectReplayRenderFeed` already computed. 6.5 `isRenderFeedShaped` stays
 * xyz+accum/dt only (does not require these fields).
 */
export type ReplayRenderFeedState = {
  readonly localSim: { readonly x: number; readonly y: number; readonly z: number };
  readonly prevSim: { readonly x: number; readonly y: number; readonly z: number };
  readonly localSimAccum: number;
  readonly localSimDt: number;
  readonly viewOffset: { readonly x: number; readonly y: number; readonly z: number };
  readonly yaw: number;
  readonly pitch: number;
  readonly alive: boolean;
};

export type ReplayStateAccessErrorCode =
  | "replay-state-focus-unknown";

// ---------------------------------------------------------------------------
// Errors (fail-closed, named — same { code, detail } family)
// ---------------------------------------------------------------------------

export class ReplayStateAccessError extends Error {
  readonly code: ReplayStateAccessErrorCode;
  readonly detail: string | null;

  constructor(
    code: ReplayStateAccessErrorCode,
    message: string,
    opts?: { detail?: string | null },
  ) {
    super(message);
    this.name = "ReplayStateAccessError";
    this.code = code;
    this.detail = opts?.detail ?? null;
  }
}

function fail(
  code: ReplayStateAccessErrorCode,
  message: string,
  detail?: string | null,
): never {
  throw new ReplayStateAccessError(code, message, { detail: detail ?? null });
}

// ---------------------------------------------------------------------------
// Field disposition — SnapshotPlayer projection
// ---------------------------------------------------------------------------

/**
 * Project one checkpoint-equivalent row → SnapshotPlayer.
 * Verbatim motion/lifecycle/weapons/stamina/slide/scoring; omit cosmetics,
 * ping, afk, badges, botDec, connectionIssue (optional on SnapshotPlayer —
 * `undefined` claims nothing).
 */
function projectSnapshotPlayer(
  row: CheckpointPlayerState,
  tick: number,
): SnapshotPlayer {
  const sliding = row.slideRemaining > 0 && row.slideForceCrouch;
  const out: SnapshotPlayer = {
    id: row.id,
    x: row.x,
    y: row.y,
    z: row.z,
    yaw: row.yaw,
    pitch: row.pitch,
    health: row.health,
    alive: row.alive,
    team: row.team,
    crouch: row.crouch,
    slide: sliding,
    velocityX: row.velocityX,
    velocityY: row.velocityY,
    velocityZ: row.velocityZ,
    weapon: row.weaponId,
    sprintStamina: row.sprintStamina,
    score: row.score,
    kills: row.kills,
    deaths: row.deaths,
    xp: row.xp,
  };

  if (row.isAgent) out.isAgent = true;
  // Same gate live `Player.toSnapshot` uses: spawn protect + Force Field.
  // RemotePlayers latches corpses until `invulnerable` (real respawn).
  if (
    row.alive &&
    (tick - row.spawnedAtTick < SPAWN_INVULN_TICKS ||
      isAbilityActiveAt(row.abilityEndsAtTick.forceField, tick))
  ) {
    out.invulnerable = true;
  }

  const hitSlow = row.hitSlowStacks;
  if (hitSlow > 0) {
    out.hitSlowStacks = hitSlow;
    out.hitSlowEndsAtTick = row.hitSlowEndsAtTick;
  }

  if (sliding) {
    out.slideRemaining = row.slideRemaining;
    out.slideDirX = row.slideDirX;
    out.slideDirZ = row.slideDirZ;
  }

  const loadout = row.weaponLoadouts.find((w) => w.weaponId === row.weaponId);
  if (loadout) {
    out.ammoInMag = loadout.ammoInMag;
    out.spareClips = loadout.spareClips;
  }

  out.reloading =
    (row.reloadEndsAtTick !== null && tick < row.reloadEndsAtTick) ||
    row.shellReloadNextAtTick != null;
  if (row.pumpEndsAtTick != null && tick < row.pumpEndsAtTick) {
    out.pumping = true;
  }
  out.switching =
    row.weaponSwitchEndsAtTick !== null &&
    tick < row.weaponSwitchEndsAtTick;

  const abilities = projectActiveAbilities(row, tick);
  if (abilities.length > 0) out.abilities = abilities;

  const spent = projectSpentAbilities(row);
  if (spent.length > 0) out.abilitySpent = spent;

  if (
    row.abilityGlobalLockEndsAtTick !== null &&
    tick < row.abilityGlobalLockEndsAtTick
  ) {
    out.abilityLockEndsAtTick = row.abilityGlobalLockEndsAtTick;
  }
  const regenEnd = Math.max(
    row.abilityBarRegenEndsAtTick ?? 0,
    row.abilityDoorRegenEndsAtTick ?? 0,
  );
  if (regenEnd > tick) {
    out.abilityRegenEndsAtTick = regenEnd;
  }

  // Omitted (disposition table): name/head/visor/shoulder/body/leg/hue/gunHue/
  // pistol/rifle/crosshair, ping, afk/afkKickIn, mmsRankId/founderBadge,
  // botDec, connectionIssue, keys, lastProcessedInputSeq, glitch, scale —
  // never synthesized from init metadata or live MIXED facts.

  return out;
}

function projectActiveAbilities(
  row: CheckpointPlayerState,
  tick: number,
): AbilitySnapEntry[] {
  const out: AbilitySnapEntry[] = [];
  for (const id of Object.keys(row.abilityEndsAtTick) as SkillId[]) {
    const ends = row.abilityEndsAtTick[id];
    if (!isAbilityActiveAt(ends, tick)) continue;
    const entry: AbilitySnapEntry = { id, endsAtTick: ends! };
    const from = row.abilityFxOrigin[id];
    if (from) {
      entry.fromX = from.x;
      entry.fromY = from.y;
      entry.fromZ = from.z;
    }
    out.push(entry);
  }
  return out;
}

function projectSpentAbilities(row: CheckpointPlayerState): SkillId[] {
  const out: SkillId[] = [];
  for (const id of Object.keys(row.abilitySpent) as SkillId[]) {
    if (row.abilitySpent[id]) out.push(id);
  }
  return out;
}

function sortedPlayers(
  players: readonly CheckpointPlayerState[],
): CheckpointPlayerState[] {
  return [...players].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function copyScores(scores: TeamScores): TeamScores {
  return { A: scores.A, B: scores.B };
}

function copyProjectiles(
  projectiles: readonly SnapshotProjectile[],
): SnapshotProjectile[] {
  return projectiles.map((p) => ({ id: p.id, x: p.x, y: p.y, z: p.z }));
}

// ---------------------------------------------------------------------------
// Pair extraction (11.5 owns extraction; 11.4 owns math)
// ---------------------------------------------------------------------------

function poseFromRow(row: CheckpointPlayerState): ReplayInterpPose {
  return Object.freeze({
    id: row.id,
    x: row.x,
    y: row.y,
    z: row.z,
    yaw: row.yaw,
    pitch: row.pitch,
    alive: row.alive,
    spawnedAtTick: row.spawnedAtTick,
    diedAtTick: row.diedAtTick,
    crouch: row.crouch,
    onGround: row.onGround,
    velocityX: row.velocityX,
    velocityY: row.velocityY,
    velocityZ: row.velocityZ,
  });
}

/**
 * Id-matched 11.4 pairs from two views. Join/leave (missing on one side) yield
 * no pair — present side is served via snapshot projection only.
 */
export function extractReplayInterpPairs(
  prevView: ReplayViewState,
  nextView: ReplayViewState,
): readonly ReplayExtractedInterpPair[] {
  const prevById = new Map<string, CheckpointPlayerState>();
  for (const p of prevView.players) prevById.set(p.id, p);
  const nextById = new Map<string, CheckpointPlayerState>();
  for (const p of nextView.players) nextById.set(p.id, p);

  const ids = [...prevById.keys()]
    .filter((id) => nextById.has(id))
    .sort();

  const pairs: ReplayExtractedInterpPair[] = [];
  for (const id of ids) {
    pairs.push(
      Object.freeze({
        prev: poseFromRow(prevById.get(id)!),
        next: poseFromRow(nextById.get(id)!),
      }),
    );
  }
  return Object.freeze(pairs);
}

// ---------------------------------------------------------------------------
// Snapshot projection (6.5 state seam)
// ---------------------------------------------------------------------------

/**
 * Project a reconstructed view into a SnapshotPacket-shaped packet.
 * Indistinguishable from a staged live packet at `consumeSnapshotPacket`.
 * Deep-frozen; scores/projectiles are value copies (no live-owner refs).
 */
export function projectReplaySnapshot(view: ReplayViewState): SnapshotPacket {
  const players = sortedPlayers(view.players).map((row) =>
    projectSnapshotPlayer(row, view.tick)
  );
  const packet: SnapshotPacket = {
    tick: view.tick,
    players,
    projectiles: copyProjectiles(view.projectiles),
    scores: copyScores(view.scores),
    phase: view.phase,
    doorsOpen: view.doorsOpen,
    doorChangeTick: view.doorChangeTick,
    matchEndTick: view.matchEndTick,
  };
  return deepFreeze(packet);
}

// ---------------------------------------------------------------------------
// Render feed (6.5 render seam)
// ---------------------------------------------------------------------------

function findPlayer(
  view: ReplayViewState,
  playerId: string,
): CheckpointPlayerState | undefined {
  return view.players.find((p) => p.id === playerId);
}

/**
 * Feet Y from an eye-space pose + stance (remoteInterp / moveStep precedent).
 */
function feetYFromEye(eyeY: number, crouch: boolean): number {
  return eyeY - moveEyeHeight(crouch);
}

/**
 * Eye Y for feet planted at `feetY` with discrete (newer) crouch.
 * Same shape as `eyeYOnGround` in remoteInterp — local copy so this module
 * never imports the live-net smoother.
 */
function eyeYOnGround(feetY: number, crouch: boolean): number {
  return feetY + moveEyeHeight(crouch);
}

/**
 * Crouch-eye correction so the camera sits at the discrete-newer eye height
 * while `localSim` keeps the 11.4 blended body (compensate smear). When stance
 * is unchanged, offset is zero.
 */
function crouchEyeViewOffset(
  blendedEyeY: number,
  prev: ReplayInterpPose,
  next: ReplayInterpPose,
  u: number,
  snapped: boolean,
): { x: number; y: number; z: number } {
  if (prev.crouch === next.crouch) {
    return { x: 0, y: 0, z: 0 };
  }
  // Feet-stable desired eye under discrete-newer crouch.
  const t = snapped ? 1 : u;
  const feet =
    snapped
      ? feetYFromEye(next.y, next.crouch)
      : feetYFromEye(prev.y, prev.crouch) * (1 - t) +
        feetYFromEye(next.y, next.crouch) * t;
  const desiredEyeY = eyeYOnGround(feet, next.crouch);
  return { x: 0, y: desiredEyeY - blendedEyeY, z: 0 };
}

function xyzOf(
  pose: Pick<ReplayInterpPose, "x" | "y" | "z">,
): { x: number; y: number; z: number } {
  return { x: pose.x, y: pose.y, z: pose.z };
}

/** Exact-T / leave-between-T-and-T+1: body + Q4A orientation from one pose. */
function exactTickFeed(pose: ReplayInterpPose): ReplayRenderFeedState {
  const body = xyzOf(pose);
  return deepFreeze({
    localSim: body,
    prevSim: { ...body },
    localSimAccum: 0,
    localSimDt: TICK_MS,
    viewOffset: { x: 0, y: 0, z: 0 },
    yaw: pose.yaw,
    pitch: pose.pitch,
    alive: pose.alive,
  } satisfies ReplayRenderFeedState);
}

/**
 * Focused render feed for one player. Caller supplies `playerId` every call
 * (12.x owns selection). Caller supplies `u` (normally 11.3 `carryMs / TICK_MS`);
 * this module never derives or clamps it beyond what 11.4 does internally.
 *
 * - `view === null` → `null` (pre-first-step / 6.5 null contract).
 * - Unknown id → loud named error.
 * - `nextView === null` (ended) → project `view` exactly, never extrapolate.
 */
export function projectReplayRenderFeed(
  view: ReplayViewState | null,
  nextView: ReplayViewState | null,
  playerId: string,
  u: number,
): ReplayRenderFeedState | null {
  if (view === null) return null;

  const row = findPlayer(view, playerId);
  if (!row) {
    fail(
      "replay-state-focus-unknown",
      `ReplayStateAccess: unknown focus playerId "${playerId}"`,
      playerId,
    );
  }

  const prevPose = poseFromRow(row);

  if (nextView === null) {
    // Ended / no T+1 — exact tick view, zero eye correction.
    return exactTickFeed(prevPose);
  }

  const nextRow = findPlayer(nextView, playerId);
  if (!nextRow) {
    // Left between T and T+1: exact T pose (never invent past leave).
    return exactTickFeed(prevPose);
  }

  const nextPose = poseFromRow(nextRow);
  const { pose: blended, snapped } = interpolateReplayPose(
    prevPose,
    nextPose,
    u,
  );

  const localSim = xyzOf(blended);
  // Feed already holds the 11.4-blended body: set prev==local and accum=0 so
  // renderCameraFromSimLayers does not re-lerp (a=0 → prev, which equals local).
  const prevSim = { ...localSim };
  const viewOffset = crouchEyeViewOffset(
    blended.y,
    prevPose,
    nextPose,
    u,
    snapped,
  );

  return deepFreeze({
    localSim,
    prevSim,
    localSimAccum: 0,
    localSimDt: TICK_MS,
    viewOffset,
    yaw: blended.yaw,
    pitch: blended.pitch,
    alive: blended.alive,
  } satisfies ReplayRenderFeedState);
}

/**
 * Q1A focused `{ pose, snapped }` from the same view pairing `projectReplayRenderFeed`
 * uses. Exact 11.4 semantics: both-present → extract pairs + interpolateReplayPose;
 * join/leave → interpolateReplayRoster present-side + `snapped: true`; unknown id →
 * `replay-state-focus-unknown`. Null view → null. Single-view (nextView = null) is
 * exact-T with `snapped: false` (end-hold / pre-step).
 */
export function projectReplayFocusedDisplay(
  view: ReplayViewState | null,
  nextView: ReplayViewState | null,
  playerId: string,
  u: number,
): ReplayFocusedDisplay | null {
  if (view === null) return null;

  if (nextView === null) {
    const row = findPlayer(view, playerId);
    if (!row) {
      fail(
        "replay-state-focus-unknown",
        `ReplayStateAccess: unknown focus playerId "${playerId}"`,
        playerId,
      );
    }
    return Object.freeze({
      pose: poseFromRow(row),
      snapped: false,
    });
  }

  const inView = findPlayer(view, playerId) != null;
  const inNext = findPlayer(nextView, playerId) != null;

  if (inView && inNext) {
    const pair = extractReplayInterpPairs(view, nextView).find(
      (p) => p.prev.id === playerId,
    );
    if (!pair) {
      fail(
        "replay-state-focus-unknown",
        `ReplayStateAccess: unknown focus playerId "${playerId}"`,
        playerId,
      );
    }
    return interpolateReplayPose(pair.prev, pair.next, u);
  }

  const roster = interpolateReplayRoster(
    {
      poses: view.players.map(poseFromRow),
    },
    {
      poses: nextView.players.map(poseFromRow),
    },
    u,
  );
  const hit = roster.poses.find((p) => p.pose.id === playerId);
  if (!hit) {
    fail(
      "replay-state-focus-unknown",
      `ReplayStateAccess: unknown focus playerId "${playerId}"`,
      playerId,
    );
  }
  return hit;
}
