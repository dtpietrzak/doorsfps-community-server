/**
 * Official mode unlock gates by XP prestige level.
 *
 * Easy and Medium are free-to-play (level 1+).
 * Hard / Ranked unlock as players climb. Level is derived from lifetime
 * XP (shared/progression/xpLevels.ts).
 *
 * Production `runtimeId` / `serverId` are opaque host+slot strings after the
 * identity cutover (e.g. `g00/0`). Mode is occupancy metadata (`modeId`), not
 * a path segment inside the id. Prefer {@link resolveOfficialMode} with an
 * explicit `modeId`. See docs/game/fleet.md.
 */

export type OfficialModeId = "easy" | "medium" | "hard" | "ranked";

/**
 * Minimum XP level required to drop into each official mode.
 * Easy + Medium are always unlocked at level 1 (every account).
 */
export const MODE_UNLOCK_LEVELS: Readonly<Record<OfficialModeId, number>> = {
  easy: 1,
  medium: 1,
  hard: 4,
  ranked: 6,
} as const;

/** Inputs for mode resolution when identity and occupancy are separate. */
export type ResolveOfficialModeOpts = {
  /** Mutable occupancy mode (preferred). */
  modeId?: string | null;
  /**
   * Runtime / token server id. Production host+slot ids (`g00/4`) do not encode
   * mode. Legacy mode-bearing ids (`g00/easy/0`) still resolve for historical
   * fixtures and pre-cutover data only.
   */
  serverId?: string | null;
};

export function isOfficialModeId(
  id: string | null | undefined,
): id is OfficialModeId {
  return id === "easy" || id === "medium" || id === "hard" || id === "ranked";
}

/**
 * Resolve official mode id from authentic server id or difficulty label.
 * Unknown ids return null (no level gate — community / custom).
 *
 * Prefer {@link resolveOfficialMode} when an explicit `modeId` is available.
 * Host+slot runtime ids (`g00/4`) return null — they have no mode segment.
 */
export function officialModeFromServerId(
  serverId: string | null | undefined,
): OfficialModeId | null {
  const normalized = (serverId ?? "").trim().toLowerCase();
  const id = normalized.split("/").find(isOfficialModeId) ?? normalized;
  if (isOfficialModeId(id)) return id;
  return null;
}

/**
 * Resolve official mode preferring explicit `modeId` over legacy id parsing.
 *
 * - `{ modeId: "easy", serverId: "g00/4" }` → `"easy"`
 * - `{ serverId: "g00/easy/0" }` → `"easy"` (legacy only)
 * - `{ serverId: "g00/4" }` → `null` (slot id, no mode segment)
 */
export function resolveOfficialMode(
  opts: ResolveOfficialModeOpts,
): OfficialModeId | null {
  const rawMode = opts.modeId;
  if (rawMode != null && String(rawMode).trim() !== "") {
    const normalized = String(rawMode).trim().toLowerCase();
    if (isOfficialModeId(normalized)) return normalized;
  }
  return officialModeFromServerId(opts.serverId);
}

/** Minimum level to play this official mode (1 if unknown / un-gated). */
export function minLevelForMode(
  mode: OfficialModeId | string | null | undefined,
): number {
  if (mode == null) return 1;
  const id = String(mode).trim().toLowerCase();
  if (isOfficialModeId(id)) return MODE_UNLOCK_LEVELS[id];
  return 1;
}

/** True when `playerLevel` meets the unlock threshold for this mode. */
export function isModeUnlocked(
  mode: OfficialModeId | string | null | undefined,
  playerLevel: number,
): boolean {
  const need = minLevelForMode(mode);
  const level = Number.isFinite(playerLevel)
    ? Math.max(1, Math.floor(playerLevel))
    : 1;
  return level >= need;
}

/**
 * Human-readable lock reason, or null when unlocked.
 * Unknown levels are treated as 1 for gate messages.
 */
export function modeUnlockMessage(
  mode: OfficialModeId | string | null | undefined,
  playerLevel: number,
): string | null {
  if (isModeUnlocked(mode, playerLevel)) return null;
  const need = minLevelForMode(mode);
  const label = mode === "ranked"
    ? "Ranked"
    : mode === "hard"
    ? "Hard"
    : mode === "medium"
    ? "Medium"
    : mode === "easy"
    ? "Easy"
    : "This mode";
  return `Reach level ${need} to unlock ${label}. (You are level ${
    Math.max(1, Math.floor(playerLevel || 1))
  }.)`;
}
