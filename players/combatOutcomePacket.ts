/**
 * Pack a sim shoot outcome into a wire CombatBurst entry.
 *
 * Kill-feed names/teams must be stamped here while the roster still holds
 * the killer and victim. Grey agents are pruned later in the same tick, so
 * looking them up at emit time yields "Unknown".
 */

import type {
  CombatOutcomePacket,
  PlayerDamagedPacket,
  PlayerDiedPacket,
  TeamId,
} from "../protocol/network.ts";
import type { ShootOutcome } from "./PlayerManager.ts";

export type CombatRosterEntry = {
  readonly name: string;
  readonly team: TeamId;
  readonly isAgent: boolean;
};

export type CombatRosterLookup = {
  get(id: string): CombatRosterEntry | undefined;
};

export function packCombatOutcomePacket(
  outcome: ShootOutcome,
  roster: CombatRosterLookup,
): CombatOutcomePacket {
  const packet: CombatOutcomePacket = { shot: outcome.shot };
  if (outcome.leech) packet.leech = true;
  const damages = outcome.damages;
  if (!damages?.length) return packet;

  const dmgOut: PlayerDamagedPacket[] = [];
  const deaths: PlayerDiedPacket[] = [];
  for (const d of damages) {
    dmgOut.push({
      targetId: d.targetId,
      shooterId: d.shooterId,
      damage: d.damage,
      health: d.health,
      zone: d.zone,
      alive: d.alive,
      critical: d.critical,
      hitSlowStacks: d.hitSlowStacks,
      hitSlowEndsAtTick: d.hitSlowEndsAtTick,
    });
    if (!d.killed) continue;
    const killer = roster.get(d.shooterId);
    const victim = roster.get(d.targetId);
    deaths.push({
      victimId: d.targetId,
      killerId: d.shooterId,
      zone: d.zone,
      weapon: outcome.shot.weapon,
      killerName: displayName(killer?.name),
      victimName: displayName(victim?.name),
      killerTeam: killer?.team ?? "A",
      victimTeam: victim?.team ?? "B",
      killerIsAgent: killer?.isAgent || undefined,
      victimIsAgent: victim?.isAgent || undefined,
    });
  }
  packet.damages = dmgOut;
  if (deaths.length > 0) packet.deaths = deaths;
  return packet;
}

function displayName(name: string | undefined): string {
  const trimmed = name?.trim();
  return trimmed ? trimmed : "Unknown";
}
