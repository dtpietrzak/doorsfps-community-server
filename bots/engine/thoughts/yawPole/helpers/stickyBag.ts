/**
 * Flat sticky slots on {@link BotBrainState}.
 *
 * `shared/world/yawPole.ts` stores one optional point and deletes empty
 * ping-pong fields. The brain bag stores two numbers (`NaN` = unset) and
 * always keeps the commit list and ignore map, because the state copier
 * and dwell step read them unconditionally. Ping-pong math is the shared
 * module; this file only restores the fields shared deletes.
 */

import {
  clearYawPolePingPong as clearSharedPingPong,
  recordYawPoleClear as recordSharedClear,
  recordYawPoleCommit as recordSharedCommit,
  type StickyYawPoleState,
  type YawPolePoint,
} from "../../../../../shared/world/yawPole.ts";

export type NumericStickyBag = {
  stickyYawPoleX: number;
  stickyYawPoleZ: number;
  yawPoleCommitKeys: string[];
  yawPoleIgnore: Record<string, number>;
};

export function readStickyYawPole(
  state: NumericStickyBag,
): YawPolePoint | undefined {
  const x = state.stickyYawPoleX;
  const z = state.stickyYawPoleZ;
  if (!Number.isFinite(x) || !Number.isFinite(z)) return undefined;
  return { x, z };
}

export function writeStickyYawPole(
  state: NumericStickyBag,
  pole: YawPolePoint | null | undefined,
): void {
  if (pole && Number.isFinite(pole.x) && Number.isFinite(pole.z)) {
    state.stickyYawPoleX = pole.x;
    state.stickyYawPoleZ = pole.z;
    return;
  }
  state.stickyYawPoleX = Number.NaN;
  state.stickyYawPoleZ = Number.NaN;
}

function asShared(state: NumericStickyBag): StickyYawPoleState {
  return state;
}

function restorePingPong(state: NumericStickyBag): void {
  if (!Array.isArray(state.yawPoleCommitKeys)) state.yawPoleCommitKeys = [];
  if (state.yawPoleIgnore == null || typeof state.yawPoleIgnore !== "object") {
    state.yawPoleIgnore = {};
  }
}

export function recordYawPoleCommit(state: NumericStickyBag, key: string): void {
  recordSharedCommit(asShared(state), key);
  restorePingPong(state);
}

export function recordYawPoleClear(
  state: NumericStickyBag,
  arrivedKey: string,
): void {
  recordSharedClear(asShared(state), arrivedKey);
  restorePingPong(state);
}

export function clearYawPolePingPong(state: NumericStickyBag): void {
  clearSharedPingPong(asShared(state));
  state.yawPoleCommitKeys = [];
  state.yawPoleIgnore = {};
}

export function clearStickyYawPole(state: NumericStickyBag): void {
  writeStickyYawPole(state, null);
  clearYawPolePingPong(state);
}
