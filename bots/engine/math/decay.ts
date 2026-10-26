import { clamp01 } from "./scalar.ts";

/**
 * Approximate e^-x for motor smoothing and correlated aim noise.
 *
 * A fourth-order polynomial is evaluated after range reduction and then raised
 * by repeated squaring. Values below e^-12 are treated as settled because the
 * remaining signal is irrelevant to bot feel.
 */
export function fastExpNegative(value: number): number {
  if (value <= 0) return 1;
  if (value >= 12) return 0;

  const x = value * 0.0625;
  const x2 = x * x;
  let result = 1 - x + x2 * 0.5 - x2 * x / 6 + x2 * x2 / 24;
  result *= result;
  result *= result;
  result *= result;
  result *= result;
  return clamp01(result);
}

/** Fraction of a target reached this tick for a time constant in seconds. */
export function decayAlpha(deltaSeconds: number, tauSeconds: number): number {
  if (tauSeconds <= 0) return 1;
  if (deltaSeconds <= 0) return 0;
  return 1 - fastExpNegative(deltaSeconds / tauSeconds);
}

/** Bot think runs at 20 Hz, so this avoids carrying a delta through hot code. */
export function decayAlpha20Hz(tauSeconds: number): number {
  return decayAlpha(0.05, tauSeconds);
}
