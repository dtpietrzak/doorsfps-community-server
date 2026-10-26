export function abs(value: number): number {
  return value < 0 ? -value : value;
}

export function min(a: number, b: number): number {
  return a < b ? a : b;
}

export function max(a: number, b: number): number {
  return a > b ? a : b;
}

export function clamp(value: number, low: number, high: number): number {
  if (value < low) return low;
  if (value > high) return high;
  return value;
}

export function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

/** ScriptC-safe sign for steering branches. */
export function sign(value: number): number {
  if (value > 0) return 1;
  if (value < 0) return -1;
  return 0;
}

/** ScriptC-safe nearest integer for gameplay timing values. */
export function round(value: number): number {
  return value >= 0 ? (value + 0.5) | 0 : (value - 0.5) | 0;
}

/** ScriptC-safe ceiling for the small timing values used by bot code. */
export function ceil(value: number): number {
  const truncated = value | 0;
  return value > truncated ? truncated + 1 : truncated;
}

/** ScriptC-safe floor for the small cadence values used by bot code. */
export function floor(value: number): number {
  const truncated = value | 0;
  return value < truncated ? truncated - 1 : truncated;
}

/** Toward-zero integer for bag counts and other non-negative sim values. */
export function trunc(value: number): number {
  return value | 0;
}

const LN2 = 0.6931471805599453;

/**
 * Positive log1p for heatmap residuals. Range-reduces to [1, 2) then uses a
 * short series so native and JS share one implementation.
 */
export function log1p(value: number): number {
  if (value <= 0) return 0;
  let mantissa = 1 + value;
  let exponent = 0;
  while (mantissa >= 2) {
    mantissa *= 0.5;
    exponent += 1;
  }
  while (mantissa < 1) {
    mantissa *= 2;
    exponent -= 1;
  }
  const fraction = mantissa - 1;
  const f2 = fraction * fraction;
  const series = fraction -
    f2 * 0.5 +
    f2 * fraction / 3 -
    f2 * f2 / 4 +
    f2 * f2 * fraction / 5 -
    f2 * f2 * f2 / 6 +
    f2 * f2 * f2 * fraction / 7;
  return exponent * LN2 + series;
}
