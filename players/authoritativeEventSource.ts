/**
 * Epic 7.3 — unified per-tick authoritative event source.
 *
 * Read/combine only: drains the 5.5 `PlayerManager` buffer and maps
 * `SimTickResult` facts per the disposition table. Live transport emits stay
 * on `emitSimTickEvents`; this module never emits and is unused by live play
 * beyond the driver's per-tick drain call (7.5 / 8.4 attach later).
 *
 * Flow:
 *   PlayerManager mutations → 5.5 buffer (construction-tick appliedTick)
 *   stepSim → SimTickResult (SIM_TICK_EVENT_ORDER)
 *        │
 *        ▼ drainTickAuthoritativeEvents(tick)
 *   AuthoritativeEvent[]  (5.5 sorted, then sim-outcome maps)
 *
 * Cross-source order (pinned): sortAuthoritativeEvents(buffer) then
 * sim outcomes in construction / SIM_TICK_EVENT_ORDER. Never infer from
 * socket emit order.
 *
 * Dedup: `GameOver` wire fact is omitted when the same tick already carries
 * `matchEnd` / `matchDraw` from the buffer (Decision 2 — one fact, one entry).
 */

import {
  makeCombatBurstEvent,
  makeGameOverEvent,
  makePlayerDiedEvent,
  makePlayerRespawnedEvent,
  makeScoreEvent,
  normalizeAuthoritativeEvent,
  sortAuthoritativeEvents,
  type AuthoritativeCombatOutcome,
  type AuthoritativeDamageOutcome,
  type AuthoritativeEvent,
  type AuthoritativeHitZone,
  type AuthoritativePose,
  type AuthoritativeShotFired,
  type AuthoritativeTeamId,
} from "../shared/sim/authoritativeEvent.ts";
import type {
  GameOverPacket,
  PlayerDiedPacket,
  ScorePacket,
  SnapshotPlayer,
} from "../protocol/network.ts";
import { rosterSnapshotFromPlayer } from "./authoritativeEventDerive.ts";
import type { ShootOutcome } from "./PlayerManager.ts";
import type { Player } from "./Player.ts";
import type { SimTickEvent } from "./simTickResult.ts";

/** Minimal drain surface — avoids importing the full PlayerManager type. */
export interface AuthoritativeEventBuffer {
  drainAuthoritativeEvents(): AuthoritativeEvent[];
  peekAuthoritativeEvents(): readonly AuthoritativeEvent[];
}

/**
 * Disposition of each `SimTickResult` event kind in the unified stream.
 * Locked by epic 7.3 — see notes/replay/07-server-responsibilities/07-03-*.
 */
export const SIM_TICK_EVENT_DISPOSITION = {
  CombatBurst: "record-as",
  PlayerDied: "record-as",
  Score: "record-as",
  /** Presentation of matchEnd/matchDraw when both exist; else record-as. */
  GameOver: "dedup-or-record",
  PlayerRespawned: "record-as",
} as const;

export type SimTickEventDisposition =
  (typeof SIM_TICK_EVENT_DISPOSITION)[keyof typeof SIM_TICK_EVENT_DISPOSITION];

function copyPoseFromSnapshot(player: SnapshotPlayer): AuthoritativePose {
  return {
    x: player.x,
    y: player.y,
    z: player.z,
    yaw: player.yaw,
    pitch: player.pitch,
  };
}

function mapShot(shot: ShootOutcome["shot"]): AuthoritativeShotFired {
  const mapped: AuthoritativeShotFired = {
    shooterId: shot.shooterId,
    origin: [shot.origin[0], shot.origin[1], shot.origin[2]],
    direction: [shot.direction[0], shot.direction[1], shot.direction[2]],
    weapon: shot.weapon,
    hitId: shot.hitId,
    hitZone: shot.hitZone,
    hitPoint: shot.hitPoint
      ? [shot.hitPoint[0], shot.hitPoint[1], shot.hitPoint[2]]
      : null,
  };
  if (shot.melee) mapped.melee = true;
  if (shot.pellets) {
    mapped.pellets = shot.pellets.map((p) => ({
      direction: [p.direction[0], p.direction[1], p.direction[2]],
      hitId: p.hitId,
      hitZone: p.hitZone,
      hitPoint: p.hitPoint ? [p.hitPoint[0], p.hitPoint[1], p.hitPoint[2]] : null,
    }));
  }
  return mapped;
}

function mapDamage(
  d: NonNullable<ShootOutcome["damages"]>[number],
): AuthoritativeDamageOutcome {
  const mapped: AuthoritativeDamageOutcome = {
    targetId: d.targetId,
    shooterId: d.shooterId,
    damage: d.damage,
    health: d.health,
    zone: d.zone as AuthoritativeHitZone,
    alive: d.alive,
    killed: d.killed,
    critical: d.critical,
  };
  if (d.hitSlowStacks !== undefined) mapped.hitSlowStacks = d.hitSlowStacks;
  if (d.hitSlowEndsAtTick !== undefined) {
    mapped.hitSlowEndsAtTick = d.hitSlowEndsAtTick;
  }
  return mapped;
}

function mapCombatOutcome(outcome: ShootOutcome): AuthoritativeCombatOutcome {
  const mapped: AuthoritativeCombatOutcome = { shot: mapShot(outcome.shot) };
  if (outcome.damages) mapped.damages = outcome.damages.map(mapDamage);
  if (outcome.leech) mapped.leech = true;
  return mapped;
}

function mapPlayerDied(
  tick: number,
  death: PlayerDiedPacket,
): AuthoritativeEvent {
  const event = makePlayerDiedEvent({
    appliedTick: tick,
    victimId: death.victimId,
    killerId: death.killerId,
    zone: death.zone as AuthoritativeHitZone,
    weapon: death.weapon,
    killerName: death.killerName,
    victimName: death.victimName,
    killerTeam: death.killerTeam as AuthoritativeTeamId,
    victimTeam: death.victimTeam as AuthoritativeTeamId,
  });
  if (death.killerIsAgent) event.killerIsAgent = true;
  if (death.victimIsAgent) event.victimIsAgent = true;
  return event;
}

function mapScore(tick: number, score: ScorePacket): AuthoritativeEvent {
  const event = makeScoreEvent({
    appliedTick: tick,
    scorerId: score.scorerId,
    team: score.team as AuthoritativeTeamId,
    scores: { A: score.scores.A, B: score.scores.B },
    playerPose: copyPoseFromSnapshot(score.player),
    playerAlive: score.player.alive,
  });
  if (score.resetPlayers && score.resetPlayers.length > 0) {
    event.resetPlayerPoses = score.resetPlayers.map((p) => ({
      id: p.id,
      pose: copyPoseFromSnapshot(p),
    }));
  }
  return event;
}

function mapGameOver(tick: number, packet: GameOverPacket): AuthoritativeEvent {
  const winner = packet.winner === "draw"
    ? "draw" as const
    : packet.winner as AuthoritativeTeamId;
  const event = makeGameOverEvent({
    appliedTick: tick,
    winner,
    scores: { A: packet.scores.A, B: packet.scores.B },
    restartInSeconds: packet.restartInSeconds,
  });
  if (packet.returnToMenu) event.returnToMenu = true;
  if (packet.matchKind === "raid") event.matchKind = "raid";
  return event;
}

function mapPlayerRespawned(tick: number, player: Player): AuthoritativeEvent {
  return makePlayerRespawnedEvent({
    appliedTick: tick,
    player: rosterSnapshotFromPlayer(player),
  });
}

/**
 * Map one `SimTickResult` event into an `AuthoritativeEvent`, or null when
 * disposition drops it (GameOver dedup against matchEnd/matchDraw).
 */
export function mapSimTickEventToAuthoritative(
  tick: number,
  event: SimTickEvent,
  opts?: { skipGameOver?: boolean },
): AuthoritativeEvent | null {
  switch (event.type) {
    case "CombatBurst":
      return makeCombatBurstEvent({
        appliedTick: tick,
        outcomes: event.outcomes.map(mapCombatOutcome),
      });
    case "PlayerDied":
      return mapPlayerDied(tick, event.death);
    case "Score":
      return mapScore(tick, event.score);
    case "GameOver":
      if (opts?.skipGameOver) return null;
      return mapGameOver(tick, event.gameOver);
    case "PlayerRespawned":
      return mapPlayerRespawned(tick, event.player);
  }
}

/**
 * Single per-tick drain for epic 7.3 / 7.5 / 8.4.
 *
 * - Drains the 5.5 buffer (clears it) and sorts with `sortAuthoritativeEvents`.
 * - Maps `simEvents` in construction order (already `SIM_TICK_EVENT_ORDER`).
 * - Dedups `GameOver` when the buffer already has `matchEnd`/`matchDraw` for
 *   `tick`.
 * - Returns buffer-then-sim; does not persist or subscribe.
 *
 * Loss rule: call every tick (empty ok). Surviving buffer events after a
 * successful drain are a bug — `peekAuthoritativeEvents()` must be empty.
 */
export function drainTickAuthoritativeEvents(
  buffer: AuthoritativeEventBuffer,
  tick: number,
  simEvents: readonly SimTickEvent[],
): AuthoritativeEvent[] {
  const bufferEvents = sortAuthoritativeEvents(buffer.drainAuthoritativeEvents());
  const hasMatchEndFact = bufferEvents.some(
    (e) =>
      (e.kind === "matchEnd" || e.kind === "matchDraw") &&
      e.appliedTick === tick,
  );

  const simMapped: AuthoritativeEvent[] = [];
  for (const ev of simEvents) {
    const mapped = mapSimTickEventToAuthoritative(tick, ev, {
      skipGameOver: hasMatchEndFact,
    });
    if (!mapped) continue;
    const normalized = normalizeAuthoritativeEvent(mapped);
    if (normalized) simMapped.push(normalized);
  }

  return [...bufferEvents, ...simMapped];
}
