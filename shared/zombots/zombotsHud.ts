/**
 * Zombots HUD block (notes/zombots.md step 13): the one compact state the
 * server sends on `NetEvents.ZombotsState`, on Welcome for late joiners, and
 * on GameOver when the run ends. The local driver (Release 2) can build the
 * same block, so the HUD reads one shape online and offline.
 *
 * Pure types plus a builder over the rules objects. No clock: the next wave
 * is a sim tick the caller computes.
 */

import type { ReviveTracker } from "./revive.ts";
import type { ZombotsIntent, ZombotsPhase, ZombotsPlayerId } from "./types.ts";
import type { ZombotsMatch } from "./ZombotsMatch.ts";
import type { ZompointsLedger } from "./zompoints.ts";
import type { ZombotsDoorPaid } from "./zombotsDoors.ts";

/** One human in the run, join order. */
export type ZombotsHudPlayer = {
  id: ZombotsPlayerId;
  points: number;
  /** Total zompoints gathered in this run (start + all awards, never reduced by spends). */
  totalPoints?: number;
  /** Total headshot hits landed on zombies in this run. */
  headshots?: number;
  downed: boolean;
};

/** A revive in progress: `presses` of `ZOMBOTS_TUNING.revive.presses`. */
export type ZombotsHudRevive = {
  reviverId: ZombotsPlayerId;
  targetId: ZombotsPlayerId;
  presses: number;
};

/** Rules events the HUD shows as a feed. Spawns stay server-side. */
export type ZombotsFeedEvent = Exclude<ZombotsIntent, { kind: "spawnZombie" }>;

export type ZombotsHudPacket = {
  phase: ZombotsPhase;
  /** Last wave started (the wave reached once `phase` is "over"). */
  wave: number;
  zombiesLeft: number;
  /** Sim tick the next wave starts. 0 outside an intermission. */
  nextWaveAtTick: number;
  /** Opened sliding doors, map order. Only ever grows within a run. */
  openDoorIds: string[];
  /**
   * Shut doors with charges paid toward them, map order. Doors are bought in
   * `ZOMBOTS_TUNING.doors.chargeSize` charges any player can pay.
   */
  doorPaid: ZombotsDoorPaid[];
  players: ZombotsHudPlayer[];
  /** Only revives with at least one paid press. */
  revives: ZombotsHudRevive[];
  /** What happened since the previous block. Omitted when nothing did. */
  events?: ZombotsFeedEvent[];
  /** How many times a dis-rack-tor has been activated this run. Omitted when 0. */
  distractorUses?: number;
  /** Sim tick the active dis-rack-tor lure ends. Omitted when inactive. */
  distractorEndsAtTick?: number;
  /** Rack id of the currently active dis-rack-tor. Present with `distractorEndsAtTick`. */
  distractorRackId?: string;
};

/**
 * The block for this moment. `nextWaveAtTick` comes from the caller, which
 * fixes it once per intermission so the countdown never needs a packet.
 */
export function buildZombotsHud(input: {
  match: ZombotsMatch;
  ledger: ZompointsLedger;
  revive: ReviveTracker;
  headshots?: ReadonlyMap<ZombotsPlayerId, number>;
  openDoorIds: readonly string[];
  doorPaid?: readonly ZombotsDoorPaid[];
  nextWaveAtTick: number;
  events?: readonly ZombotsFeedEvent[];
  distractorUses?: number;
  distractorEndsAtTick?: number;
  distractorRackId?: string;
}): ZombotsHudPacket {
  const { match, ledger, revive } = input;
  const players: ZombotsHudPlayer[] = [];
  const revives: ZombotsHudRevive[] = [];
  for (const id of match.humans) {
    players.push({
      id,
      points: ledger.get(id),
      totalPoints: ledger.total(id),
      headshots: input.headshots?.get(id) ?? 0,
      downed: match.downed.has(id),
    });
    const row = revive.progress(id);
    if (row && row.presses > 0) {
      revives.push({ reviverId: id, targetId: row.targetId, presses: row.presses });
    }
  }
  const nextWaveAtTick = match.phase === "intermission" ? input.nextWaveAtTick : 0;
  const packet: ZombotsHudPacket = {
    phase: match.phase,
    wave: match.wave,
    zombiesLeft: match.zombiesLeft,
    nextWaveAtTick,
    openDoorIds: [...input.openDoorIds],
    doorPaid: (input.doorPaid ?? []).map((d) => ({ doorId: d.doorId, paid: d.paid })),
    players,
    revives,
  };
  if (input.events && input.events.length > 0) packet.events = [...input.events];
  if (input.distractorUses && input.distractorUses > 0) {
    packet.distractorUses = input.distractorUses;
  }
  if (input.distractorEndsAtTick && input.distractorEndsAtTick > 0) {
    packet.distractorEndsAtTick = input.distractorEndsAtTick;
    if (input.distractorRackId) packet.distractorRackId = input.distractorRackId;
  }
  return packet;
}
