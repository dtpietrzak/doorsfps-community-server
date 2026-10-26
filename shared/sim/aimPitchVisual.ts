import {
  fastCos,
  fastSin,
  HALF_PI,
  max,
  min,
  RAD_PER_DEG,
} from "../math/index.ts";
import { PLAYER_AUTHORED_CROUCH_HEAD_CENTER_Y } from "./playerModelDimensions.ts";

/**
 * Third-person look pitch: spine bends half (capped) and arms take the rest.
 *
 * Arms are parented under the spine, so body + arms = look and the gun still
 * tracks aim. The spine cap is the only extra limit; arms have none.
 *
 * Head hitscan uses the same spine pitch so the sphere sits where the mesh
 * head is after looking up / down.
 */

/** Clamp networked look pitch for third-person aim. */
export const AIM_PITCH_LIMIT = HALF_PI - 0.01;

/** Spine / torso share of look pitch, either way. */
export const BODY_AIM_PITCH_LIMIT = 20 * RAD_PER_DEG;

/**
 * Spine pivot height from feet (RemotePlayers `upper` group).
 * Head is authored at {@link STAND_HEAD_CENTER_Y} on the standing figure.
 */
export const SPINE_PIVOT_Y = 0.88;

/** Standing head-sphere center from feet (hitscan HEAD_OFFSET_Y). */
export const STAND_HEAD_CENTER_Y = 1.55;

/** Crouched rest head center from feet (hitscan CROUCH_HEAD_OFFSET_Y). */
export const CROUCH_HEAD_CENTER_Y = PLAYER_AUTHORED_CROUCH_HEAD_CENTER_Y;

export function clampAimPitch(pitch: number): number {
  return max(-AIM_PITCH_LIMIT, min(AIM_PITCH_LIMIT, pitch));
}

/**
 * Split look pitch between spine and arms.
 * Body gets half of look, clamped to ±{@link BODY_AIM_PITCH_LIMIT}.
 * Arms get the remainder (no extra cap).
 */
export function splitLookAimPitch(
  lookPitch: number,
): { body: number; arms: number } {
  const look = clampAimPitch(lookPitch);
  const half = look * 0.5;
  const body = max(
    -BODY_AIM_PITCH_LIMIT,
    min(BODY_AIM_PITCH_LIMIT, half),
  );
  return { body, arms: look - body };
}

export function restHeadCenterY(crouch: boolean): number {
  return crouch ? CROUCH_HEAD_CENTER_Y : STAND_HEAD_CENTER_Y;
}

/**
 * Head-sphere center relative to feet after spine aim pitch.
 *
 * Matches the remote mesh: `upper.rotation.x = bodyPitch` around
 * {@link SPINE_PIVOT_Y}, child at (0, standHead − pivot, 0), then yaw
 * about Y. Crouch Y-scales the spine (same as the rig) so height drops;
 * forward / back uses the authored lever so it matches the unscaled Z.
 *
 * Mesh forward is −Z. Looking down (negative pitch) moves the head forward;
 * looking up moves it back.
 */
export function headHitOffsetFromFeet(opts: {
  yaw?: number;
  pitch?: number;
  crouch?: boolean;
}): { x: number; y: number; z: number } {
  const yaw = Number.isFinite(opts.yaw) ? (opts.yaw as number) : 0;
  const pitch = Number.isFinite(opts.pitch) ? (opts.pitch as number) : 0;
  const restY = restHeadCenterY(Boolean(opts.crouch));
  const stanceScale = restY / STAND_HEAD_CENTER_Y;
  const { body } = splitLookAimPitch(pitch);
  const lever = STAND_HEAD_CENTER_Y - SPINE_PIVOT_Y;
  const localY = stanceScale * (SPINE_PIVOT_Y + lever * fastCos(body));
  const localBack = lever * fastSin(body);
  return {
    x: localBack * fastSin(yaw),
    y: localY,
    z: localBack * fastCos(yaw),
  };
}
