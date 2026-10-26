import {
  PLAYER_AUTHORED_HEAD_CENTER_Y,
  PLAYER_CROUCH_SCALE_Y,
  PLAYER_HIP_Y,
  playerHeadWorldY,
} from "./playerModelDimensions.ts";

/** Shared articulation measurements for the renderer and cheap hit volumes. */
export {
  PLAYER_CROUCH_SCALE_Y,
  PLAYER_HIP_Y,
} from "./playerModelDimensions.ts";
/** Shortened legs use a narrower stance so the two-bone solver can plant them. */
export const CROUCH_HALF_STRIDE = 0.11;
export const CROUCH_STEP_HEIGHT = 0.065;

/** Standing head-center Y after the waist slide and extra collar drop. */
const REST_HEAD_Y = playerHeadWorldY(PLAYER_AUTHORED_HEAD_CENTER_Y);

export function playerStance(amount: number, slideAmount = 0, posture = amount, hipY = PLAYER_HIP_Y) {
  const crouch = Math.max(0, Math.min(1, amount));
  const bend = Math.max(0, Math.min(crouch, posture));
  const slide = Math.max(0, Math.min(1, slideAmount));
  const scaleY = 1 + (PLAYER_CROUCH_SCALE_Y - 1) * crouch;
  const pieceY = scaleY + (1 - scaleY) * (2 / 3) * (crouch ? bend / crouch : 0);
  const crouchPitch = -0.4 * bend;
  const trunkPitch = crouchPitch + (0.62 - crouchPitch) * slide;
  const collarToHip = (hipY - 1.3) * pieceY;
  const crouchHipY = 1.3 * scaleY + collarToHip * Math.cos(crouchPitch) + 0.035 * bend;
  const crouchHipZ = collarToHip * Math.sin(crouchPitch);
  const pelvisY = crouchHipY + (0.18 - crouchHipY) * slide;
  const pelvisZ = crouchHipZ + (-0.03 - crouchHipZ) * slide;
  const restHeadY = REST_HEAD_Y * scaleY;
  const headLever = (REST_HEAD_Y - hipY) * pieceY;
  return {
    crouch, bend, slide, scaleY, pieceY, trunkPitch, pelvisY, pelvisZ,
    scaleX: 1 + crouch * 0.035,
    scaleZ: 1 + crouch * 0.025,
    bodyY: pelvisY - 0.035 * bend * (1 - slide),
    headY: restHeadY + (pelvisY + headLever * Math.cos(trunkPitch) - restHeadY) * slide,
    headZ: (pelvisZ + headLever * Math.sin(trunkPitch)) * slide * 0.9,
    headPitch: 0.12 * slide,
  };
}
