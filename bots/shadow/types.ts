/** Stable seed that changes on each life without consuming gameplay RNG. */
export function botLifeRandomSeed(
  botId: string,
  spawnedAtTick: number,
): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < botId.length; index += 1) {
    hash ^= botId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  hash ^= spawnedAtTick >>> 0;
  hash = Math.imul(hash, 0x01000193);
  return hash >>> 0;
}
