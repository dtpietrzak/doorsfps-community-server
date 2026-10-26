/** Zero is a fixed point for xorshift32, so normalize it to a stable seed. */
export function normalizeSeed(seed: number): number {
  const normalized = seed >>> 0;
  return normalized === 0 ? 0x6d2b79f5 : normalized;
}

export type RandomSample = Readonly<{ state: number; value: number }>;

/** Small deterministic PRNG with state that can live beside each bot brain. */
export function nextRandom(state: number): RandomSample {
  let next = normalizeSeed(state);
  next ^= next << 13;
  next ^= next >>> 17;
  next ^= next << 5;
  next >>>= 0;
  // Explicit float scale: ScriptC 0.0.35 may integer-divide `u32 / 2^32`.
  return { state: next, value: next * 2.3283064365386963e-10 };
}

/** Stateful xorshift stream. Replaces libc random in native and JS. */
export function createRandom(seed: number): () => number {
  let state = normalizeSeed(seed);
  return (): number => {
    const sample = nextRandom(state);
    state = sample.state;
    return sample.value;
  };
}

/** Deterministic stand-in when a caller omitted an rng. */
export function fallbackRandom(): number {
  return 0.5;
}
