/**
 * Epic 4.8 — SIM file allowlist + forbid patterns for isolation scans.
 *
 * Headless runners and later #8/#9 recorders treat this list as the sim
 * boundary. See DETERMINISTIC_SIMULATION_ISOLATION.md.
 */

/** Package-relative paths that constitute the authoritative simulation surface. */
export const SIM_FILE_ALLOWLIST = [
  "shared/sim/moveStep.ts",
  "shared/sim/game.ts",
  "shared/sim/simRng.ts",
  "players/Player.ts",
  "players/PlayerManager.ts",
  "players/weaponsQueue.ts",
  "players/simTickPhases.ts",
  "players/simTickResult.ts",
  "players/simIsolation.ts",
  "world/MapCollision.ts",
  "bots/BotManager.ts",
  "bots/pipeline/applySteps.ts",
  "bots/pipeline/types.ts",
  "bots/pipeline/botInterp.ts",
] as const;

export type SimAllowlistPath = (typeof SIM_FILE_ALLOWLIST)[number];

/**
 * Import path substrings forbidden inside SIM allowlist modules.
 * (Scanned as source text — not a full resolver.)
 */
export const SIM_FORBID_IMPORT_SUBSTRINGS = [
  "transport/",
  "three",
  "from \"three\"",
  "from 'three'",
  ".tsx",
  "AudioContext",
] as const;

/** Direct wall-clock / process RNG reads forbidden in SIM allowlist sources. */
export const SIM_FORBID_DIRECT_READ_PATTERNS = [
  /\bDate\.now\s*\(/,
  /\bperformance\.now\s*\(/,
  /\bMath\.random\s*\(/,
] as const;
