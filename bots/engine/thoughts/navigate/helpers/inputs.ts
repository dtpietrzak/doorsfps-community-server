/**
 * PlayerInput builders used by the navigate thought.
 */

import type { PlayerInput } from "../../../shared/network.ts";

export function walkInput(
  lookYaw: number,
  pitch: number,
  sprint: boolean,
  keys?: {
    forward: boolean;
    backward: boolean;
    left: boolean;
    right: boolean;
  },
): PlayerInput {
  return {
    sequence: 0,
    forward: keys?.forward ?? true,
    backward: keys?.backward ?? false,
    left: keys?.left ?? false,
    right: keys?.right ?? false,
    jump: false,
    sprint,
    crouch: false,
    yaw: lookYaw,
    pitch,
  };
}

export function vaultInput(
  faceYaw: number,
  pitch: number,
  sprint: boolean,
  keys: {
    forward: boolean;
    backward?: boolean;
    left: boolean;
    right: boolean;
    jump: boolean;
  },
): PlayerInput {
  return {
    sequence: 0,
    forward: keys.forward,
    backward: Boolean(keys.backward),
    left: keys.left,
    right: keys.right,
    jump: keys.jump,
    sprint,
    crouch: false,
    yaw: faceYaw,
    pitch,
  };
}

export function duckInput(
  faceYaw: number,
  pitch: number,
  keys: {
    forward: boolean;
    backward?: boolean;
    left: boolean;
    right: boolean;
  },
): PlayerInput {
  return {
    sequence: 0,
    forward: keys.forward,
    backward: Boolean(keys.backward),
    left: keys.left,
    right: keys.right,
    jump: false,
    // Crouch under — no sprint while ducked.
    sprint: false,
    crouch: true,
    yaw: faceYaw,
    pitch,
  };
}

/** Hold look, zero movement/keys — match-over idle (never invents a shot/reload/etc). */
export function idleInput(yaw: number, pitch: number): PlayerInput {
  return {
    sequence: 0,
    forward: false,
    backward: false,
    left: false,
    right: false,
    jump: false,
    sprint: false,
    crouch: false,
    yaw,
    pitch,
  };
}

export function combatMoveInput(
  lookYaw: number,
  pitch: number,
  sprint: boolean,
  crouch: boolean,
  jump: boolean,
  keys: {
    forward: boolean;
    backward: boolean;
    left: boolean;
    right: boolean;
  },
): PlayerInput {
  return {
    sequence: 0,
    forward: keys.forward,
    backward: keys.backward,
    left: keys.left,
    right: keys.right,
    jump,
    sprint: crouch ? false : sprint,
    crouch,
    yaw: lookYaw,
    pitch,
  };
}
