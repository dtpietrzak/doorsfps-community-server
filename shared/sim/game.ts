/**
 * Shared gameplay constants — single source of truth for client + server.
 *
 * Edit values only here. Client and server re-export from their network modules
 * so call sites can keep importing from `./network` / `shared/network.ts`.
 *
 * Durations are wall-clock (ms or seconds). The server converts ms to sim ticks
 * via msToTicks(); the client uses ms/s directly for prediction / HUD.
 *
 * The simulation clock is a monotonic integer tick sequence. Wall clock only
 * determines when the server scheduler invokes a tick; simulation time is
 * derived from the tick number and never from elapsed wall-clock time.
 */

import { abs, floor, max, min, round, trunc } from "../math/index.ts";

/** Fixed sim rate — server loop and tick-derived cooldowns use this. */
export const TICK_HZ = 60;

/** Wall-clock duration of one fixed simulation step. */
export const TICK_MS = 1000 / TICK_HZ;

/** Fixed simulation step in seconds. Physics must use this, never wall dt. */
export const DT = 1 / TICK_HZ;

/** Integer tick number used by the authoritative simulation. */
export type SimTick = number;

/** Convert wall-clock milliseconds to simulation ticks. */
export function msToTicks(ms: number): number {
  return Math.ceil((ms * TICK_HZ) / 1000);
}

/** Convert simulation ticks to wall-clock milliseconds at the fixed rate. */
export function ticksToMs(ticks: number): number {
  return ticks * TICK_MS;
}

/** Simulation time represented by a tick, measured from the clock origin. */
export function simTime(tick: SimTick): number {
  return tick * DT;
}

export const MAX_HEALTH = 100;

/** Bullet damage varies by this many integer points in either direction. */
export const DAMAGE_VARIATION_MAX_POINTS = 5;
/** The highest 10% of rolls become +5 critical hits. */
export const CRITICAL_DAMAGE_ROLL_CHANCE = 0.1;

export type DamageVariationRoll = {
  damage: number;
  offset: number;
  critical: boolean;
};

/** Resolve an integer damage roll from a unit random sample (0…1). */
export function rollDamageVariation(
  baseDamage: number,
  randomSample: number,
): DamageVariationRoll {
  const base = Number.isFinite(baseDamage)
    ? max(0, round(baseDamage))
    : 0;
  const sample = Number.isFinite(randomSample)
    ? max(0, min(1, randomSample))
    : 0.5;
  const criticalThreshold = 1 - CRITICAL_DAMAGE_ROLL_CHANCE;
  const critical = sample >= criticalThreshold;
  // Reserve the top 10% for +5. Split the other 90% evenly across the ten
  // non-critical integer results (-5 through +4), so neutral sample 0.5 is 0.
  const offset = critical
    ? DAMAGE_VARIATION_MAX_POINTS
    : -DAMAGE_VARIATION_MAX_POINTS + min(
      DAMAGE_VARIATION_MAX_POINTS * 2 - 1,
      floor(
        sample /
          (criticalThreshold / (DAMAGE_VARIATION_MAX_POINTS * 2)),
      ),
    );
  return {
    damage: max(0, base + offset),
    offset,
    critical,
  };
}

/**
 * Sprint stamina contract.
 * Bar capacity is SPRINT_DURATION_S stamina-seconds (0 … SPRINT_DURATION_S).
 * Drain while actually sprinting (shift + move, not crouch) is
 * SPRINT_DRAIN_MULT stamina-seconds per wall-clock second, so a full bar lasts
 * SPRINT_DURATION_S / SPRINT_DRAIN_MULT seconds of sprint.
 * Regen only while not holding sprint, not sliding, and on the ground;
 * multipliers stack.
 */
/** Stamina-seconds held by a full bar (not wall-clock sprint length). */
export const SPRINT_DURATION_S = 1;
/**
 * Stamina drained per wall-clock second while effectively sprinting.
 * 0.35: a full bar is ~2.9 s of sprint (was 0.65, ~1.5 s).
 */
export const SPRINT_DRAIN_MULT = 0.35;
/** Baseline stamina recovered per second (standing still). */
export const SPRINT_REGEN_PER_S = 0.25;
/** Crouch multiplies recovery (doubles cooldown rate). */
export const SPRINT_CROUCH_REGEN_MULT = 1.75;
/** Any horizontal move slows recovery to 80% (walking refills at 0.2/s). */
export const SPRINT_MOVE_REGEN_MULT = 0.8;
/** Horizontal walk speed (u/s). Sprint/crouch multiply this. */
export const WALK_SPEED = 6;
/** Sprint multiplier (Shift). */
export const SPRINT_SPEED_MULT = 1.5;
/** Crouch multiplier (default key: C). */
export const CROUCH_SPEED_MULT = 0.5;

/** Movement penalty applied by each bullet hit while the hit-slow is active. */
export const HIT_SLOW_PER_STACK = 0.05;
/** Maximum number of simultaneous bullet-hit movement penalties. */
export const HIT_SLOW_MAX_STACKS = 3;
/** A new bullet hit refreshes the full shared stack window. */
export const HIT_SLOW_DURATION_MS = 1500;

/** Horizontal movement multiplier for the active bullet-hit slow stacks. */
export function hitSlowMoveSpeedScale(stacks: number): number {
  const safeStacks = Number.isFinite(stacks)
    ? max(0, min(HIT_SLOW_MAX_STACKS, floor(stacks)))
    : 0;
  return 1 - safeStacks * HIT_SLOW_PER_STACK;
}

/**
 * Crouch-slide burst length (seconds). Press crouch while holding W/A/D
 * (or forward-strafe diagonals) to slide at sprint speed in that direction.
 */
export const SLIDE_DURATION_S = 0.4;
/**
 * Standing melee-lunge burst length (seconds) at sprint speed.
 * Half the crouch-slide distance/time.
 */
export const MELEE_LUNGE_DURATION_S = SLIDE_DURATION_S * 0.5;
/**
 * Fraction of a full sprint bar required and consumed to start a slide
 * or a standing melee lunge (same cost / gates).
 * With SPRINT_DURATION_S = 1, this is 0.3s of stamina (30% bar).
 */
export const SLIDE_STAMINA_COST = 0.3;
/**
 * Fraction of a full sprint bar consumed when you jump (not a gate —
 * you can jump at 0 energy; cost is clamped so stamina never goes negative).
 * With SPRINT_DURATION_S = 1, this is 0.1s of stamina (10% bar).
 * No stamina regen while airborne until the jump lands.
 */
export const JUMP_STAMINA_COST = 0.1;

/** Absolute stamina seconds needed (and spent) to start a slide. */
export function slideStaminaCostSeconds(): number {
  return SPRINT_DURATION_S * SLIDE_STAMINA_COST;
}

/** Absolute stamina seconds spent on a jump (clamped at 0; not required to jump). */
export function jumpStaminaCostSeconds(): number {
  return SPRINT_DURATION_S * JUMP_STAMINA_COST;
}

/** Stamina drained per second while effectively sprinting. */
export function sprintDrainPerSecond(): number {
  return SPRINT_DRAIN_MULT;
}

/** Effective sprint cooldown recovery per second from stance + movement. */
export function sprintRegenPerSecond(
  crouch: boolean,
  moving: boolean,
): number {
  let mult = 1;
  if (crouch) mult *= SPRINT_CROUCH_REGEN_MULT;
  if (moving) mult *= SPRINT_MOVE_REGEN_MULT;
  return SPRINT_REGEN_PER_S * mult;
}

/**
 * Resolve horizontal move speed from stance flags
 * (sliding > crouch > sprint > walk) and equipped weapon mobility mult.
 *
 * @param airborne When true, crouch only lowers the silhouette — horizontal
 *   speed stays at walk/sprint. Half-wall vaults need ~walk distance during
 *   the short feet-clear window; crouch-speed mid-jump fails that clear.
 */
export function moveSpeedForInput(
  sprint: boolean,
  crouch: boolean,
  weaponMoveMult = 1,
  sliding = false,
  airborne = false,
): number {
  const mult = max(0.1, weaponMoveMult);
  // Slide uses sprint-tier speed while crouched (beats crouch branch).
  if (sliding) return WALK_SPEED * SPRINT_SPEED_MULT * mult;
  // Ground crouch is half speed; mid-air crouch must not slow vaults.
  if (crouch && !airborne) return WALK_SPEED * CROUCH_SPEED_MULT * mult;
  if (sprint) return WALK_SPEED * SPRINT_SPEED_MULT * mult;
  return WALK_SPEED * mult;
}

/**
 * Death → respawn delay while doors are open (wall-clock ms).
 * Equals the live killcam rewind (3 s before the kill + 2 s after, at 1×):
 * die → killcam → respawn lands just as the killcam's last frame plays, with
 * no "Respawning…" gap. Shorter clips the kill; keep them in step.
 */
export const RESPAWN_DELAY_MS = 5000;
/**
 * Death → respawn delay while doors are closed (agents in the field).
 * Live match only; pre-match warm-up still uses {@link RESPAWN_DELAY_MS}.
 */
export const RESPAWN_DELAY_CLOSED_MS = 15_000;
/** Co-op raid death → respawn delay. Teammates can be spectated while waiting. */
export const RAID_RESPAWN_DELAY_MS = 30_000;
/** After scoring, scorer is sent home; also prevents double-tap. */
export const SCORE_COOLDOWN_MS = 500;
/**
 * Continuous time in the enemy door zone required before a capture counts.
 * Gives remotes time to show the body at the portal and lets the player
 * walk into the door instead of scoring on first contact.
 */
export const DOOR_CAPTURE_DWELL_MS = 250;
/**
 * How far past the door plane a player center may walk (world units).
 * Only inside the door gap strip — not through walls or corners.
 */
export const DOOR_WALK_IN = 0.45;
/** Rendered/collidable width of each vertical door post along the wall. */
export const DOOR_POST_WIDTH = 0.5;
/**
 * When doors are closed: min distance from the door plane to the player center
 * (world units) inside the door gap. Keeps bodies out of the sealed dark pane
 * (perimeter has a hole at doors, so normal radius-only bounds still clip).
 * Open doors use {@link DOOR_WALK_IN} instead.
 */
export const DOOR_CLOSED_STANDOFF = 1.0;
/** Spawn protection against camping — invulnerable but can still shoot. */
export const SPAWN_INVULN_MS = 1000;

/**
 * Door open phase (wall-clock ms). Match starts open; captures only while open.
 * Closed phase uses DOOR_CLOSED_MS, but doors stay sealed while grey agents
 * remain alive. After the last agent dies, {@link DOOR_POWER_UP_MS} elapses
 * before doors open again.
 */
export const DOOR_OPEN_MS = 30_000;
/**
 * Nominal door closed phase (wall-clock ms) — no captures.
 * Extended indefinitely while agents are alive; respawn uses
 * {@link RESPAWN_DELAY_CLOSED_MS} instead of waiting for re-open.
 */
export const DOOR_CLOSED_MS = 15_000;
/**
 * After the last grey agent is cleared: doors stay closed this long while
 * they "power up", then open for a fresh open phase.
 */
export const DOOR_POWER_UP_MS = 3_000;

/** First team to this score wins, but must lead by WIN_BY_MARGIN. */
export const WIN_SCORE = 21;
/** Required point lead once at or past WIN_SCORE (tennis-style win by two). */
export const WIN_BY_MARGIN = 2;
/**
 * Match wall-clock length. At expiry, the team with more door captures wins
 * (draw if tied). Score win (WIN_SCORE + margin) can end the match earlier.
 */
export const MATCH_DURATION_SECONDS = 15 * 60;
/** Intermission after match end before a new game starts. */
export const MATCH_RESTART_SECONDS = 30;

/**
 * Grace period after a drop: player stays in the match as a sitting duck.
 * If they reconnect before this elapses they rejoin; otherwise they are removed.
 */
export const CONNECTION_ISSUE_TIMEOUT_MS = 30_000;

/**
 * Open-match team rebalance: delay after selecting the worst human on the
 * heavy side before forcing the swap (client shows a pulsing notice).
 * Triggered only when players vote (not automatic on join/leave).
 */
export const AUTO_REBALANCE_DELAY_MS = 5_000;
/**
 * Minimum |humanA − humanB| before a voted rebalance may fire.
 * Diff of 1 is left alone (odd totals thrash if forced).
 */
export const AUTO_REBALANCE_MIN_HUMAN_DIFF = 2;
/**
 * Fraction of human players that must vote to request team rebalance.
 * Passes when `votes > humanCount * REBALANCE_VOTE_FRACTION` (strictly more
 * than one third).
 */
export const REBALANCE_VOTE_FRACTION = 1 / 3;
/** Banner copy shown to the player about to be force-swapped. */
export const AUTO_REBALANCE_NOTICE_MESSAGE =
  "Team rebalance — you're swapping teams!";

/**
 * Minimum integer votes needed so that votes > humanCount / 3.
 * Returns 0 when there are no humans (cannot pass).
 */
export function rebalanceVotesNeeded(humanCount: number): number {
  const n = max(0, floor(humanCount));
  if (n <= 0) return 0;
  return floor(n * REBALANCE_VOTE_FRACTION) + 1;
}

/** True when vote count is strictly more than one third of humans. */
export function rebalanceVotePasses(
  votes: number,
  humanCount: number,
): boolean {
  const n = max(0, floor(humanCount));
  if (n <= 0) return false;
  return max(0, floor(votes)) * 3 > n;
}

/**
 * No meaningful activity (move / look / shoot / reload / switch) for this long
 * → player is marked AFK on the TAB scoreboard. Mouse look counts. While dead,
 * AFK status is frozen to the pre-death value (closed-door waits do not auto-AFK).
 */
export const AFK_TIMEOUT_MS = 10_000;

/**
 * After the AFK flag starts, this much additional idle time → hard-kick from
 * the match (server removes the player). Client shows a countdown under Esc
 * Options while AFK. Total idle before kick = AFK_TIMEOUT_MS + AFK_KICK_MS.
 * Not applied during intermission (endgame / waiting for next match).
 */
export const AFK_KICK_MS = 60_000;

/**
 * Ranked pre-match warm-up lobby (vote-to-start). Community / open servers ignore this.
 * See docs/play/ranking.md.
 */
export const PREMATCH_CONFIG = {
  /** Minimum human players before ready votes can start the match. */
  minHumans: 4,
  /** Human counts on team A and B must be equal (bots ignored). */
  requireEvenTeams: true,
  /** Every connected human must vote ready. */
  requireUnanimousReady: true,
  /** Clear all ready votes when a human joins or leaves. */
  clearReadyOnRosterChange: true,
  /** Mag never empties during warm-up. */
  unlimitedAmmo: true,
  /** Captures disabled; doors stay shut until live. */
  doorsLockedClosed: true,
  /** Door captures and match W/L scoring stay off until live. */
  unscored: true,
} as const;

/** Display name limits (open/custom name entry). */
export const PLAYER_NAME_MIN = 1;
export const PLAYER_NAME_MAX = 24;

/**
 * Ranked / Clerk account usernames (unique handles, not login identifiers).
 * Aligned with typical Clerk username rules + in-game HUD width.
 */
export const ACCOUNT_USERNAME_MIN = 3;
export const ACCOUNT_USERNAME_MAX = 24;

/**
 * Allowed characters for open/custom guest names and ranked usernames:
 * letters, digits, underscore only (no spaces or special characters).
 * Must start with a letter or digit.
 */
export const NAME_CHAR_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_]*$/;

/**
 * Normalize a join display name. Returns null if invalid.
 * Uniqueness is case-insensitive; display keeps the user's casing.
 * Used for open / custom guest names only.
 * Format only — content moderation (profanity) is enforced on the backend.
 */
export function normalizePlayerName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.trim();
  if (name.length < PLAYER_NAME_MIN || name.length > PLAYER_NAME_MAX) {
    return null;
  }
  if (!NAME_CHAR_PATTERN.test(name)) return null;
  return name;
}

/**
 * Normalize a ranked account username (Clerk `user.username`).
 * Login is email / phone / OAuth; this is only the unique in-game handle.
 * Returns null if invalid.
 * Format only — content moderation (profanity) is enforced on the backend.
 */
export function normalizeAccountUsername(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.trim();
  if (
    name.length < ACCOUNT_USERNAME_MIN ||
    name.length > ACCOUNT_USERNAME_MAX
  ) {
    return null;
  }
  // Same charset as open names: alphanumeric + underscore, start letter/digit.
  if (!NAME_CHAR_PATTERN.test(name)) return null;
  return name;
}

export function playerNameKey(name: string): string {
  return name.toLocaleLowerCase();
}

export function accountUsernameKey(name: string): string {
  return name.toLocaleLowerCase();
}

// ---------------------------------------------------------------------------
// Account character equipment (Clerk users only; guests/bots use defaults)
// ---------------------------------------------------------------------------

/** Equipment inventory bag dimensions and account-progression limits. */
export const EQUIPMENT_BAG_COLS = 10;
export const EQUIPMENT_BAG_START_ROWS = 3;
export const EQUIPMENT_BAG_MAX_ROWS = 8;

/** Clamp an untrusted persisted/API bag-row count to the supported range. */
export function normalizeEquipmentBagRows(raw: unknown): number {
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(value)) return EQUIPMENT_BAG_START_ROWS;
  return max(
    EQUIPMENT_BAG_START_ROWS,
    min(EQUIPMENT_BAG_MAX_ROWS, trunc(value)),
  );
}

/**
 * Coin price for unlocking `targetRows` total bag rows.
 * The three starting rows are free; rows 4…8 cost 10, 20, 30, 40, 50.
 */
export function coinCostForEquipmentBagRows(targetRows: number): number {
  const rows = trunc(targetRows);
  if (
    !Number.isFinite(rows) || rows <= EQUIPMENT_BAG_START_ROWS ||
    rows > EQUIPMENT_BAG_MAX_ROWS
  ) {
    return 0;
  }
  return (rows - EQUIPMENT_BAG_START_ROWS) * 10;
}

/** Flat shop buyback for any removable equipment bag item. */
export const EQUIPMENT_SELL_COINS = 5;

/**
 * Stepped tint slots: player (body) neon, gun neon, and bullet tracers.
 * Each shares {@link EQUIPMENT_HUE_STEPS} but is owned separately.
 */
export type EquipmentTintSlot = "hue" | "gunHue" | "bulletHue";

export const EQUIPMENT_TINT_SLOTS: readonly EquipmentTintSlot[] = [
  "hue",
  "gunHue",
  "bulletHue",
];

/** Short noun for drop / reward copy ("Warm 1 gun tint"). */
export const EQUIPMENT_TINT_NOUNS: Readonly<Record<EquipmentTintSlot, string>> =
  { hue: "body", gunHue: "gun", bulletHue: "bullet" };

export function isEquipmentTintSlot(slot: string): slot is EquipmentTintSlot {
  return slot === "hue" || slot === "gunHue" || slot === "bulletHue";
}

/** Mesh or tint slot shown as one bag item. */
export type EquipmentItemSlot = EquipmentPartSlot | EquipmentTintSlot;

/**
 * Head styles sold in the shop (0 … EQUIPMENT_SHOP_HEAD_TYPE_COUNT-1).
 * Variants at this index and above are match-card secrets — not purchasable.
 */
export const EQUIPMENT_SHOP_HEAD_TYPE_COUNT = 5;

/**
 * Visor styles sold in the shop (0 … EQUIPMENT_SHOP_VISOR_TYPE_COUNT-1).
 * Variants at this index and above are match-card secrets — not purchasable.
 */
export const EQUIPMENT_SHOP_VISOR_TYPE_COUNT = 5;

/**
 * Arm sets sold in the shop (0 … EQUIPMENT_SHOP_SHOULDER_TYPE_COUNT-1).
 * Variants at this index and above are match-card secrets — not purchasable.
 */
export const EQUIPMENT_SHOP_SHOULDER_TYPE_COUNT = 5;

/**
 * Body styles sold in the shop (0 … EQUIPMENT_SHOP_BODY_TYPE_COUNT-1).
 * Variants at this index and above are match-card secrets — not purchasable.
 */
export const EQUIPMENT_SHOP_BODY_TYPE_COUNT = 5;

/**
 * Leg styles sold in the shop (0 … EQUIPMENT_SHOP_LEG_TYPE_COUNT-1).
 * Variants at this index and above are match-card secrets — not purchasable.
 */
export const EQUIPMENT_SHOP_LEG_TYPE_COUNT = 5;

/** Number of selectable head mesh variants (0 … HEAD_TYPE_COUNT-1). */
export const HEAD_TYPE_COUNT = 24;

/** Number of selectable visor mesh variants (0 … VISOR_TYPE_COUNT-1). */
export const VISOR_TYPE_COUNT = 7;

/** Number of selectable shoulder-and-arm mesh sets (0 … SHOULDER_TYPE_COUNT-1). */
export const SHOULDER_TYPE_COUNT = 9;

/** Number of selectable body/torso mesh variants (0 … BODY_TYPE_COUNT-1). */
export const BODY_TYPE_COUNT = 17;

/** Number of selectable leg mesh variants (0 … LEG_TYPE_COUNT-1). */
export const LEG_TYPE_COUNT = 11;

/** Number of selectable pistol mesh variants (0 … PISTOL_TYPE_COUNT-1). */
export const PISTOL_TYPE_COUNT = 5;

/** Number of selectable rifle mesh variants (0 … RIFLE_TYPE_COUNT-1). */
export const RIFLE_TYPE_COUNT = 5;

/** Number of selectable shotgun mesh variants (0 … SHOTGUN_TYPE_COUNT-1). */
export const SHOTGUN_TYPE_COUNT = 5;

/** Rifle optics (0 … SCOPE_TYPE_COUNT-1). 0 is Standard, free, and the default. */
export const SCOPE_TYPE_COUNT = 5;

/** Number of selectable crosshair styles (0 … CROSSHAIR_TYPE_COUNT-1). */
export const CROSSHAIR_TYPE_COUNT = 5;

/**
 * Display names for shop mesh families shared across slots (index-aligned).
 * 0 standard · 1 octo · 2 diamond · 3 spike · 4 dome
 */
export const EQUIPMENT_PART_LABELS = [
  "Standard",
  "Octo",
  "Diamond",
  "Spike",
  "Dome",
] as const;

/**
 * Shop names for rifle optics. Same families as {@link EQUIPMENT_PART_LABELS}.
 * 0 Standard · 1 Octo · 2 Diamond · 3 Spike · 4 Dome
 */
export const SCOPE_PART_LABELS = EQUIPMENT_PART_LABELS;

/**
 * Head-only labels, including match-card secrets after the shop family.
 * 0–4 shop · 5 Medusa · 6 Taurus · 7 Ancient · 8 Pop Can · 9 Star ·
 * 10 Glitch · 11 Pirate · 12 Barrel · 13 Bucket Head · 14 Doodle ·
 * 15 Princess · 16 Hotdog · 17 Banana · 18 Football · 19 Zombie ·
 * 20 Pumpkin · 21 Cheerleader · 22 Unicorn · 23 Secretary
 */
export const HEAD_PART_LABELS = [
  "Standard",
  "Octo",
  "Diamond",
  "Spike",
  "Dome",
  "Medusa",
  "Taurus",
  "Ancient",
  "Pop Can",
  "Star",
  "Glitch",
  "Pirate",
  "Barrel",
  "Bucket Head",
  "Doodle",
  "Princess",
  "Hotdog",
  "Banana",
  "Football",
  "Zombie",
  "Pumpkin",
  "Cheerleader",
  "Unicorn",
  "Secretary",
] as const;

/** Visor-only labels: the five shop families followed by secret designs. */
export const VISOR_PART_LABELS = [
  "Standard",
  "Octo",
  "Diamond",
  "Spike",
  "Dome",
  "Doodle",
  "Princess",
] as const;

/**
 * Arm set labels: the five shop families, then match-card secrets.
 * 0–4 shop · 5 Football · 6 Princess · 7 Zombie · 8 Secretary
 */
export const SHOULDER_PART_LABELS = [
  "Standard",
  "Octo",
  "Diamond",
  "Spike",
  "Dome",
  "Football",
  "Princess",
  "Zombie",
  "Secretary",
] as const;

/**
 * Body-only labels, including match-card secrets after the shop family.
 * 0–4 shop · 5 Gym Bro · 6 Pop Can · 7 Barrel · 8 Glitch · 9 Ancient ·
 * 10 Princess · 11 Hotdog · 12 Banana · 13 Football · 14 Zombie ·
 * 15 Cheerleader · 16 Secretary
 */
export const BODY_PART_LABELS = [
  "Standard",
  "Octo",
  "Diamond",
  "Spike",
  "Dome",
  "Gym Bro",
  "Pop Can",
  "Barrel",
  "Glitch",
  "Ancient",
  "Princess",
  "Hotdog",
  "Banana",
  "Football",
  "Zombie",
  "Cheerleader",
  "Secretary",
] as const;

/** Leg-only labels: the five shop families followed by secret designs. */
export const LEG_PART_LABELS = [
  "Standard",
  "Octo",
  "Diamond",
  "Spike",
  "Dome",
  "Princess",
  "Hotdog",
  "Banana",
  "Zombie",
  "Cheerleader",
  "Secretary",
] as const;

/** Remaining slot-aligned pieces in the two secret food fits. */
export const SECRET_EQUIPMENT_SETS = {
  hotdog: { head: 16, body: 11, leg: 6 },
  banana: { head: 17, body: 12, leg: 7 },
} as const satisfies Record<
  "hotdog" | "banana",
  Readonly<Partial<Record<"head" | "visor" | "shoulder" | "body" | "leg", number>>>
>;

export type EquipmentRarity =
  | "common"
  | "uncommon"
  | "rare"
  | "epic"
  | "legendary";

/** Cosmetic border tier keyed by family display name (every slot sharing a name). */
export const EQUIPMENT_FAMILY_RARITY: Readonly<
  Record<string, EquipmentRarity>
> = {
  Standard: "common",
  Octo: "common",
  Diamond: "uncommon",
  Spike: "uncommon",
  Dome: "rare",
  Star: "rare",
  Barrel: "rare",
  Ancient: "rare",
  Medusa: "rare",
  "Pop Can": "rare",
  Taurus: "rare",
  "Gym Bro": "epic",
  Princess: "epic",
  Football: "epic",
  Zombie: "epic",
  Pumpkin: "epic",
  Cheerleader: "epic",
  Unicorn: "legendary",
  Secretary: "epic",
  Pirate: "epic",
  "Bucket Head": "epic",
  Doodle: "legendary",
  Glitch: "legendary",
  Hotdog: "legendary",
  Banana: "legendary",
};

/** Mesh-style rarity from the family label. Unknown names stay common. */
export function equipmentPartRarity(
  slot: EquipmentPartSlot,
  variant: number,
): EquipmentRarity {
  return EQUIPMENT_FAMILY_RARITY[equipmentPartLabel(slot, variant)] ??
    "common";
}

/** Buy-slot rarity. Tint tiers are keyed by hue step index. */
export function equipmentItemRarity(
  slot: EquipmentItemSlot,
  variant: number,
): EquipmentRarity {
  if (isEquipmentTintSlot(slot)) {
    return EQUIPMENT_HUE_RARITY[floor(variant)] ?? "common";
  }
  return equipmentPartRarity(slot, variant);
}

/** Display name for a mesh variant. Secret styles have slot-specific labels. */
export function equipmentPartLabel(
  slot: EquipmentPartSlot,
  variant: number,
): string {
  const v = floor(variant);
  if (slot === "head") {
    return HEAD_PART_LABELS[v] ?? `Style ${v + 1}`;
  }
  if (slot === "visor") {
    return VISOR_PART_LABELS[v] ?? `Style ${v + 1}`;
  }
  if (slot === "shoulder") {
    return SHOULDER_PART_LABELS[v] ?? `Style ${v + 1}`;
  }
  if (slot === "body") {
    return BODY_PART_LABELS[v] ?? `Style ${v + 1}`;
  }
  if (slot === "leg") {
    return LEG_PART_LABELS[v] ?? `Style ${v + 1}`;
  }
  if (slot === "scope") {
    return SCOPE_PART_LABELS[v] ?? `Style ${v + 1}`;
  }
  return EQUIPMENT_PART_LABELS[v] ?? `Style ${v + 1}`;

}

/** Display name for a bag item (mesh style or tint step). */
export function equipmentItemLabel(
  slot: EquipmentItemSlot,
  variant: number,
): string {
  const v = floor(variant);
  if (isEquipmentTintSlot(slot)) {
    return String(EQUIPMENT_HUE_LABELS[v] ?? `Tint ${v + 1}`);
  }
  return equipmentPartLabel(slot, v);
}

/** True for styles that never appear in the shop (match-card drops only). */
export function isDropOnlyPartVariant(
  slot: EquipmentPartSlot,
  variant: number,
): boolean {
  const v = floor(variant);
  if (slot === "head") {
    return v >= EQUIPMENT_SHOP_HEAD_TYPE_COUNT && v < HEAD_TYPE_COUNT;
  }
  if (slot === "visor") {
    return v >= EQUIPMENT_SHOP_VISOR_TYPE_COUNT && v < VISOR_TYPE_COUNT;
  }
  if (slot === "shoulder") {
    return v >= EQUIPMENT_SHOP_SHOULDER_TYPE_COUNT &&
      v < SHOULDER_TYPE_COUNT;
  }
  if (slot === "body") {
    return v >= EQUIPMENT_SHOP_BODY_TYPE_COUNT && v < BODY_TYPE_COUNT;
  }
  if (slot === "leg") {
    return v >= EQUIPMENT_SHOP_LEG_TYPE_COUNT && v < LEG_TYPE_COUNT;
  }
  return false;
}

/** Secret / drop-only style indices for a slot. */
export function dropOnlyPartVariants(slot: EquipmentPartSlot): number[] {
  let shop = 0;
  let total = 0;
  if (slot === "head") {
    shop = EQUIPMENT_SHOP_HEAD_TYPE_COUNT;
    total = HEAD_TYPE_COUNT;
  } else if (slot === "visor") {
    shop = EQUIPMENT_SHOP_VISOR_TYPE_COUNT;
    total = VISOR_TYPE_COUNT;
  } else if (slot === "shoulder") {
    shop = EQUIPMENT_SHOP_SHOULDER_TYPE_COUNT;
    total = SHOULDER_TYPE_COUNT;
  } else if (slot === "body") {
    shop = EQUIPMENT_SHOP_BODY_TYPE_COUNT;
    total = BODY_TYPE_COUNT;
  } else if (slot === "leg") {
    shop = EQUIPMENT_SHOP_LEG_TYPE_COUNT;
    total = LEG_TYPE_COUNT;
  } else {
    return [];
  }
  const out: number[] = [];
  for (let i = shop; i < total; i++) {
    out.push(i);
  }
  return out;
}

/**
 * Hue range (player / gun / bullet tint).
 * Shop steps stay inside ±1. Secret Cool/Warm 3–4 extend to ±2.
 * Owned tint lists store step indices, so new steps are appended and
 * indices 0–4 stay Cool 2, Cool 1, Default, Warm 1, Warm 2.
 */
export const EQUIPMENT_HUE_MIN = -2;
export const EQUIPMENT_HUE_MAX = 2;

/**
 * Discrete hue picks. Index 2 is the neutral default.
 * Stored as the step value so older saves snap via {@link snapEquipmentHue}.
 * Actual HSL shift = step × {@link EQUIPMENT_HUE_MAX_DEG}
 * (shop Cool/Warm 2 = ±28°, secret Cool/Warm 4 = ±56°).
 */
export const EQUIPMENT_HUE_STEPS = [
  -1,
  -0.5,
  0,
  0.5,
  1,
  -2,
  -1.5,
  1.5,
  2,
] as const;

export const EQUIPMENT_HUE_COUNT = EQUIPMENT_HUE_STEPS.length;

/** Labels aligned with {@link EQUIPMENT_HUE_STEPS}. */
export const EQUIPMENT_HUE_LABELS = [
  "Cool 2",
  "Cool 1",
  "Default",
  "Warm 1",
  "Warm 2",
  "Cool 4",
  "Cool 3",
  "Warm 3",
  "Warm 4",
] as const;

/**
 * Rarity aligned with {@link EQUIPMENT_HUE_STEPS}.
 * Shop Cool/Warm 1–2 are uncommon. Cool/Warm 3 are epic drops.
 * Cool/Warm 4 are legendary drops. Default stays common.
 */
export const EQUIPMENT_HUE_RARITY = [
  "uncommon",
  "uncommon",
  "common",
  "uncommon",
  "uncommon",
  "legendary",
  "epic",
  "epic",
  "legendary",
] as const satisfies readonly EquipmentRarity[];

/** Appended secret steps: Cool 4, Cool 3, Warm 3, Warm 4. */
const EQUIPMENT_HUE_DROP_ONLY_INDEX = new Set<number>([5, 6, 7, 8]);

/** True when this tint step is a match-card / mystery drop and is not sold. */
export function isDropOnlyHueStep(stepIndex: number): boolean {
  return EQUIPMENT_HUE_DROP_ONLY_INDEX.has(floor(stepIndex));
}

/** Paid shop tints and secret drops are stored. The free default is not. */
function isBagHueStep(stepIndex: number): boolean {
  const idx = floor(stepIndex);
  if (idx < 0 || idx >= EQUIPMENT_HUE_COUNT) return false;
  if (isDropOnlyHueStep(idx)) return true;
  return coinCostForHue(EQUIPMENT_HUE_STEPS[idx] ?? 0) > 0;
}

/** Secret tint step values (Cool 4, Cool 3, Warm 3, Warm 4). */
export function dropOnlyHueSteps(): number[] {
  const out: number[] = [];
  for (let i = 0; i < EQUIPMENT_HUE_COUNT; i++) {
    if (isDropOnlyHueStep(i)) out.push(EQUIPMENT_HUE_STEPS[i]!);
  }
  return out;
}

/** Coolest-to-warmest step indices for shop and admin tint strips. */
export function equipmentHueCatalogIndices(): number[] {
  return EQUIPMENT_HUE_STEPS
    .map((step, i) => ({ step, i }))
    .sort((a, b) => a.step - b.step || a.i - b.i)
    .map((row) => row.i);
}

/**
 * Degrees applied at hue step ±1 (shop Cool 2 / Warm 2).
 * Secret Cool 4 / Warm 4 use twice this (±2 × this). Center (0) stays the base.
 */
export const EQUIPMENT_HUE_MAX_DEG = 28;

/**
 * Free-pick colors: one-time coin unlocks, then any slider value is free.
 * Not bag items (can't be sold, gifted, or dropped).
 * - `crosshairColor`: hue + brightness + opacity for the hip crosshair and
 *   the rifle scope dot.
 * - `nameHue`: team-relative hue shift for your own name tag when other
 *   players aim at you (blue stays blue-ish, red stays red-ish).
 */
export type EquipmentColorUnlock = "crosshairColor" | "nameHue";

export const EQUIPMENT_COLOR_UNLOCKS: readonly EquipmentColorUnlock[] = [
  "crosshairColor",
  "nameHue",
];

export const EQUIPMENT_COLOR_UNLOCK_COSTS = {
  crosshairColor: 50,
  nameHue: 250,
} as const satisfies Record<EquipmentColorUnlock, number>;

export type EquipmentColorUnlocks = Record<EquipmentColorUnlock, boolean>;

export function emptyEquipmentColorUnlocks(): EquipmentColorUnlocks {
  return { crosshairColor: false, nameHue: false };
}

export function isEquipmentColorUnlock(
  raw: unknown,
): raw is EquipmentColorUnlock {
  return raw === "crosshairColor" || raw === "nameHue";
}

/** Packed crosshair color meaning "not customised" (stock white). */
export const EQUIPMENT_COLOR_DEFAULT = -1;

export type CrosshairColor = {
  /** Hue in degrees 0…359. */
  hue: number;
  /** HSL lightness 0…100 (100 = white, 50 = full color, 0 = black). */
  brightness: number;
  /** Opacity percent {@link CROSSHAIR_OPACITY_MIN}…100. */
  opacity: number;
};

/** Keeps a customised crosshair from vanishing entirely. */
export const CROSSHAIR_OPACITY_MIN = 10;

/** Slider start point on unlock: the stock white crosshair at 85%. */
export const CROSSHAIR_COLOR_START: CrosshairColor = {
  hue: 0,
  brightness: 100,
  opacity: 85,
};

function clampInt(raw: unknown, lo: number, hi: number): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  return max(lo, min(hi, round(raw)));
}

/** Pack into one integer: hue bits 0–8, brightness 9–15, opacity 16–22. */
export function packCrosshairColor(color: CrosshairColor): number {
  const hue = clampInt(color.hue, 0, 359) ?? 0;
  const brightness = clampInt(color.brightness, 0, 100) ?? 100;
  const opacity = clampInt(color.opacity, CROSSHAIR_OPACITY_MIN, 100) ?? 100;
  return hue | (brightness << 9) | (opacity << 16);
}

/** `null` for the default crosshair (or anything that fails to decode). */
export function unpackCrosshairColor(packed: number): CrosshairColor | null {
  if (!Number.isInteger(packed) || packed < 0) return null;
  const hue = packed & 0x1ff;
  const brightness = (packed >> 9) & 0x7f;
  const opacity = (packed >> 16) & 0x7f;
  if (hue > 359 || brightness > 100) return null;
  if (opacity < CROSSHAIR_OPACITY_MIN || opacity > 100) return null;
  return { hue, brightness, opacity };
}

/** Untrusted packed crosshair color → valid packed value or default. */
export function normalizeCrosshairColor(raw: unknown): number {
  if (typeof raw !== "number") return EQUIPMENT_COLOR_DEFAULT;
  const color = unpackCrosshairColor(raw);
  return color ? packCrosshairColor(color) : EQUIPMENT_COLOR_DEFAULT;
}

/** CSS color for a packed crosshair color, or `null` for the default. */
export function crosshairColorCss(packed: number): string | null {
  const c = unpackCrosshairColor(packed);
  if (!c) return null;
  return `hsla(${c.hue}, 100%, ${c.brightness}%, ${c.opacity / 100})`;
}

/**
 * Untrusted name tag shift → continuous hue offset in
 * {@link EQUIPMENT_HUE_MIN}…{@link EQUIPMENT_HUE_MAX} (same units as the
 * tint steps, so ±2 = ±2 × {@link EQUIPMENT_HUE_MAX_DEG}). 0 = team color.
 */
export function normalizeNameHue(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return 0;
  const clamped = max(EQUIPMENT_HUE_MIN, min(EQUIPMENT_HUE_MAX, raw));
  return round(clamped * 100) / 100;
}

/** Parse untrusted owned color-unlock JSON (array of ids) into flags. */
export function normalizeEquipmentColorUnlocks(
  raw: unknown,
): EquipmentColorUnlocks {
  const out = emptyEquipmentColorUnlocks();
  let list: unknown = raw;
  if (typeof raw === "string") {
    try {
      list = JSON.parse(raw);
    } catch {
      return out;
    }
  }
  if (Array.isArray(list)) {
    for (const id of list) if (isEquipmentColorUnlock(id)) out[id] = true;
  } else if (list != null && typeof list === "object") {
    const o = list as Record<string, unknown>;
    for (const id of EQUIPMENT_COLOR_UNLOCKS) out[id] = o[id] === true;
  }
  return out;
}

export function serializeEquipmentColorUnlocks(
  unlocks: EquipmentColorUnlocks,
): string {
  return JSON.stringify(EQUIPMENT_COLOR_UNLOCKS.filter((id) => unlocks[id]));
}

/**
 * Equipment mesh / reticle slot keys used for per-part unlock tables.
 * `shoulder` is the persisted/wire key for the full Arms set (pads + both arms).
 */
export type EquipmentPartSlot =
  | "head"
  | "visor"
  | "shoulder"
  | "body"
  | "leg"
  | "pistol"
  | "rifle"
  | "shotgun"
  | "scope"
  | "crosshair";

/**
 * XP level gates for account cosmetics (not SS).
 * Standard parts (variant 0) and default hue (0) are always free at level 1.
 *
 * Mesh styles (octo…dome) and paid player/gun tints: reaching the min level unlocks
 * the **ability to purchase** with coins. Equipping requires owning it (except
 * free defaults). See {@link EQUIPMENT_PART_COIN_COSTS} /
 * {@link EQUIPMENT_HUE_COIN_COSTS}.
 *
 * Part tables: style index 0 standard · 1 octo · 2 diamond · 3 spike · 4 dome.
 * Hue array is index-aligned with {@link EQUIPMENT_HUE_STEPS} /
 * {@link EQUIPMENT_HUE_LABELS}. Shop: Cool 2 · Cool 1 · Default · Warm 1 ·
 * Warm 2. Secret drops are appended: Cool 4 · Cool 3 · Warm 3 · Warm 4.
 */
export const EQUIPMENT_UNLOCK_LEVELS = {
  part: {
    head: {
      /** Standard */ 0: 1,
      /** Octo */ 1: 2,
      /** Diamond */ 2: 5,
      /** Spike */ 3: 8,
      /** Dome */ 4: 11,
    },
    leg: {
      0: 1,
      1: 2,
      2: 5,
      3: 8,
      4: 12,
    },
    body: {
      0: 1,
      1: 3,
      2: 6,
      3: 9,
      4: 13,
    },
    shoulder: {
      0: 1,
      1: 3,
      2: 6,
      3: 9,
      4: 14,
    },
    visor: {
      0: 1,
      1: 4,
      2: 7,
      3: 10,
      4: 15,
    },
    pistol: {
      0: 1,
      1: 2,
      2: 4,
      3: 6,
      4: 9,
    },
    rifle: {
      0: 1,
      1: 3,
      2: 5,
      3: 8,
      4: 11,
    },
    shotgun: {
      0: 1,
      1: 3,
      2: 5,
      3: 8,
      4: 11,
    },
    scope: {
      /** Standard */ 0: 1,
      /** Octo */ 1: 3,
      /** Diamond */ 2: 5,
      /** Spike */ 3: 8,
      /** Dome */ 4: 11,
    },
    crosshair: {
      0: 1,
      1: 2,
      2: 4,
      3: 7,
      4: 10,
    },
  } as const satisfies Record<
    EquipmentPartSlot,
    Readonly<Record<number, number>>
  >,
  /**
   * Min XP level per hue step (same order as EQUIPMENT_HUE_STEPS).
   * Cool 2 → 7, Cool 1 → 5, Default → 1, Warm 1 → 5, Warm 2 → 7.
   * Level unlocks the shop; paid tints still cost coins to own.
   * Secret Cool/Warm 3–4 are not sold, so they have no shop level gate.
   */
  hue: [7, 5, 1, 5, 7, 1, 1, 1, 1] as const,
} as const;

/**
 * Coin price to permanently unlock a mesh style (after the level gate).
 * Index 0 standard is free (0). Style order: standard · octo · diamond · spike · dome.
 */
export const EQUIPMENT_PART_COIN_COSTS = {
  head: {
    0: 0,
    1: 20, // octo
    2: 50, // diamond
    3: 100, // spike
    4: 300, // dome
  },
  visor: {
    0: 0,
    1: 25, // octo
    2: 60, // diamond
    3: 150, // spike
    4: 500, // dome
  },
  shoulder: {
    0: 0,
    1: 5, // octo
    2: 20, // diamond
    3: 30, // spike
    4: 90, // dome
  },
  body: {
    0: 0,
    1: 15, // octo
    2: 45, // diamond
    3: 75, // spike
    4: 225, // dome
  },
  leg: {
    0: 0,
    1: 10, // octo
    2: 30, // diamond
    3: 45, // spike
    4: 135, // dome
  },
  pistol: {
    0: 0,
    1: 10, // octo
    2: 20, // diamond
    3: 40, // spike
    4: 80, // dome
  },
  rifle: {
    0: 0,
    1: 20, // octo
    2: 40, // diamond
    3: 80, // spike
    4: 120, // dome
  },
  shotgun: {
    0: 0,
    1: 20, // octo
    2: 40, // diamond
    3: 80, // spike
    4: 120, // dome
  },
  scope: {
    0: 0, // standard
    1: 20, // octo
    2: 40, // diamond
    3: 80, // spike
    4: 120, // dome
  },
  crosshair: {
    0: 0,
    1: 10, // octo
    2: 20, // diamond
    3: 35, // spike
    4: 50, // dome
  },
} as const satisfies Record<
  EquipmentPartSlot,
  Readonly<Record<number, number>>
>;

/**
 * Coin price per hue step (after the level gate).
 * Same order as {@link EQUIPMENT_HUE_STEPS}.
 * Default is free; Cool/Warm 1 cost 10; Cool/Warm 2 cost 20.
 * Cool/Warm 3–4 cost nothing because they are not sold.
 */
export const EQUIPMENT_HUE_COIN_COSTS = [
  20,
  10,
  0,
  10,
  20,
  0,
  0,
  0,
  0,
] as const;

/** Owned paid mesh variants per slot (variant indices 1…n). Standard is never stored. */
export type EquipmentOwnedParts = {
  head: number[];
  visor: number[];
  shoulder: number[];
  body: number[];
  leg: number[];
  pistol: number[];
  rifle: number[];
  shotgun: number[];
  scope: number[];
  crosshair: number[];
};

export function emptyEquipmentOwnedParts(): EquipmentOwnedParts {
  return {
    head: [],
    visor: [],
    shoulder: [],
    body: [],
    leg: [],
    pistol: [],
    rifle: [],
    shotgun: [],
    scope: [],
    crosshair: [],
  };
}

const EQUIPMENT_PART_SLOTS: readonly EquipmentPartSlot[] = [
  "head",
  "visor",
  "shoulder",
  "body",
  "leg",
  "pistol",
  "rifle",
  "shotgun",
  "scope",
  "crosshair",
] as const;

const PART_VARIANT_COUNT: Record<EquipmentPartSlot, number> = {
  head: HEAD_TYPE_COUNT,
  visor: VISOR_TYPE_COUNT,
  shoulder: SHOULDER_TYPE_COUNT,
  body: BODY_TYPE_COUNT,
  leg: LEG_TYPE_COUNT,
  pistol: PISTOL_TYPE_COUNT,
  rifle: RIFLE_TYPE_COUNT,
  shotgun: SHOTGUN_TYPE_COUNT,
  scope: SCOPE_TYPE_COUNT,
  crosshair: CROSSHAIR_TYPE_COUNT,
};

/** Coin cost for a mesh style (0 = free / standard). */
export function coinCostForPartVariant(
  slot: EquipmentPartSlot,
  variant: number,
): number {
  const v = floor(variant);
  const table = EQUIPMENT_PART_COIN_COSTS[slot];
  const cost = table[v as keyof typeof table];
  return typeof cost === "number" && Number.isFinite(cost)
    ? max(0, trunc(cost))
    : 0;
}

/**
 * Index into {@link EQUIPMENT_HUE_STEPS} / costs / labels for a hue value.
 * Defaults to the neutral center (2) when the value does not match a step.
 */
export function equipmentHueStepIndex(hue: number): number {
  const snapped = snapEquipmentHue(hue);
  const idx = EQUIPMENT_HUE_STEPS.findIndex((s) => abs(s - snapped) < 1e-6);
  return idx < 0 ? 2 : idx;
}

/** Coin cost for a hue step (0 = free / default). Accepts hue value or step index via snap. */
export function coinCostForHue(hue: number): number {
  const idx = equipmentHueStepIndex(hue);
  const cost = EQUIPMENT_HUE_COIN_COSTS[idx];
  return typeof cost === "number" && Number.isFinite(cost)
    ? max(0, trunc(cost))
    : 0;
}

/** Empty owned-hues list (paid step indices only). */
export function emptyEquipmentOwnedHues(): number[] {
  return [];
}

function sanitizeOwnedHueList(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  const out: number[] = [];
  const seen = new Set<number>();
  for (const item of raw) {
    if (typeof item !== "number" || !Number.isFinite(item)) continue;
    // Allow either step index (0…n-1) or a hue value that snaps to a paid step.
    let idx: number;
    if (Number.isInteger(item) && item >= 0 && item < EQUIPMENT_HUE_COUNT) {
      idx = item;
    } else {
      idx = equipmentHueStepIndex(item);
    }
    // Default / free steps are never stored. Secret drops are.
    if (!isBagHueStep(idx)) continue;
    if (seen.has(idx)) continue;
    seen.add(idx);
    out.push(idx);
  }
  out.sort((a, b) => a - b);
  return out;
}

/** Parse untrusted owned-hues JSON / API body into sorted paid step indices. */
export function normalizeEquipmentOwnedHues(raw: unknown): number[] {
  if (raw == null) return emptyEquipmentOwnedHues();
  if (typeof raw === "string") {
    try {
      const parsed: unknown = JSON.parse(raw);
      return sanitizeOwnedHueList(parsed);
    } catch {
      return emptyEquipmentOwnedHues();
    }
  }
  return sanitizeOwnedHueList(raw);
}

export function serializeEquipmentOwnedHues(owned: number[]): string {
  return JSON.stringify(normalizeEquipmentOwnedHues(owned));
}

/** True when the player permanently owns this paid or secret hue (or it is free). */
export function isHueOwned(
  hue: number,
  owned: number[] | null | undefined,
): boolean {
  const idx = equipmentHueStepIndex(hue);
  if (!isBagHueStep(idx)) return true;
  if (!owned || owned.length === 0) return false;
  return owned.includes(idx);
}

/** Whether the player may equip this hue (free always; paid when owned). */
export function canEquipHue(
  hue: number,
  owned: number[] | null | undefined,
): boolean {
  return isHueOwned(hue, owned);
}

/**
 * Whether the player may buy this hue now.
 * Requires level gate, positive cost, and not already owned.
 */
export function canPurchaseHue(
  hue: number,
  level: number,
  owned: number[] | null | undefined,
): boolean {
  if (isDropOnlyHueStep(equipmentHueStepIndex(hue))) return false;
  const cost = coinCostForHue(hue);
  if (cost <= 0) return false;
  if (!isHueUnlocked(hue, level)) return false;
  if (isHueOwned(hue, owned)) return false;
  return true;
}

/** Copy owned hues and add a step (no-op if free / already owned). */
export function withOwnedHue(
  owned: number[] | null | undefined,
  hue: number,
): number[] {
  const base = normalizeEquipmentOwnedHues(owned ?? emptyEquipmentOwnedHues());
  const idx = equipmentHueStepIndex(hue);
  if (!isBagHueStep(idx)) return base;
  if (base.includes(idx)) return base;
  return [...base, idx].sort((a, b) => a - b);
}

/** Copy owned hues and drop a paid step (no-op if free / not owned). */
export function withoutOwnedHue(
  owned: number[] | null | undefined,
  hue: number,
): number[] {
  const base = normalizeEquipmentOwnedHues(owned ?? emptyEquipmentOwnedHues());
  const idx = equipmentHueStepIndex(hue);
  if (!isBagHueStep(idx)) return base;
  return base.filter((step) => step !== idx);
}

/** All paid hue step values (not free default). */
export function paidHueSteps(): number[] {
  const out: number[] = [];
  for (let i = 0; i < EQUIPMENT_HUE_COUNT; i++) {
    const step = EQUIPMENT_HUE_STEPS[i]!;
    if (coinCostForHue(step) > 0) out.push(step);
  }
  return out;
}

function sanitizeOwnedVariantList(
  slot: EquipmentPartSlot,
  raw: unknown,
): number[] {
  const count = PART_VARIANT_COUNT[slot];
  if (!Array.isArray(raw)) return [];
  const out: number[] = [];
  const seen = new Set<number>();
  for (const item of raw) {
    if (typeof item !== "number" || !Number.isFinite(item)) continue;
    const v = floor(item);
    // Standard (0) is free — never store. Paid styles only.
    if (v <= 0 || v >= count) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  out.sort((a, b) => a - b);
  return out;
}

/** Parse untrusted owned-parts JSON / API body into a safe structure. */
export function normalizeEquipmentOwnedParts(
  raw: unknown,
): EquipmentOwnedParts {
  const empty = emptyEquipmentOwnedParts();
  if (raw == null) return empty;
  let obj: Record<string, unknown>;
  if (typeof raw === "string") {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return empty;
      }
      obj = parsed as Record<string, unknown>;
    } catch {
      return empty;
    }
  } else if (typeof raw === "object" && !Array.isArray(raw)) {
    obj = raw as Record<string, unknown>;
  } else {
    return empty;
  }
  return {
    head: sanitizeOwnedVariantList("head", obj.head),
    visor: sanitizeOwnedVariantList("visor", obj.visor),
    shoulder: sanitizeOwnedVariantList(
      "shoulder",
      obj.shoulder ?? obj.shoulders,
    ),
    body: sanitizeOwnedVariantList("body", obj.body),
    leg: sanitizeOwnedVariantList("leg", obj.leg ?? obj.legs),
    pistol: sanitizeOwnedVariantList("pistol", obj.pistol),
    rifle: sanitizeOwnedVariantList("rifle", obj.rifle),
    shotgun: sanitizeOwnedVariantList("shotgun", obj.shotgun),
    scope: sanitizeOwnedVariantList("scope", obj.scope),
    crosshair: sanitizeOwnedVariantList(
      "crosshair",
      obj.crosshair ?? obj.crossHair ?? obj.reticle,
    ),
  };
}

export function serializeEquipmentOwnedParts(
  owned: EquipmentOwnedParts,
): string {
  const n = normalizeEquipmentOwnedParts(owned);
  return JSON.stringify(n);
}

/** True when this style is always owned (standard / other free shop styles). */
export function isAlwaysOwnedPartVariant(
  slot: EquipmentPartSlot,
  variant: number,
): boolean {
  const v = floor(variant);
  if (v <= 0) return true; // standard free
  if (isDropOnlyPartVariant(slot, v)) return false;
  return coinCostForPartVariant(slot, v) <= 0;
}

/** True when this tint step is the free default and is not stored in the bag. */
export function isAlwaysOwnedHueStep(stepIndex: number): boolean {
  const idx = floor(stepIndex);
  const hue = EQUIPMENT_HUE_STEPS[idx];
  if (hue === undefined) return false;
  return !isBagHueStep(idx);
}

/** Paid/secret bag items can be sold, gifted, or thrown away. Free defaults cannot. */
export function isRemovableEquipmentItem(
  slot: EquipmentItemSlot,
  variant: number,
): boolean {
  if (isEquipmentTintSlot(slot)) {
    return !isAlwaysOwnedHueStep(variant);
  }
  return !isAlwaysOwnedPartVariant(slot, variant);
}

/** True when the player permanently owns this paid/secret style (or it is free). */
export function isPartVariantOwned(
  slot: EquipmentPartSlot,
  variant: number,
  owned: EquipmentOwnedParts | null | undefined,
): boolean {
  const v = floor(variant);
  if (isAlwaysOwnedPartVariant(slot, v)) return true;
  const list = owned?.[slot];
  if (!list || list.length === 0) return false;
  return list.includes(v);
}

/**
 * Cosmetics for signed-in players.
 * Guests and team bots use defaults (all part variants 0, hues 0).
 * Grey free-for-all agents use {@link agentPlayerEquipment} (all dome).
 */
export type PlayerEquipment = {
  /**
   * Head shell: 0 standard · 1 octo · 2 diamond · 3 spike · 4 dome ·
   * 5 medusa · 6 taurus · 7 ancient · 8 pop can · 9 star ·
   * 10 glitch · 11 pirate · 12 barrel · 13 bucket head · 14 doodle ·
   * 15 princess · 16 hotdog · 17 banana · 18 football · 19 zombie ·
   * 20 pumpkin · 21 cheerleader · 22 unicorn · 23 secretary.
   */
  head: number;
  /** Visor / eyes: 0–4 shop · 5 doodle · 6 princess. */
  visor: number;
  /**
   * Arms (legacy shoulder key): 0–4 shop families · 5 football · 6 princess ·
   * 7 zombie · 8 secretary.
   */
  shoulder: number;
  /**
   * Body/torso: 0 standard · 1 octo · 2 diamond · 3 spike · 4 dome ·
   * 5 gym bro · 6 pop can · 7 barrel · 8 glitch · 9 ancient · 10 princess ·
   * 11 hotdog · 12 banana · 13 football · 14 zombie · 15 cheerleader ·
   * 16 secretary.
   */
  body: number;
  /**
   * Legs: 0–4 shop families · 5 princess · 6 hotdog · 7 banana · 8 zombie ·
   * 9 cheerleader · 10 secretary.
   */
  leg: number;
  /**
   * Player (body) neon hue step in -2…2 (see {@link EQUIPMENT_HUE_STEPS}).
   * Owned separately from {@link gunHue}.
   */
  hue: number;
  /**
   * Gun neon hue step in -2…2 (same steps/costs as player tint).
   * Owned separately from {@link hue}.
   */
  gunHue: number;
  /**
   * Bullet tracer neon hue step in -2…2 (same steps/costs as player tint).
   * Owned separately from {@link hue} and {@link gunHue}.
   */
  bulletHue: number;
  /**
   * Packed hip crosshair + scope dot color ({@link packCrosshairColor}), or
   * {@link EQUIPMENT_COLOR_DEFAULT}. Needs the `crosshairColor` unlock.
   */
  crosshairColor: number;
  /**
   * Own name tag hue shift (-2…2, continuous) off the team color, as other
   * players see it. 0 = team color. Needs the `nameHue` unlock.
   */
  nameHue: number;
  /** Pistol mesh style: 0 standard … 4 dome. */
  pistol: number;
  /** Rifle mesh style: 0 standard … 4 dome. */
  rifle: number;
  /** Shotgun mesh style: 0 standard … 4 dome. */
  shotgun: number;
  /**
   * Rifle optic: 0 Standard · 1 Octo · 2 Diamond · 3 Spike · 4 Dome.
   * Independent of {@link rifle}.
   */
  scope: number;
  /**
   * First-person crosshair style:
   * 0 standard circle · 1 octo · 2 diamond · 3 spike · 4 dome (circle + center dot).
   */
  crosshair: number;
};

/** Style index for the dome mesh family (head / body / guns / …). */
export const EQUIPMENT_STYLE_DOME = 4;

export function defaultPlayerEquipment(): PlayerEquipment {
  return {
    head: 0,
    visor: 0,
    shoulder: 0,
    body: 0,
    leg: 0,
    hue: 0,
    gunHue: 0,
    bulletHue: 0,
    crosshairColor: EQUIPMENT_COLOR_DEFAULT,
    nameHue: 0,
    pistol: 0,
    rifle: 0,
    shotgun: 0,
    scope: 0,
    crosshair: 0,
  };
}

/**
 * Fixed look for grey free-for-all agents: mesh slots are dome and the
 * rifle optic stays Standard. Hues stay neutral so the client agent grey
 * body color is unchanged.
 */
export function agentPlayerEquipment(): PlayerEquipment {
  const d = EQUIPMENT_STYLE_DOME;
  return {
    head: d,
    visor: d,
    shoulder: d,
    body: d,
    leg: d,
    hue: 0,
    gunHue: 0,
    bulletHue: 0,
    crosshairColor: EQUIPMENT_COLOR_DEFAULT,
    nameHue: 0,
    pistol: d,
    rifle: d,
    shotgun: d,
    scope: 0,
    crosshair: d,
  };
}

function clampVariant(raw: unknown, count: number, fallback: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return fallback;
  return max(0, min(count - 1, floor(raw)));
}

/** Snap a continuous hue to the nearest discrete equipment step. */
export function snapEquipmentHue(raw: number): number {
  if (!Number.isFinite(raw)) return 0;
  const clamped = max(
    EQUIPMENT_HUE_MIN,
    min(EQUIPMENT_HUE_MAX, raw),
  );
  let best: number = EQUIPMENT_HUE_STEPS[2]; // default
  let bestDist = Infinity;
  for (const step of EQUIPMENT_HUE_STEPS) {
    const d = abs(clamped - step);
    if (d < bestDist) {
      bestDist = d;
      best = step;
    }
  }
  return best;
}

/**
 * Clamp / coerce untrusted equipment input (API body, join token, snapshot).
 * Always returns a valid PlayerEquipment.
 */
export function normalizePlayerEquipment(raw: unknown): PlayerEquipment {
  const defaults = defaultPlayerEquipment();
  if (raw == null || typeof raw !== "object") return defaults;
  const o = raw as Record<string, unknown>;

  const head = clampVariant(
    o.head ?? o.headType ?? o.head_type,
    HEAD_TYPE_COUNT,
    defaults.head,
  );
  const visor = clampVariant(
    o.visor ?? o.visorType ?? o.visor_type,
    VISOR_TYPE_COUNT,
    defaults.visor,
  );
  const shoulder = clampVariant(
    o.shoulder ?? o.shoulderType ?? o.shoulder_type,
    SHOULDER_TYPE_COUNT,
    defaults.shoulder,
  );
  const body = clampVariant(
    o.body ?? o.bodyType ?? o.body_type ?? o.torso ?? o.torsoType,
    BODY_TYPE_COUNT,
    defaults.body,
  );
  const leg = clampVariant(
    o.leg ?? o.legType ?? o.leg_type ?? o.legs ?? o.legsType,
    LEG_TYPE_COUNT,
    defaults.leg,
  );

  let hue = defaults.hue;
  const hueRaw = o.hue ?? o.colorHue ?? o.color_hue;
  if (typeof hueRaw === "number" && Number.isFinite(hueRaw)) {
    hue = snapEquipmentHue(hueRaw);
  }

  let gunHue = defaults.gunHue;
  const gunHueRaw = o.gunHue ?? o.gun_hue ?? o.gunColorHue ?? o.gun_color_hue;
  if (typeof gunHueRaw === "number" && Number.isFinite(gunHueRaw)) {
    gunHue = snapEquipmentHue(gunHueRaw);
  }

  let bulletHue = defaults.bulletHue;
  const bulletHueRaw = o.bulletHue ?? o.bullet_hue;
  if (typeof bulletHueRaw === "number" && Number.isFinite(bulletHueRaw)) {
    bulletHue = snapEquipmentHue(bulletHueRaw);
  }

  const crosshairColor = normalizeCrosshairColor(
    o.crosshairColor ?? o.crosshair_color,
  );
  const nameHue = normalizeNameHue(o.nameHue ?? o.name_hue);

  const pistol = clampVariant(
    o.pistol ?? o.pistolType ?? o.pistol_type,
    PISTOL_TYPE_COUNT,
    defaults.pistol,
  );
  const rifle = clampVariant(
    o.rifle ?? o.rifleType ?? o.rifle_type,
    RIFLE_TYPE_COUNT,
    defaults.rifle,
  );
  const shotgun = clampVariant(
    o.shotgun ?? o.shotgunType ?? o.shotgun_type,
    SHOTGUN_TYPE_COUNT,
    defaults.shotgun,
  );
  const scope = clampVariant(
    o.scope ?? o.scopeType ?? o.scope_type,
    SCOPE_TYPE_COUNT,
    defaults.scope,
  );
  const crosshair = clampVariant(
    o.crosshair ??
      o.crossHair ??
      o.crosshairType ??
      o.crosshair_type ??
      o.reticle,
    CROSSHAIR_TYPE_COUNT,
    defaults.crosshair,
  );

  return {
    head,
    visor,
    shoulder,
    body,
    leg,
    hue,
    gunHue,
    bulletHue,
    crosshairColor,
    nameHue,
    pistol,
    rifle,
    shotgun,
    scope,
    crosshair,
  };
}

/** Min XP level required for a mesh style on a given body slot. */
export function minLevelForPartVariant(
  slot: EquipmentPartSlot,
  variant: number,
): number {
  const v = floor(variant);
  const table = EQUIPMENT_UNLOCK_LEVELS.part[slot];
  return table[v as keyof typeof table] ?? 1;
}

/**
 * Level gate for a mesh style.
 * For paid styles this unlocks the **shop** (right to buy), not equip by itself.
 * Standard / free styles are always unlocked at level 1.
 */
export function isPartVariantUnlocked(
  slot: EquipmentPartSlot,
  variant: number,
  level: number,
): boolean {
  const safeLevel =
    typeof level === "number" && Number.isFinite(level) ? floor(level) : 1;
  return safeLevel >= minLevelForPartVariant(slot, variant);
}

/** @deprecated Alias — level unlocks purchase for paid mesh styles. */
export function isPartVariantLevelUnlocked(
  slot: EquipmentPartSlot,
  variant: number,
  level: number,
): boolean {
  return isPartVariantUnlocked(slot, variant, level);
}

/**
 * Whether the player may equip this mesh style.
 * Free styles: always. Paid: must own (purchase requires level first).
 */
export function canEquipPartVariant(
  slot: EquipmentPartSlot,
  variant: number,
  owned: EquipmentOwnedParts | null | undefined,
): boolean {
  return isPartVariantOwned(slot, variant, owned);
}

/**
 * Whether the player may buy this style now.
 * Requires level gate, positive cost, and not already owned.
 */
export function canPurchasePartVariant(
  slot: EquipmentPartSlot,
  variant: number,
  level: number,
  owned: EquipmentOwnedParts | null | undefined,
): boolean {
  const v = floor(variant);
  const cost = coinCostForPartVariant(slot, v);
  if (cost <= 0) return false;
  if (!isPartVariantUnlocked(slot, v, level)) return false;
  if (isPartVariantOwned(slot, v, owned)) return false;
  return true;
}

/** Copy owned parts and add a variant (no-op if free / already owned). */
export function withOwnedPartVariant(
  owned: EquipmentOwnedParts | null | undefined,
  slot: EquipmentPartSlot,
  variant: number,
): EquipmentOwnedParts {
  const base = normalizeEquipmentOwnedParts(
    owned ?? emptyEquipmentOwnedParts(),
  );
  const v = floor(variant);
  if (v <= 0 || isAlwaysOwnedPartVariant(slot, v)) return base;
  if (base[slot].includes(v)) return base;
  return {
    ...base,
    [slot]: [...base[slot], v].sort((a, b) => a - b),
  };
}

/** Copy owned parts and drop a variant (no-op if free / not owned). */
export function withoutOwnedPartVariant(
  owned: EquipmentOwnedParts | null | undefined,
  slot: EquipmentPartSlot,
  variant: number,
): EquipmentOwnedParts {
  const base = normalizeEquipmentOwnedParts(
    owned ?? emptyEquipmentOwnedParts(),
  );
  const v = floor(variant);
  if (v <= 0 || isAlwaysOwnedPartVariant(slot, v)) return base;
  return {
    ...base,
    [slot]: base[slot].filter((ownedVariant) => ownedVariant !== v),
  };
}

/** All paid style indices for a slot (1 … count-1). */
export function paidPartVariants(slot: EquipmentPartSlot): number[] {
  const count = PART_VARIANT_COUNT[slot];
  const out: number[] = [];
  for (let i = 1; i < count; i++) {
    if (coinCostForPartVariant(slot, i) > 0) out.push(i);
  }
  return out;
}

export function equipmentPartSlots(): readonly EquipmentPartSlot[] {
  return EQUIPMENT_PART_SLOTS;
}

/** Min XP level for a discrete hue step (-2…2 after snap). */
export function minLevelForHue(hue: number): number {
  const idx = equipmentHueStepIndex(hue);
  return EQUIPMENT_UNLOCK_LEVELS.hue[idx] ?? 1;
}

/**
 * Level gate for a hue step.
 * For paid tints this unlocks the **shop** (right to buy), not equip by itself.
 * Default / free hue is always unlocked at level 1.
 */
export function isHueUnlocked(hue: number, level: number): boolean {
  const safeLevel =
    typeof level === "number" && Number.isFinite(level) ? floor(level) : 1;
  return safeLevel >= minLevelForHue(hue);
}

/** @deprecated Alias — level unlocks purchase for paid player/gun tints. */
export function isHueLevelUnlocked(hue: number, level: number): boolean {
  return isHueUnlocked(hue, level);
}

/**
 * Strip cosmetics the player cannot use.
 * Mesh styles and paid player/gun tints: free always, paid only when owned.
 * Level gates shop access only (purchase helpers enforce level).
 *
 * @param owned Owned paid mesh variants. When omitted, paid styles clamp to 0
 *   (safe for callers that only pass level).
 * @param ownedHues Owned paid **player** tint step indices. When omitted, clamp to 0.
 * @param ownedGunHues Owned paid **gun** tint step indices. When omitted, clamp to 0.
 * @param ownedBulletHues Owned paid **bullet** tint step indices. When omitted, clamp to 0.
 * @param colorUnlocks Crosshair color / name hue unlocks. When omitted, both reset.
 */
export function clampEquipmentToXpLevel(
  equipment: PlayerEquipment,
  level: number,
  owned?: EquipmentOwnedParts | null,
  ownedHues?: number[] | null,
  ownedGunHues?: number[] | null,
  ownedBulletHues?: number[] | null,
  colorUnlocks?: EquipmentColorUnlocks | null,
): PlayerEquipment {
  const base = normalizePlayerEquipment(equipment);
  const ownedParts = owned ?? emptyEquipmentOwnedParts();
  const hues = ownedHues ?? emptyEquipmentOwnedHues();
  const gunHues = ownedGunHues ?? emptyEquipmentOwnedHues();
  const bulletHues = ownedBulletHues ?? emptyEquipmentOwnedHues();
  const unlocks = colorUnlocks ?? emptyEquipmentColorUnlocks();
  // `level` retained for API stability; equip uses ownership only.
  void level;
  return {
    head: canEquipPartVariant("head", base.head, ownedParts) ? base.head : 0,
    visor: canEquipPartVariant("visor", base.visor, ownedParts)
      ? base.visor
      : 0,
    shoulder: canEquipPartVariant("shoulder", base.shoulder, ownedParts)
      ? base.shoulder
      : 0,
    body: canEquipPartVariant("body", base.body, ownedParts) ? base.body : 0,
    leg: canEquipPartVariant("leg", base.leg, ownedParts) ? base.leg : 0,
    hue: canEquipHue(base.hue, hues) ? base.hue : 0,
    gunHue: canEquipHue(base.gunHue, gunHues) ? base.gunHue : 0,
    bulletHue: canEquipHue(base.bulletHue, bulletHues) ? base.bulletHue : 0,
    crosshairColor: unlocks.crosshairColor
      ? base.crosshairColor
      : EQUIPMENT_COLOR_DEFAULT,
    nameHue: unlocks.nameHue ? base.nameHue : 0,
    pistol: canEquipPartVariant("pistol", base.pistol, ownedParts)
      ? base.pistol
      : 0,
    rifle: canEquipPartVariant("rifle", base.rifle, ownedParts)
      ? base.rifle
      : 0,
    shotgun: canEquipPartVariant("shotgun", base.shotgun, ownedParts)
      ? base.shotgun
      : 0,
    scope: canEquipPartVariant("scope", base.scope, ownedParts)
      ? base.scope
      : 0,
    crosshair: canEquipPartVariant("crosshair", base.crosshair, ownedParts)
      ? base.crosshair
      : 0,
  };
}

/** Highest XP level required by any equipment unlock. */
export function maxEquipmentUnlockLevel(): number {
  let highest = 1;
  for (const table of Object.values(EQUIPMENT_UNLOCK_LEVELS.part)) {
    for (const v of Object.values(table)) {
      if (typeof v === "number" && Number.isFinite(v)) {
        highest = max(highest, v);
      }
    }
  }
  for (const v of EQUIPMENT_UNLOCK_LEVELS.hue) {
    highest = max(highest, v);
  }
  return highest;
}

/**
 * Variants of a mesh slot whose min XP level is ≤ `level` (shop unlock gate).
 * Always includes free standard (0).
 */
export function levelLegalPartVariants(
  slot: EquipmentPartSlot,
  level: number,
): number[] {
  const safeLevel =
    typeof level === "number" && Number.isFinite(level) ? floor(level) : 1;
  const count = PART_VARIANT_COUNT[slot] ?? 5;
  const out: number[] = [];
  for (let v = 0; v < count; v++) {
    if (isDropOnlyPartVariant(slot, v)) continue;
    if (isPartVariantUnlocked(slot, v, safeLevel)) out.push(v);
  }
  return out.length > 0 ? out : [0];
}

/** Hue step values unlocked at `level` (shop gate). Always includes default 0. */
export function levelLegalHueSteps(level: number): number[] {
  const safeLevel =
    typeof level === "number" && Number.isFinite(level) ? floor(level) : 1;
  const out: number[] = [];
  for (const step of EQUIPMENT_HUE_STEPS) {
    if (isDropOnlyHueStep(equipmentHueStepIndex(step))) continue;
    if (isHueUnlocked(step, safeLevel)) out.push(step);
  }
  return out.length > 0 ? out : [0];
}

function pickFrom<T>(items: readonly T[], rand: () => number): T {
  if (items.length === 0) {
    throw new Error("pickFrom: empty list");
  }
  const r = rand();
  const t = Number.isFinite(r) ? min(0.999999, max(0, r)) : 0;
  return items[floor(t * items.length)]!;
}

/**
 * Random full equipment using only cosmetics unlocked at `level`.
 * Used when authoring seed catalog fits (not re-rolled per match).
 * `rand` is injectable for tests (default {@link Math.random}).
 */
export function pickLevelLegalEquipment(
  level: number,
  rand: () => number = Math.random,
): PlayerEquipment {
  const slots: EquipmentPartSlot[] = [
    "head",
    "visor",
    "shoulder",
    "body",
    "leg",
    "pistol",
    "rifle",
    "shotgun",
    "crosshair",
    "scope",
  ];
  const parts: Partial<PlayerEquipment> = {};
  for (const slot of slots) {
    const legal = levelLegalPartVariants(slot, level);
    parts[slot] = pickFrom(legal, rand);
  }
  const hues = levelLegalHueSteps(level);
  const hue = pickFrom(hues, rand);
  const gunHue = pickFrom(hues, rand);
  return normalizePlayerEquipment({
    ...defaultPlayerEquipment(),
    ...parts,
    hue,
    gunHue,
  });
}

/**
 * Owned mesh ledger for a seed account: every paid style that is level-legal
 * (and thus equippable for the fake player if they wore it).
 */
export function ownedPartsForLevel(level: number): EquipmentOwnedParts {
  const owned = emptyEquipmentOwnedParts();
  for (const slot of EQUIPMENT_PART_SLOTS) {
    const legal = levelLegalPartVariants(slot, level);
    const paid = legal.filter((v) => coinCostForPartVariant(slot, v) > 0);
    owned[slot] = paid;
  }
  return owned;
}

/**
 * Paid hue step indices unlocked at `level` (for owned_hues / owned gun hues).
 */
export function ownedHueIndicesForLevel(level: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < EQUIPMENT_HUE_COUNT; i++) {
    const step = EQUIPMENT_HUE_STEPS[i]!;
    if (coinCostForHue(step) <= 0) continue;
    if (isHueUnlocked(step, level)) out.push(i);
  }
  return out;
}

/** Socket.IO handshake reject codes (connect_error.message). */
export const JoinErrors = {
  NameRequired: "NAME_REQUIRED",
  NameInvalid: "NAME_INVALID",
  /** Name format is ok but content policy rejected it (profanity / mean words). */
  NameNotAllowed: "NAME_NOT_ALLOWED",
  NameTaken: "NAME_TAKEN",
  ServerFull: "SERVER_FULL",
  /** Ranked server requires a valid authority join token. */
  AuthRequired: "AUTH_REQUIRED",
  /** Join token missing, expired, or invalid for this server. */
  AuthInvalid: "AUTH_INVALID",
  /**
   * Official open requires an assignment-bearing admission (placement token)
   * when OPEN_ASSIGNMENT_REQUIRED is enabled on the runtime.
   */
  AssignmentRequired: "ASSIGNMENT_REQUIRED",
  /** Assignment claims are missing, for another runtime, or cancelled. */
  AssignmentInvalid: "ASSIGNMENT_INVALID",
  /** Admission jti was already consumed by a different subject (replay). */
  AdmissionReplay: "ADMISSION_REPLAY",
  /** Admin spectate requires a valid admin spectate token on official servers. */
  SpectateDenied: "SPECTATE_DENIED",
  /**
   * Runtime is draining for scale-in: new admissions refused; reconnect reclaim
   * of an existing session is still allowed (S7-PR4).
   */
  ServerDraining: "SERVER_DRAINING",
  /** Client/server gameplay binary protocol version mismatch. */
  ProtocolMismatch: "PROTOCOL_MISMATCH",
  /** Community server requires a join password and none was sent. */
  PasswordRequired: "PASSWORD_REQUIRED",
  /** Community server join password was missing or did not match. */
  PasswordInvalid: "PASSWORD_INVALID",
} as const;
