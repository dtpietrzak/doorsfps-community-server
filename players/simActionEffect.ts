/**
 * Epic 8.3 — unified sim action-effect notes.
 *
 * Emitted at the PlayerManager.handle* seam so humans (flush / ingress) and
 * bots (apply pipe) share one recording vocabulary. The 7.5 tick fan-out
 * forwards these notes; 8.3 projects them through canonicalFromWireParts.
 *
 * No bot-brain types here — only the handle* argument surface.
 */

import type { SkillId } from "../shared/sim/skills.ts";
import type { ShootPacket } from "../protocol/network.ts";

export type SimActionEffect =
  | {
    kind: "fire";
    tick: number;
    playerId: string;
    fireKind: "shoot" | "melee";
    packet: ShootPacket | null;
    /**
     * Resolved RTT lag-comp rewind stamp, filled in by handleShoot/handleMelee
     * when the shooter uses the RTT window. It depends on unrecorded network
     * state (ping filter, volume drops, last snapshot tick), so replay must
     * reuse the decision rather than re-derive it.
     */
    rewindStamp?: number | null;
  }
  | {
    kind: "reload";
    tick: number;
    playerId: string;
  }
  | {
    kind: "weaponSelect";
    tick: number;
    playerId: string;
    /** Requested id, or resolved id after a cycle. */
    weapon: number;
  }
  | {
    kind: "ability";
    tick: number;
    playerId: string;
    ability: SkillId;
  };

export type SimActionEffectObserver = (effect: SimActionEffect) => void;
