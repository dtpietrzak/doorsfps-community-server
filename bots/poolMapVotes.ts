/**
 * Random map votes for pool pawns when a vote window opens.
 *
 * The share comes from the host-channel policy. Community servers leave the
 * policy off.
 */

export type PoolVoteShare = {
  minShare: number;
  maxShare: number;
};

/** Inclusive integer count in [minShare, maxShare] of `pawnCount`. */
export function poolMapVoteCount(
  pawnCount: number,
  share: PoolVoteShare,
  rand: () => number = Math.random,
): number {
  const n = Math.max(0, Math.trunc(pawnCount));
  if (n <= 0) return 0;

  const min = clampShare(share.minShare);
  const max = Math.max(min, clampShare(share.maxShare));
  let lo = Math.ceil(n * min);
  let hi = Math.floor(n * max);

  // n=1 has no integer in [20%, 80%]; widen to the nearest inclusive bounds.
  if (hi < lo) {
    lo = Math.floor(n * min);
    hi = Math.ceil(n * max);
  }

  lo = Math.max(0, Math.min(lo, n));
  hi = Math.max(lo, Math.min(hi, n));
  return lo + Math.floor(rand() * (hi - lo + 1));
}

/**
 * Pick a random subset of pool pawns and assign each a random map name.
 * Returns playerId → mapName entries to merge into the live vote map.
 */
export function seedPoolMapVotes(
  pawnIds: readonly string[],
  mapNames: readonly string[],
  share: PoolVoteShare,
  rand: () => number = Math.random,
): Map<string, string> {
  const result = new Map<string, string>();
  if (pawnIds.length === 0 || mapNames.length === 0) return result;

  const count = poolMapVoteCount(pawnIds.length, share, rand);
  if (count <= 0) return result;

  const order = pawnIds.slice();
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = order[i]!;
    order[i] = order[j]!;
    order[j] = tmp;
  }

  for (let i = 0; i < count; i++) {
    const playerId = order[i]!;
    const mapName = mapNames[Math.floor(rand() * mapNames.length)]!;
    result.set(playerId, mapName);
  }
  return result;
}

function clampShare(share: number): number {
  if (!Number.isFinite(share)) return 0;
  return Math.max(0, Math.min(1, share));
}
