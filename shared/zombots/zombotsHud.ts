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

/** One human in the run, join order. */
export type ZombotsHudPlayer = {
  id: ZombotsPlayerId;
  points: number;
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
  players: ZombotsHudPlayer[];
  /** Only revives with at least one paid press. */
  revives: ZombotsHudRevive[];
  /** What happened since the previous block. Omitted when nothing did. */
  events?: ZombotsFeedEvent[];
};

/**
 * The block for this moment. `nextWaveAtTick` comes from the caller, which
 * fixes it once per intermission so the countdown never needs a packet.
 */
export function buildZombotsHud(input: {
  match: ZombotsMatch;
  ledger: ZompointsLedger;
  revive: ReviveTracker;
  openDoorIds: readonly string[];
  nextWaveAtTick: number;
  events?: readonly ZombotsFeedEvent[];
}): ZombotsHudPacket {
  const { match, ledger, revive } = input;
  const players: ZombotsHudPlayer[] = [];
  const revives: ZombotsHudRevive[] = [];
  for (const id of match.humans) {
    players.push({ id, points: ledger.get(id), downed: match.downed.has(id) });
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
    players,
    revives,
  };
  if (input.events && input.events.length > 0) packet.events = [...input.events];
  return packet;
}
