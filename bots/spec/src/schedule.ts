/**
 * Bot think cadence shared by the private engine and the built-in brain.
 * Sim stays at 60 Hz. Brains advance on bot ticks (20 Hz). Actions apply
 * THINK_BUFFER_BOT_TICKS later.
 */

/** ScriptC-safe floor. Matches bot-official math for values in int32 range. */
function floor(value: number): number {
  const truncated = value | 0;
  return value < truncated ? truncated - 1 : truncated;
}

export const SIM_TICK_HZ = 60;
export const BOT_TICK_HZ = 20;
export const SIM_TICKS_PER_BOT_TICK = SIM_TICK_HZ / BOT_TICK_HZ;
export const THINK_BUFFER_BOT_TICKS = 3;
export const THINK_BUFFER_SIM_TICKS = THINK_BUFFER_BOT_TICKS * SIM_TICKS_PER_BOT_TICK;
export const THINK_BUFFER_TICKS = THINK_BUFFER_BOT_TICKS;

export function simToBotTick(simTick: number): number {
  return floor(simTick / SIM_TICKS_PER_BOT_TICK);
}

export function viewSimDelta(view: { simDelta?: number }): number {
  const value = view.simDelta;
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 1;
}

export function botTickPhase(simTick: number): number {
  const phase = simTick % SIM_TICKS_PER_BOT_TICK;
  return phase < 0 ? phase + SIM_TICKS_PER_BOT_TICK : phase;
}

export function botTickToSimTick(botTick: number): number {
  return botTick * SIM_TICKS_PER_BOT_TICK;
}
