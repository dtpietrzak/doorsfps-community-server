/** Angle constants are literals because ScriptC 0.0.35 treats the global Math object as dynamic. */
export const PI = 3.141592653589793;
export const TWO_PI = 6.283185307179586;
export const HALF_PI = 1.5707963267948966;
export const QUARTER_PI = 0.7853981633974483;
export const RAD_PER_DEG = 0.017453292519943295;
export const DEG_PER_RAD = 57.29577951308232;
export const SQRT2 = 1.4142135623730951;

export function radians(degrees: number): number {
  return degrees * RAD_PER_DEG;
}

export function degrees(radiansValue: number): number {
  return radiansValue * DEG_PER_RAD;
}
