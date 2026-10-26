/**
 * Match-seeded simulation RNG (replay epic 4.6).
 *
 * Stream names (`damage` | `spread` | `spawn` | `agents`) are the future
 * seed-record / hash surface for #8 / #9 / #18. This module does not persist
 * or record anything.
 *
 * PRNG: xorshift32, matching MapCollision / bot-official createRandom style.
 */

/** Zero is a fixed point for xorshift32 — normalize to a stable non-zero seed. */
export function normalizeSeed(seed: number): number {
  const normalized = seed >>> 0;
  return normalized === 0 ? 0x6d2b79f5 : normalized;
}

/** Per-domain stream identities owned by epic 4.6. */
export const SIM_RNG_DOMAINS = ["damage", "spread", "spawn", "agents"] as const;
export type SimRngDomain = (typeof SIM_RNG_DOMAINS)[number];

/** Fixed XOR tags so domain streams stay independent under the same match seed. */
const DOMAIN_SEED_TAGS: Record<SimRngDomain, number> = {
  damage: 0xd4a6e001,
  spread: 0x5b8ead00,
  spawn: 0x5ba40001,
  agents: 0xa6e47501,
};

/** Derive a domain stream seed from the per-match seed. */
export function deriveDomainSeed(
  matchSeed: number,
  domain: SimRngDomain,
): number {
  return normalizeSeed(normalizeSeed(matchSeed) ^ DOMAIN_SEED_TAGS[domain]);
}

/**
 * Stateful xorshift32 stream in [0, 1).
 * Same recurrence as MapCollision.spawnRng / bot-official createRandom.
 *
 * Epic 9.1 — `getState` / `setState` expose the opaque u32 cursor word for
 * checkpoint capture / restore. Neither advances nor reseeds the stream.
 */
export type SimRngStream = (() => number) & {
  getState(): number;
  setState(n: number): void;
};

export function createSimRng(seed: number): SimRngStream {
  let state = normalizeSeed(seed);
  const draw = (): number => {
    let next = state >>> 0;
    if (next === 0) next = 0x6d2b79f5;
    next ^= next << 13;
    next ^= next >>> 17;
    next ^= next << 5;
    next >>>= 0;
    state = next;
    return next / 4_294_967_296;
  };
  draw.getState = (): number => state >>> 0;
  draw.setState = (n: number): void => {
    state = normalizeSeed(n);
  };
  return draw;
}

/** Live match seed when no override is provided (not itself recorded here). */
export function generateMatchSeed(
  randomBytes: (out: Uint32Array) => void = (out) => {
    // Deno/TS DOM libs type getRandomValues as ArrayBufferView<ArrayBuffer>;
    // Uint32Array defaults to ArrayBufferLike (includes SharedArrayBuffer).
    crypto.getRandomValues(out as Uint32Array<ArrayBuffer>);
  },
): number {
  const buf = new Uint32Array(1);
  randomBytes(buf);
  return normalizeSeed(buf[0]!);
}

export type MatchSimRngStreams = {
  matchSeed: number;
  damage: SimRngStream;
  spread: SimRngStream;
  spawn: SimRngStream;
  agents: SimRngStream;
};

/** Build all four domain streams from one match seed. */
export function createMatchSimRngStreams(matchSeed: number): MatchSimRngStreams {
  const seed = normalizeSeed(matchSeed);
  return {
    matchSeed: seed,
    damage: createSimRng(deriveDomainSeed(seed, "damage")),
    spread: createSimRng(deriveDomainSeed(seed, "spread")),
    spawn: createSimRng(deriveDomainSeed(seed, "spawn")),
    agents: createSimRng(deriveDomainSeed(seed, "agents")),
  };
}
