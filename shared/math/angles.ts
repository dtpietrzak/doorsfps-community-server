import { HALF_PI, PI, TWO_PI } from "./constants.ts";

export type SinCos = Readonly<{ sin: number; cos: number }>;

/** Mutable pair written by {@link fastSinCosInto}. */
export type SinCosOut = { sin: number; cos: number };

/**
 * Wrap a gameplay angle into [-PI, PI]. Bot angles are expected to be within a
 * few turns; repeated subtraction avoids the dynamic Math surface entirely.
 */
export function wrapRadians(angle: number): number {
  let wrapped = angle;
  while (wrapped > PI) wrapped -= TWO_PI;
  while (wrapped < -PI) wrapped += TWO_PI;
  return wrapped;
}

export function angleDelta(target: number, current: number): number {
  return wrapRadians(target - current);
}

/**
 * Shared fast sin/cos for movement and look directions.
 *
 * Range reduction keeps the polynomial on [-PI/2, PI/2]. The approximation
 * budget is intentionally visual/gameplay oriented: <0.001 absolute error is
 * substantially below movement, collision, and network quantization effects.
 *
 * `fastSin` and `fastCos` each run only their own series and allocate nothing.
 * Their range reduction matches `fastSinCosInto`.
 */
function sinSeries(x: number, x2: number): number {
  return x * (
    1 + x2 * (
        -0.16666666666666666 + x2 * (
            0.008333333333333333 + x2 * (
                -0.0001984126984126984 + x2 * (
                    0.0000027557319223985893 + x2 * -0.00000002505210838544172
                  )
              )
          )
      )
  );
}

function cosSeries(x2: number, cosSign: number): number {
  return cosSign * (
    1 + x2 * (
        -0.5 + x2 * (
            0.041666666666666664 + x2 * (
                -0.001388888888888889 + x2 * (
                    0.0000248015873015873 + x2 * (
                        -0.0000002755731922398589 +
                        x2 * 0.00000000208767569878681
                      )
                  )
              )
          )
      )
  );
}

export function fastSinCosInto(angle: number, out: SinCosOut): void {
  let x = wrapRadians(angle);
  let cosSign = 1;

  if (x > HALF_PI) {
    x = PI - x;
    cosSign = -1;
  } else if (x < -HALF_PI) {
    x = -PI - x;
    cosSign = -1;
  }

  const x2 = x * x;
  out.sin = sinSeries(x, x2);
  out.cos = cosSeries(x2, cosSign);
}

export function fastSinCos(angle: number): SinCos {
  const out: SinCosOut = { sin: 0, cos: 0 };
  fastSinCosInto(angle, out);
  return out;
}

export function fastSin(angle: number): number {
  let x = wrapRadians(angle);
  if (x > HALF_PI) x = PI - x;
  else if (x < -HALF_PI) x = -PI - x;
  const x2 = x * x;
  return sinSeries(x, x2);
}

export function fastCos(angle: number): number {
  let x = wrapRadians(angle);
  let cosSign = 1;
  if (x > HALF_PI) {
    x = PI - x;
    cosSign = -1;
  } else if (x < -HALF_PI) {
    x = -PI - x;
    cosSign = -1;
  }
  return cosSeries(x * x, cosSign);
}

/**
 * Fast quadrant-aware atan2. Its maximum intended error is 0.011 radians
 * (~0.63 degrees), well inside the bot aim/motion humanization envelope.
 */
export function fastAtan2(y: number, x: number): number {
  if (x === 0 && y === 0) return 0;
  // Exact cardinal axes matter to discrete movement branching: a tiny error at
  // +X can turn an exact PI look-to-move delta from stable-left into right.
  if (y === 0) return x < 0 ? PI : 0;
  if (x === 0) return y < 0 ? -HALF_PI : HALF_PI;

  const absY = y < 0 ? -y : y;
  let ratio: number;
  let angle: number;

  if (x >= 0) {
    ratio = (x - absY) / (x + absY);
    angle = PI * 0.25;
  } else {
    ratio = (x + absY) / (absY - x);
    angle = PI * 0.75;
  }

  const ratio2 = ratio * ratio;
  angle += (0.1963 * ratio2 - 0.9817) * ratio;
  return y < 0 ? -angle : angle;
}

/**
 * ScriptC-safe atan2 with two local correction steps. Use this for inverse
 * geometry and round trips that need more precision than gameplay bearing.
 */
export function refinedAtan2(y: number, x: number): number {
  if (x === 0 || y === 0) return fastAtan2(y, x);
  let angle = fastAtan2(y, x);
  const pair: SinCosOut = { sin: 0, cos: 0 };
  for (let i = 0; i < 2; i++) {
    fastSinCosInto(angle, pair);
    const cross = y * pair.cos - x * pair.sin;
    const dot = x * pair.cos + y * pair.sin;
    if (dot > -0.000000000001 && dot < 0.000000000001) break;
    angle += cross / dot;
  }
  return wrapRadians(angle);
}

/** Player yaw convention: forward is (-sin(yaw), -cos(yaw)). */
export function yawFromWorldDirection(dx: number, dz: number): number {
  return fastAtan2(-dx, -dz);
}

/** Suitable for FOV/config angles comfortably away from +/-PI/2. */
export function fastTan(angle: number): number {
  const pair: SinCosOut = { sin: 0, cos: 0 };
  fastSinCosInto(angle, pair);
  const cosAbs = pair.cos < 0 ? -pair.cos : pair.cos;
  if (cosAbs < 0.000001) return pair.sin < 0 ? -1_000_000 : 1_000_000;
  return pair.sin / pair.cos;
}
