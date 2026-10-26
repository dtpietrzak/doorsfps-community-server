/**
 * Shared weapon definitions — single source of truth for client + server.
 *
 * Durations are wall-clock milliseconds. The server converts to sim ticks
 * via msToTicks(); the client uses ms directly for prediction / HUD.
 *
 * Client-only presentation (recoil jiggle, viewmodel, audio) lives outside
 * this file and layers onto these stats.
 */

export const WEAPON_PISTOL = 0;
export const WEAPON_RIFLE = 1;
/** Close-range pump shotgun (notes/shotgun.md): third in {@link WEAPON_ORDER}. */
export const WEAPON_SHOTGUN = 2;

/**
 * Linear damage falloff by hit distance. Full damage up to `fullDamageRange`,
 * then down to `minMult` at `minDamageRange`, flat after that. `minMult` is
 * never 0: a visible hit always does damage (no hard range cutoff).
 */
export type WeaponFalloff = {
  /** Full damage up to this distance (world units). */
  fullDamageRange: number;
  /** Multiplier reaches minMult here and stays there out to maxRange. */
  minDamageRange: number;
  /** Floor multiplier (0–1, exclusive of 0). */
  minMult: number;
};

/** Per-weapon melee (E / right mouse). Weapons without it use those inputs to zoom. */
export type WeaponMelee = {
  /** Base damage, resolved through rollDamageVariation (±5). */
  baseDamage: number;
  /** Max eye-to-target distance a swing can connect (world units). */
  range: number;
  /** Min time between swings (ms). */
  cooldownMs: number;
  /** Full first-/third-person swing duration (ms): raise → hit → recover. */
  swingMs: number;
  /** Fraction of the swing when it connects (damage + thwack timing). */
  hitMomentT: number;
};

/** Reload style. Omitted = `mag` (whole magazine on `reloadMs`). */
export type WeaponReload =
  | { kind: "mag" }
  | {
    kind: "shell";
    /** Open the gun before the first shell (ms). */
    startMs: number;
    /** One shell spare → tube (ms). */
    perShellMs: number;
    /** Cock after a shot / an interrupted or finished reload (ms). */
    pumpMs: number;
    /** Spare shells at spawn. */
    spareShells: number;
  };

/** Combat + inventory stats shared by client prediction and server authority. */
export type WeaponDef = {
  id: number;
  name: string;
  bodyDamage: number;
  headDamage: number;
  /** Min time between shots (ms). */
  fireCooldownMs: number;
  maxRange: number;
  /** Rounds in a full magazine. */
  magSize: number;
  /** Total magazines for the match (loaded + spares). No resupply. */
  totalClips: number;
  /** Full mag-swap duration (ms). */
  reloadMs: number;
  /** Multiplier on walk / sprint / crouch while this weapon is equipped. */
  moveSpeedMult: number;
  /** Damage falloff by distance. Omitted = full damage out to maxRange. */
  falloff?: WeaponFalloff;
  /** Pellets per shot (default 1). */
  pellets?: number;
  /** Pellet cone half-angle (degrees), stacked on movement bloom. */
  pelletSpreadDeg?: number;
  /** Reload style (default mag). */
  reload?: WeaponReload;
  /** Melee swing. Omitted = no melee (E / right mouse zooms instead). */
  melee?: WeaponMelee;
};

/**
 * Wall-clock time to holster one weapon and draw another (ms).
 * Split evenly: first half lower current gun, second half raise the next.
 * Server blocks shoot / reload / re-switch until this elapses.
 */
export const WEAPON_SWITCH_MS = 550;

export const PISTOL: WeaponDef = {
  id: WEAPON_PISTOL,
  name: "Pistol",
  bodyDamage: 30,
  headDamage: 55,
  fireCooldownMs: 75,
  maxRange: 500,
  magSize: 7,
  totalClips: 3,
  reloadMs: 1200,
  moveSpeedMult: 1,
  // Body 30 → 13.5, head 55 → ~25 at 50+ units.
  falloff: { fullDamageRange: 25, minDamageRange: 50, minMult: 0.45 },
  // Pistol-whip.
  melee: {
    baseDamage: 50,
    range: 2.8,
    cooldownMs: 700,
    swingMs: 450,
    hitMomentT: 0.45,
  },
};

/** High damage, small mag, slow fire/reload, slight mobility hit. */
export const RIFLE: WeaponDef = {
  id: WEAPON_RIFLE,
  name: "Rifle",
  bodyDamage: 85,
  // Fixed ±5 roll produces 100–110 damage.
  headDamage: 105,
  fireCooldownMs: 750,
  maxRange: 1000,
  magSize: 3,
  totalClips: 3,
  reloadMs: 2400,
  moveSpeedMult: 0.80,
};

/** Close-range pump gun: 8 pellets per shot, gentler falloff than the pistol. */
export const SHOTGUN: WeaponDef = {
  id: WEAPON_SHOTGUN,
  name: "Shotgun",
  // Per pellet. All 8 on body at point blank = 96.
  bodyDamage: 12,
  headDamage: 18,
  // Includes the pump.
  fireCooldownMs: 850,
  maxRange: 500,
  // Shells in the tube.
  magSize: 5,
  // Unused: shell guns reload per shell (`reload`), and spare ammo counts
  // shells. Kept at a tube-equivalent (5 + 10 spare = 3 tubes, 300 + 5 × 450 +
  // 400 ms for a full tube) for generic mag-path readers.
  totalClips: 3,
  reloadMs: 2950,
  moveSpeedMult: 0.92,
  pellets: 8,
  pelletSpreadDeg: 4.5,
  // Per pellet: body 12 → 3, head 18 → 4.5 at 50+ units.
  falloff: { fullDamageRange: 8, minDamageRange: 50, minMult: 0.25 },
  // Stock bash.
  melee: {
    baseDamage: 55,
    range: 2.6,
    cooldownMs: 800,
    swingMs: 500,
    hitMomentT: 0.5,
  },
  reload: {
    kind: "shell",
    startMs: 300,
    perShellMs: 450,
    pumpMs: 400,
    spareShells: 10,
  },
};

export const WEAPONS: Record<number, WeaponDef> = {
  [WEAPON_PISTOL]: PISTOL,
  [WEAPON_RIFLE]: RIFLE,
  [WEAPON_SHOTGUN]: SHOTGUN,
};

/** Hawkeyes: pellet cone multiplier (paired with the uniform ring pattern). */
export const HAWKEYES_PELLET_CONE_SCALE = 0.5;

/** Everyone carries all three guns: pistol → rifle → shotgun. */
export const WEAPON_ORDER = [WEAPON_PISTOL, WEAPON_RIFLE, WEAPON_SHOTGUN] as const;

// ── Pistol melee (pistol-whip) ──
// Aliases of PISTOL.melee for pistol-only presentation (viewmodel / pose
// timing). Gameplay reads the equipped weapon's `melee` instead.

/** Base melee damage — resolved through rollDamageVariation (±5 → 45–55). */
export const MELEE_BASE_DAMAGE = PISTOL.melee!.baseDamage;
/** Max eye-to-target distance a melee swing can connect (world units). */
export const MELEE_RANGE = PISTOL.melee!.range;
/** Min time between melee swings (ms). */
export const MELEE_COOLDOWN_MS = PISTOL.melee!.cooldownMs;
/** Full first-/third-person swing duration (ms): raise → bop → recover. */
export const MELEE_SWING_MS = PISTOL.melee!.swingMs;
/** Fraction of the swing when the grip connects (damage + thwack timing). */
export const MELEE_HIT_MOMENT_T = PISTOL.melee!.hitMomentT;

export function getWeapon(id: number): WeaponDef {
  return WEAPONS[id] ?? PISTOL;
}

export function isWeaponId(id: unknown): id is number {
  return typeof id === "number" && Number.isInteger(id) &&
    (id === WEAPON_PISTOL || id === WEAPON_RIFLE || id === WEAPON_SHOTGUN);
}

/**
 * Damage multiplier for a hit at `distance` (world units). Pure and clamped:
 * 1 without falloff or inside `fullDamageRange`, linear down to `minMult` at
 * `minDamageRange`, and `minMult` beyond. Never 0 for a weapon with falloff.
 */
export function damageFalloffMult(weapon: WeaponDef, distance: number): number {
  const f = weapon.falloff;
  if (!f) return 1;
  const floorMult = Math.max(0, Math.min(1, f.minMult));
  if (Number.isNaN(distance) || distance <= f.fullDamageRange) return 1;
  if (distance >= f.minDamageRange) return floorMult;
  const span = f.minDamageRange - f.fullDamageRange;
  if (span <= 0) return floorMult;
  const t = (distance - f.fullDamageRange) / span;
  return 1 + (floorMult - 1) * t;
}

/** Base (pre-roll) damage for a shot hit: zone damage × distance falloff. */
export function shotBaseDamage(
  weapon: WeaponDef,
  head: boolean,
  distance: number,
): number {
  const base = head ? weapon.headDamage : weapon.bodyDamage;
  return base * damageFalloffMult(weapon, distance);
}

/**
 * A real hit (non-invulnerable victim) always deals at least 1 damage after
 * falloff, the ±5 roll and any scaling, so far hits never read as misses.
 */
export function clampHitDamage(damage: number): number {
  return Number.isFinite(damage) ? Math.max(1, damage) : 1;
}

/** Rapid Fire bonus on a shell gun: loose spare shells (mag guns get 1 magazine). */
export const RAPID_FIRE_BONUS_SHELLS = 5;

/** Shell-reload config, or null for mag guns. */
export function shellReloadOf(
  weapon: WeaponDef,
): Extract<WeaponReload, { kind: "shell" }> | null {
  return weapon.reload?.kind === "shell" ? weapon.reload : null;
}

/**
 * Spare ammo at spawn: magazines for mag guns (total clips minus the one in
 * the gun), loose shells for shell guns.
 */
export function spareClipsForWeapon(id: number): number {
  const w = getWeapon(id);
  const shell = shellReloadOf(w);
  if (shell) return Math.max(0, shell.spareShells);
  return Math.max(0, w.totalClips - 1);
}

// ── Movement aim bloom (hitscan cone half-angle, degrees) ──
// Stance selection is shared; tables differ per weapon.
// Rifle: tight still, heavy sprint/air punish.
// Pistol: looser still/walk, flatter mobility curve.

export type AimSpreadStance = "still" | "walk" | "sprint" | "air";

/**
 * Hitscan aim-cone half-angle per movement stance (degrees).
 * Unknown weapon ids fall back to pistol (matches {@link getWeapon}).
 */
export const WEAPON_AIM_SPREAD_DEG: Record<
  number,
  Record<AimSpreadStance, number>
> = {
  [WEAPON_RIFLE]: { still: 0, walk: 1.15, sprint: 2.0, air: 3.2 },
  // Looser hipfire; less extra bloom on sprint / jump / slide.
  [WEAPON_PISTOL]: { still: 1.0, walk: 1.4, sprint: 1.7, air: 2.1 },
  // Bloom moves the whole pellet pattern; the pellet cone stacks on top.
  [WEAPON_SHOTGUN]: { still: 1.2, walk: 1.6, sprint: 2.2, air: 2.8 },
};

/** Degrees that map to +1× on the crosshair ring (rifle walk = 2×). */
export const AIM_SPREAD_CROSSHAIR_REF_DEG = 1.15;

export function aimSpreadDegForWeapon(
  weaponId: number,
  stance: AimSpreadStance,
): number {
  const table =
    WEAPON_AIM_SPREAD_DEG[weaponId] ?? WEAPON_AIM_SPREAD_DEG[WEAPON_PISTOL]!;
  return table[stance];
}

/**
 * Crosshair diameter scale vs the weapon’s base ring.
 * Grows only above that weapon’s still cone so pistol still stays 1× of its
 * larger base ring, while rifle still keeps legacy walk=2× when still=0.
 */
export function crosshairSpreadMultFromDeg(
  weaponId: number,
  deg: number,
): number {
  const stillDeg = aimSpreadDegForWeapon(weaponId, "still");
  const cone = getWeapon(weaponId).pelletSpreadDeg ?? 0;
  if (cone > 0) {
    // Pellet guns: the ring shows cone + bloom, so the multiplier grows from
    // the still total instead of from still alone. The +1° stands in for the
    // base ring (client: CROSSHAIR_BASE_PX / CROSSHAIR_PX_PER_DEG).
    const stillTotal = cone + stillDeg + 1;
    return (cone + Math.max(stillDeg, deg) + 1) / stillTotal;
  }
  return 1 + Math.max(0, deg - stillDeg) / AIM_SPREAD_CROSSHAIR_REF_DEG;
}
