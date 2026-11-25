/**
 * Zombots shared contract (notes/zombots.md, Phase 1).
 *
 * Pure types only. Everything in `shared/zombots/` is game truth that both the
 * server runtime (`runtime/zombotsRuntime.ts`, Release 1) and the local client
 * driver (Release 2) drive, so it must not import server-only modules
 * (`protocol/`, `runtime/`, `authority/`, `host/`), Deno or browser APIs, or
 * anything private. It is mirrored to the public repo.
 */

/** Session player id (humans) or bot id (zombies). */
export type ZombotsPlayerId = string;

export type ZombotsPhase = "waiting" | "intermission" | "wave" | "over";

/** Where a zombie may enter: `map.zombieSpawns[]`. */
export type ZombotsSpawnPoint = { id: string; p: { x: number; z: number } };

/** Rack weapon kinds. Map to sim ids with {@link ZOMBOTS_RACK_WEAPON_ID}. */
export type ZombotsRackWeapon = "pistol" | "rifle" | "shotgun";

/**
 * What a rack hangs. A gun, or `power`: the power recharge rack, which
 * restores the player's spent skills for zompoints (`powerRack.ts`).
 */
export type ZombotsRackKind = ZombotsRackWeapon | "power";

/**
 * Side effects the rules ask the glue to perform. The rules never perform
 * them; the server runtime turns them into BotManager calls and packets, the
 * local driver into local bots and HUD state.
 */
export type ZombotsIntent =
  | { kind: "waveStart"; wave: number; zombieCount: number }
  | {
    kind: "spawnZombie";
    wave: number;
    spawnId: string;
    p: { x: number; z: number };
    health: number;
    speedScale: number;
    modelScale: number;
    meleeDamage: number;
  }
  | { kind: "waveCleared"; wave: number }
  | { kind: "playerDowned"; playerId: ZombotsPlayerId }
  | { kind: "playerRevived"; playerId: ZombotsPlayerId; by: ZombotsPlayerId; health: number }
  | { kind: "pointsChanged"; playerId: ZombotsPlayerId; points: number; delta: number; reason: ZombotsPointsReason }
  | { kind: "doorOpened"; doorId: string; by: ZombotsPlayerId }
  | { kind: "weaponTaken"; playerId: ZombotsPlayerId; rackId: string; weapon: ZombotsRackWeapon }
  /** A gun rack press refused with nothing charged: spare mags already full. */
  | { kind: "rackRefused"; playerId: ZombotsPlayerId; rackId: string }
  | { kind: "runOver"; waveReached: number };

export type ZombotsPointsReason =
  | "hit"
  | "kill"
  | "waveSurvived"
  | "door"
  | "revivePress"
  | "powerRecharge"
  | "gunRack"
  | "start";

/** Game events the glue feeds into the rules each tick. */
export type ZombotsEvent =
  | { kind: "playerJoined"; playerId: ZombotsPlayerId }
  | { kind: "playerLeft"; playerId: ZombotsPlayerId }
  | { kind: "zombieHit"; by: ZombotsPlayerId; zombieId: string }
  | { kind: "zombieKilled"; by: ZombotsPlayerId | null; zombieId: string }
  | { kind: "zombieSpawned"; zombieId: string; spawnId: string }
  | { kind: "playerDowned"; playerId: ZombotsPlayerId };

/** A lookup the rules use to know which zombie spawns are reachable. */
export type ZombotsSpawnGate = (spawnId: string) => boolean;
