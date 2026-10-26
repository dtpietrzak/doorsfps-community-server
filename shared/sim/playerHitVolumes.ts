import { SPINE_PIVOT_Y, splitLookAimPitch } from "./aimPitchVisual.ts";
import { WALK_SPEED } from "./game.ts";
import {
  MOVE_CROUCH_EYE,
  MOVE_JUMP_VELOCITY,
  MOVE_STAND_EYE,
} from "./moveStep.ts";
import { CROUCH_HALF_STRIDE, PLAYER_HIP_Y, playerStance } from "./playerStance.ts";
import {
  PLAYER_AUTHORED_CROUCH_HEAD_CENTER_Y,
  PLAYER_CROUCH_HEAD_TOP_Y,
  PLAYER_CROUCH_SCALE_Y,
  PLAYER_FIGURE_SCALE,
  PLAYER_HAND_THICKNESS_SCALE,
  PLAYER_HEAD_SCALE,
  playerLegHipX,
  playerLegThicknessScale,
  PLAYER_NECK_BOTTOM_Y,
  PLAYER_NECK_TOP_Y,
  playerArmWorldY,
  playerTorsoWorldY,
  playerUpperBodyWorldY,
} from "./playerModelDimensions.ts";

export const STAND_EYE_HEIGHT = MOVE_STAND_EYE;
export const CROUCH_EYE_HEIGHT = MOVE_CROUCH_EYE;
export const PLAYER_EYE_HEIGHT = STAND_EYE_HEIGHT;
// Rest-envelope constants retained for camera/legacy consumers. Combat uses
// getPlayerHitVolumes, not these old circular, upright bounds.
export const HEAD_RADIUS = 0.26 * PLAYER_HEAD_SCALE;
export const HEAD_OFFSET_Y = 1.55;
export const CROUCH_HEAD_OFFSET_Y = PLAYER_AUTHORED_CROUCH_HEAD_CENTER_Y;
export const BODY_RADIUS = 0.32;
export const BODY_MIN_Y = 0.08;
export const BODY_MAX_Y = 1.34;
export const CROUCH_BODY_MIN_Y = 0.08;
export const CROUCH_BODY_MAX_Y = 0.85;

export type HitVec3 = { x: number; y: number; z: number };
export type PlayerHitPose = HitVec3 & {
  crouch?: boolean;
  slide?: boolean;
  yaw?: number;
  pitch?: number;
  /** Rewind-safe authoritative motion used by the locomotion volume layer. */
  velocityX?: number;
  velocityY?: number;
  velocityZ?: number;
  onGround?: boolean;
  /** Continuous post-landing compression captured with the pose. */
  landingAmount?: number;
  /** Gameplay scale (e.g. bosses), independent of equipped cosmetics. */
  scale?: number;
  /** Continuous animation blends; authority may also supply discrete stances. */
  crouchAmount?: number;
  slideAmount?: number;
  slideLead?: -1 | 1;
  /** Small presentation offsets, used by the Styles preview. */
  rootPitch?: number;
  rootRoll?: number;
  /** Additive animation pitch above the normal aim-pitch split. */
  upperPitch?: number;
  upperYaw?: number;
  upperRoll?: number;
  rigOffset?: HitVec3;
  upperOffset?: HitVec3;
};

/** Columns of an affine transform from a unit primitive into world space.
 * Sphere: radius 1. Cylinder: radius 1, y in [-1, 1], with flat end caps.
 * Keeping the complete basis also handles nonuniform scale inside a rotation.
 */
export type HitVolume = {
  center: HitVec3;
  xAxis: HitVec3;
  yAxis: HitVec3;
  zAxis: HitVec3;
};
export type PlayerHitVolumes = { head: HitVolume; body: HitVolume };

export type PlayerHitAnimation = {
  crouchAmount: number;
  rootPitch: number;
  rootRoll: number;
  upperPitch: number;
  upperRoll: number;
  rigOffset: HitVec3;
  /** 0 at rest, 1 at full walk/sprint; drives the gait limb envelope. */
  locomotionAmount: number;
  /** Largest animated ankle reach from root center in the movement plane. */
  gaitReach: number;
  localRight: number;
  localForward: number;
  airborne: boolean;
};

export function eyeHeight(crouch: boolean): number {
  return crouch ? CROUCH_EYE_HEIGHT : STAND_EYE_HEIGHT;
}
export function feetYFromEye(eyeY: number, crouch = false): number {
  return eyeY - eyeHeight(crouch);
}
export function headOffsetY(crouch: boolean): number {
  return crouch ? CROUCH_HEAD_OFFSET_Y : HEAD_OFFSET_Y;
}
export function bodyMinY(crouch: boolean): number {
  return crouch ? CROUCH_BODY_MIN_Y : BODY_MIN_Y;
}
export function bodyMaxY(crouch: boolean): number {
  return crouch ? CROUCH_BODY_MAX_Y : BODY_MAX_Y;
}

const v = (x = 0, y = 0, z = 0): HitVec3 => ({ x, y, z });
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const finite = (n: number | undefined, fallback = 0) => Number.isFinite(n) ? n! : fallback;
const clamp = (n: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, n));
function rotateX(p: HitVec3, angle: number): HitVec3 {
  const c = Math.cos(angle), s = Math.sin(angle);
  return v(p.x, p.y * c - p.z * s, p.y * s + p.z * c);
}
function rotateY(p: HitVec3, angle: number): HitVec3 {
  const c = Math.cos(angle), s = Math.sin(angle);
  return v(p.x * c + p.z * s, p.y, -p.x * s + p.z * c);
}
function rotateZ(p: HitVec3, angle: number): HitVec3 {
  const c = Math.cos(angle), s = Math.sin(angle);
  return v(p.x * c - p.y * s, p.x * s + p.y * c, p.z);
}
function add(a: HitVec3, b: HitVec3): HitVec3 {
  return v(a.x + b.x, a.y + b.y, a.z + b.z);
}
function sub(a: HitVec3, b: HitVec3): HitVec3 {
  return v(a.x - b.x, a.y - b.y, a.z - b.z);
}
const dot = (a: HitVec3, b: HitVec3) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: HitVec3, b: HitVec3) => v(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);

/** Keep this synchronized with the remote/admin landing recovery. */
export const PLAYER_LANDING_RECOVER_SECONDS = 0.18;
const LOCOMOTION_ACTIVE_START = 0.55;
const LOCOMOTION_WALK_SPEED = WALK_SPEED;
const LOCOMOTION_SPRINT_START = 6.4;
const LOCOMOTION_SPRINT_END = 8.5;
const SPRINT_MIN_FORWARD = 0.35;
const SPRINT_FULL_FORWARD = 0.7;
const JUMP_CROUCH_RELEASE_POWER = Math.log(0.5) / Math.log(0.75);

/** Landing compression at an authoritative time since ground contact. */
export function playerLandingHitAmount(secondsSinceLanding: number): number {
  const seconds = finite(secondsSinceLanding);
  if (seconds < 0 || seconds >= PLAYER_LANDING_RECOVER_SECONDS) return 0;
  return 0.5 * (1 - smooth01(0, PLAYER_LANDING_RECOVER_SECONDS, seconds));
}

/**
 * Pose-only locomotion transforms shared by hitscan, debug overlays and UI
 * picking. Phase-specific hand/foot sway stays inside the fitted body envelope;
 * head/torso lean and jump/landing compression follow the authored animation.
 */
export function playerHitAnimation(pose: PlayerHitPose): PlayerHitAnimation {
  const yaw = finite(pose.yaw);
  const vx = finite(pose.velocityX);
  const vy = finite(pose.velocityY);
  const vz = finite(pose.velocityZ);
  const sinYaw = Math.sin(yaw);
  const cosYaw = Math.cos(yaw);
  const localX = vx * cosYaw - vz * sinYaw;
  const localZ = -vx * sinYaw - vz * cosYaw;
  const speed = Math.hypot(localX, localZ);
  const locomotionAmount = smooth01(
    LOCOMOTION_ACTIVE_START,
    LOCOMOTION_WALK_SPEED,
    speed,
  );
  const localRight = speed > 1e-6 ? localX / speed : 0;
  const localForward = speed > 1e-6 ? localZ / speed : 0;
  const sprintSpeed = smooth01(
    LOCOMOTION_SPRINT_START,
    LOCOMOTION_SPRINT_END,
    speed,
  );
  const sprintCoverage = localForward <= 0
    ? 0
    : smooth01(SPRINT_MIN_FORWARD, SPRINT_FULL_FORWARD, localForward);
  const sprint = pose.crouch || pose.slide
    ? 0
    : sprintSpeed * sprintCoverage;
  const walk = locomotionAmount * (1 - sprint);
  const airborne = pose.onGround === false ||
    (pose.onGround === undefined && Math.abs(vy) > 1.8);

  let crouchAmount = pose.crouch || pose.slide ? 1 : 0;
  if (Number.isFinite(pose.crouchAmount)) {
    crouchAmount = clamp(pose.crouchAmount!);
  } else if (airborne) {
    const verticalFraction = clamp(Math.abs(vy) / MOVE_JUMP_VELOCITY);
    const jumpCrouch = (verticalFraction * verticalFraction) **
      JUMP_CROUCH_RELEASE_POWER;
    // The air layer owns posture even if crouch is still held; the renderer
    // releases the takeoff tuck instead of staying fully ducked in mid-air.
    crouchAmount = jumpCrouch * 0.5;
  } else {
    crouchAmount = Math.max(crouchAmount, clamp(finite(pose.landingAmount)));
  }

  let derivedRootPitch = 0;
  let derivedRootRoll = 0;
  let derivedUpperPitch = 0;
  let derivedUpperRoll = 0;
  const derivedRigOffset = v();
  if (airborne) {
    derivedRootPitch = -localForward * 0.035 * locomotionAmount;
    derivedRootRoll = -localRight * 0.035 * locomotionAmount;
    const rise = smoothUnit(clamp(vy / MOVE_JUMP_VELOCITY));
    const fall = smoothUnit(clamp(-vy / MOVE_JUMP_VELOCITY));
    const apex = Math.max(0, 1 - rise - fall);
    derivedRigOffset.y = (0.02 + apex * 0.02) * (1 - crouchAmount * 2);
  } else if (pose.crouch && !pose.slide) {
    derivedRootPitch = -Math.max(0, localForward) * 0.025 * locomotionAmount;
    derivedRootRoll = -localRight * 0.035 * locomotionAmount;
  } else if (!pose.slide) {
    derivedRootPitch = -localForward * 0.105 * sprint;
    derivedRootRoll = -localRight * 0.065 * sprint;
    derivedUpperPitch = -localForward * 0.025 * walk;
    derivedUpperRoll = -localRight * 0.035 * walk;
    derivedRigOffset.z = -Math.max(0, localForward) * 0.008 * sprint;
  }

  const gaitHip = lerp(0.42, 0.64, sprint);
  const legLength = Math.max(0, PLAYER_HIP_Y - 0.11);
  const gaitReach = locomotionAmount <= 0
    ? 0
    : 0.17 + Math.sin(gaitHip) * legLength;
  return {
    crouchAmount,
    rootPitch: finite(pose.rootPitch, derivedRootPitch),
    rootRoll: finite(pose.rootRoll, derivedRootRoll),
    upperPitch: finite(pose.upperPitch, derivedUpperPitch),
    upperRoll: finite(pose.upperRoll, derivedUpperRoll),
    rigOffset: pose.rigOffset ?? derivedRigOffset,
    locomotionAmount,
    gaitReach,
    localRight,
    localForward,
    airborne,
  };
}

function smoothUnit(t: number): number {
  return t * t * (3 - 2 * t);
}

function smooth01(lo: number, hi: number, value: number): number {
  if (value <= lo) return 0;
  if (value >= hi) return 1;
  return smoothUnit((value - lo) / (hi - lo));
}

/** One shared envelope for every cosmetic, sized for the largest styles.
 * Only the pose changes it; equipped cosmetics never select different bounds.
 */
// Includes the widest/tallest ordinary helmets and their protrusions. Hotdog
// and banana heads deliberately do not contribute to this common head size.
const HEAD_RADII = v(
  0.265 * PLAYER_HEAD_SCALE,
  0.28 * PLAYER_HEAD_SCALE,
  0.26 * PLAYER_HEAD_SCALE,
);
const HEAD_CENTER_OFFSET = v(
  0,
  0.005 * PLAYER_HEAD_SCALE,
  -0.015 * PLAYER_HEAD_SCALE,
);
// Combined largest torso, shoulder and hip extents, applied to everyone.
const BODY_FIT = { halfWidth: 0.271, halfDepth: 0.246, minY: 0.571, maxY: 1.517 };
const BODY_TOP_REDUCTION = 0.12;
const SHOULDER_HALF_WIDTH = 0.323;
const HIP_HALF_WIDTH = 0.281;
const HIP_HALF_DEPTH = 0.281;
/** Shared volume uses the thickest strut/foot envelope (mechanical + zombie). */
const LEG_THICKNESS = playerLegThicknessScale(0);
const LEG_HIP_X = playerLegHipX(0);

/** Fit two primitives to a handful of anatomical landmarks, never triangles.
 * Crouch knees/feet and the slide's extended leg determine the cylinder's
 * envelope. Head Y radius follows stance.scaleY so the crouched crown sits
 * under half-walls; X/Z stay full size.
 */
export function getPlayerHitVolumes(pose: PlayerHitPose): PlayerHitVolumes {
  const animation = playerHitAnimation(pose);
  const slide = Number.isFinite(pose.slideAmount)
    ? clamp(pose.slideAmount!)
    : animation.airborne
    ? 0
    : pose.slide
    ? 1
    : 0;
  const amount = Math.max(slide, animation.crouchAmount);
  const stance = playerStance(amount, slide);
  const bodyPitch = splitLookAimPitch(finite(pose.pitch)).body +
    animation.upperPitch;
  const upperOffset = pose.upperOffset ?? v();
  const upperVector = (p: HitVec3) => {
    const unscaled = v(p.x / stance.scaleX, p.y / stance.scaleY, p.z / stance.scaleZ);
    const rotated = rotateX(rotateY(rotateZ(unscaled, animation.upperRoll), finite(pose.upperYaw)), bodyPitch);
    return v(rotated.x * stance.scaleX, rotated.y * stance.scaleY, rotated.z * stance.scaleZ);
  };
  const spine = SPINE_PIVOT_Y * stance.scaleY;
  const upperPoint = (p: HitVec3) => add(
    upperVector(v(p.x, p.y - spine, p.z)),
    v(upperOffset.x * stance.scaleX, spine + upperOffset.y * stance.scaleY, upperOffset.z * stance.scaleZ),
  );
  const torsoPoint = (x: number, y: number, z: number) => upperPoint(add(
    rotateX(v(x * stance.scaleX, (y - PLAYER_HIP_Y) * stance.pieceY, z * stance.scaleZ), stance.trunkPitch),
    v(0, stance.bodyY, stance.pelvisZ),
  ));

  const headVector = (p: HitVec3) => upperVector(rotateX(p, stance.headPitch));
  const head: HitVolume = {
    center: add(
      upperPoint(v(0, stance.headY, stance.headZ)),
      headVector(v(
        HEAD_CENTER_OFFSET.x,
        HEAD_CENTER_OFFSET.y * stance.scaleY,
        HEAD_CENTER_OFFSET.z,
      )),
    ),
    xAxis: headVector(v(HEAD_RADII.x, 0, 0)),
    yAxis: headVector(v(0, HEAD_RADII.y * stance.scaleY, 0)),
    zAxis: headVector(v(0, 0, HEAD_RADII.z)),
  };

  const points: HitVec3[] = [];
  // Chamfered cross sections fit armor better than a circular upright tube.
  const ring = (point: (x: number, y: number, z: number) => HitVec3, y: number, rx: number, rz: number) => {
    for (const [x, z] of [[-1, 0], [1, 0], [0, -1], [0, 1], [-0.72, -0.72], [0.72, -0.72], [-0.72, 0.72], [0.72, 0.72]]) {
      points.push(point(x! * rx, y, z! * rz));
    }
  };
  ring(torsoPoint, playerTorsoWorldY(BODY_FIT.minY), BODY_FIT.halfWidth, BODY_FIT.halfDepth);
  ring(torsoPoint, playerTorsoWorldY(BODY_FIT.maxY), BODY_FIT.halfWidth * 0.92, BODY_FIT.halfDepth * 0.88);
  const shoulder = SHOULDER_HALF_WIDTH;
  const shoulderY = playerArmWorldY(1.26);
  points.push(torsoPoint(-shoulder, shoulderY, 0), torsoPoint(shoulder, shoulderY, 0));
  // The neck remains a body target where it joins the head.
  points.push(torsoPoint(
    0,
    playerUpperBodyWorldY((PLAYER_NECK_BOTTOM_Y + PLAYER_NECK_TOP_Y) / 2),
    0,
  ));
  ring((x, y, z) => v(x * stance.scaleX, stance.pelvisY + (y - PLAYER_HIP_Y) * stance.pieceY, stance.pelvisZ + z * stance.scaleZ),
    PLAYER_HIP_Y, HIP_HALF_WIDTH, HIP_HALF_DEPTH);

  for (const side of [-1, 1] as const) {
    const lead = side === (pose.slideLead ?? -1);
    const ankleY = 0.11;
    const legLength = PLAYER_HIP_Y - ankleY;
    const footZ = lerp(side * CROUCH_HALF_STRIDE * amount,
      stance.pelvisZ - (lead ? legLength * stance.pieceY - 0.015 : 0.065), slide);
    const x = side * (LEG_HIP_X * stance.scaleX + lerp(0.025, lead ? 0.015 : 0.065, slide) * amount);
    const thigh = (PLAYER_HIP_Y - 0.35) * stance.pieceY;
    const shin = (0.35 - ankleY) * stance.pieceY;
    const down = stance.pelvisY - ankleY, back = stance.pelvisZ - footZ;
    const distance = clamp(Math.hypot(down, back), 0.00001, thigh + shin);
    const hipPitch = Math.atan2(back, down) + Math.acos(clamp((thigh * thigh + distance * distance - shin * shin) / (2 * thigh * distance), -1, 1));
    const kneeY = stance.pelvisY - thigh * Math.cos(hipPitch);
    const kneeZ = stance.pelvisZ - thigh * Math.sin(hipPitch);
    points.push(
      v(x - 0.09 * LEG_THICKNESS, kneeY, kneeZ),
      v(x + 0.09 * LEG_THICKNESS, kneeY, kneeZ),
      v(x, kneeY + 0.08, kneeZ),
      v(x, kneeY, kneeZ - 0.095 * LEG_THICKNESS),
      v(x, kneeY, kneeZ + 0.085 * LEG_THICKNESS),
      v(x - 0.085 * LEG_THICKNESS, 0.035, footZ),
      v(x + 0.085 * LEG_THICKNESS, 0.035, footZ),
      v(x, 0.055, footZ - 0.17 * LEG_THICKNESS),
      v(x, 0.15, footZ + 0.12 * LEG_THICKNESS),
    );
  }
  // Standing walk/sprint can put a planted foot outside the old rest cylinder.
  // Add phase extrema in the movement plane so server rewind does not depend
  // on a client-rendered gait clock.
  if (amount < 0.05 && animation.gaitReach > 0) {
    const alongX = animation.localRight * animation.gaitReach;
    const alongZ = animation.localForward * animation.gaitReach;
    const acrossX = -animation.localForward * 0.1;
    const acrossZ = animation.localRight * 0.1;
    for (const side of [-1, 1] as const) {
      points.push(
        v(side * alongX + acrossX, 0.055, side * -alongZ + acrossZ),
        v(side * alongX - acrossX, 0.055, side * -alongZ - acrossZ),
      );
    }
  }
  // Hands are targets; the gun and muzzle flash are deliberately excluded.
  const grip = torsoPoint(0, playerUpperBodyWorldY(1.07), 0);
  const handGrowth = 0.085 * (PLAYER_HAND_THICKNESS_SCALE - 1) / 2;
  points.push(add(grip, upperVector(v(-0.19 - handGrowth, 0, -0.29))),
    add(grip, upperVector(v(0.24 + handGrowth, 0, -0.25))));
  if (slide > 0) {
    points.push(v(lerp(-shoulder, -0.47, slide), lerp(grip.y, 0.07, slide), lerp(grip.z, 0.44, slide)));
  }
  const top = torsoPoint(0, playerUpperBodyWorldY(1.3), 0);
  const axisPitch = Math.atan2(top.z + 0.43 * slide, top.y - 0.055);
  const body = fitCylinder(points, axisPitch);

  const scale = Math.max(0.1, finite(pose.scale, 1)) * PLAYER_FIGURE_SCALE;
  const rootVector = (p: HitVec3) => {
    const r = rotateY(
      rotateX(rotateZ(p, animation.rootRoll), animation.rootPitch),
      finite(pose.yaw),
    );
    return v(r.x * scale, r.y * scale, r.z * scale);
  };
  const feet = v(pose.x, feetYFromEye(pose.y, Boolean(pose.crouch)), pose.z);
  const rigOffset = animation.rigOffset;
  for (const volume of [head, body]) {
    volume.center = add(feet, rootVector(add(volume.center, rigOffset)));
    volume.xAxis = rootVector(volume.xAxis);
    volume.yAxis = rootVector(volume.yAxis);
    volume.zAxis = rootVector(volume.zAxis);
  }
  // Hitscan ellipsoid is taller than the helmet; pull the vertical radius down
  // as crouch deepens so the crown matches the 1.0 visual target.
  const crouchT = clamp(
    (1 - stance.scaleY) / Math.max(1e-6, 1 - PLAYER_CROUCH_SCALE_Y),
  );
  if (crouchT > 0) {
    const top = head.center.y + Math.abs(head.yAxis.y);
    const limit = feet.y + PLAYER_CROUCH_HEAD_TOP_Y;
    if (top > limit) {
      const allowedTop = top + (limit - top) * crouchT;
      const absY = Math.abs(head.yAxis.y);
      if (absY > 1e-8) {
        const s = Math.max(1e-4, absY - (top - allowedTop)) / absY;
        head.yAxis = v(head.yAxis.x * s, head.yAxis.y * s, head.yAxis.z * s);
      }
    }
  }
  return { head, body };
}

function fitCylinder(points: HitVec3[], pitch: number): HitVolume {
  const local = points.map((p) => rotateX(p, -pitch));
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const p of local) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
  }
  const center = v((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2);
  const rx = (maxX - minX) / 2 + 0.008;
  const rz = (maxZ - minZ) / 2 + 0.008;
  let radial = 1;
  for (const p of local) radial = Math.max(radial, ((p.x - center.x) / rx) ** 2 + ((p.z - center.z) / rz) ** 2);
  const pad = Math.sqrt(radial);
  const halfHeight = (maxY - minY) / 2 + 0.008;
  // Trim 12% of the height from the top only, preserving the bottom cap,
  // width, depth and animation-driven orientation in every mode.
  center.y -= halfHeight * BODY_TOP_REDUCTION;
  return {
    center: rotateX(center, pitch),
    xAxis: v(rx * pad, 0, 0),
    yAxis: rotateX(v(0, halfHeight * (1 - BODY_TOP_REDUCTION), 0), pitch),
    zAxis: rotateX(v(0, 0, rz * pad), pitch),
  };
}

/** Do not normalize the local direction: its t remains world-ray distance. */
function localRay(origin: HitVec3, dir: HitVec3, volume: HitVolume) {
  const ix = cross(volume.yAxis, volume.zAxis);
  const iy = cross(volume.zAxis, volume.xAxis);
  const iz = cross(volume.xAxis, volume.yAxis);
  const determinant = dot(volume.xAxis, ix);
  if (Math.abs(determinant) < 1e-12) return null;
  const transform = (p: HitVec3) => v(dot(p, ix) / determinant, dot(p, iy) / determinant, dot(p, iz) / determinant);
  return { origin: transform(sub(origin, volume.center)), dir: transform(dir) };
}

export function rayHitVolume(origin: HitVec3, dir: HitVec3, volume: HitVolume, kind: "head" | "body", maxRange: number): number | null {
  const local = localRay(origin, dir, volume);
  if (!local) return null;
  return kind === "head"
    ? raySphere(local.origin, local.dir, v(), 1, maxRange)
    : rayVerticalCapsule(local.origin, local.dir, 0, 0, -1, 1, 1, maxRange);
}

export function hitPlayerVolumes(origin: HitVec3, dir: HitVec3, maxRange: number, volumes: PlayerHitVolumes): { zone: "head" | "body"; distance: number } | null {
  const head = rayHitVolume(origin, dir, volumes.head, "head", maxRange);
  const body = rayHitVolume(origin, dir, volumes.body, "body", maxRange);
  // Head wins if the ray would reach it at all. A closer body shell (neck
  // overlap, pitched head behind the torso) must not steal the zone or
  // double-count. Distance stays first contact so this player still occludes.
  if (head !== null) {
    return { zone: "head", distance: body !== null && body < head ? body : head };
  }
  return body === null ? null : { zone: "body", distance: body };
}

export function hitPoseDistance(origin: HitVec3, dir: HitVec3, maxRange: number, pose: PlayerHitPose): number | null {
  return hitPlayerVolumes(origin, dir, maxRange, getPlayerHitVolumes(pose))?.distance ?? null;
}

/** General quadratic, also valid after nonuniformly scaling the ray. */
export function raySphere(origin: HitVec3, dir: HitVec3, center: HitVec3, radius: number, maxRange: number): number | null {
  const o = sub(origin, center);
  const a = dot(dir, dir), b = dot(o, dir), c = dot(o, o) - radius * radius;
  if (a < 1e-16) return null;
  if (c <= 0) return 0;
  const discriminant = b * b - a * c;
  if (discriminant < 0) return null;
  const t = (-b - Math.sqrt(discriminant)) / a;
  return t >= 0 && t <= maxRange ? t : null;
}

/** Legacy name; this is a finite cylinder with flat caps, not a capsule. */
export function rayVerticalCapsule(origin: HitVec3, dir: HitVec3, cx: number, cz: number, yMin: number, yMax: number, radius: number, maxRange: number): number | null {
  const ox = origin.x - cx, oz = origin.z - cz;
  const a = dir.x * dir.x + dir.z * dir.z;
  const c = ox * ox + oz * oz - radius * radius;
  if (c <= 0 && origin.y >= yMin && origin.y <= yMax) return 0;
  let best: number | null = null;
  const consider = (t: number) => {
    if (t >= 0 && t <= maxRange && (best === null || t < best)) best = t;
  };
  if (a > 1e-16) {
    const b = ox * dir.x + oz * dir.z;
    const discriminant = b * b - a * c;
    if (discriminant >= 0) {
      const root = Math.sqrt(discriminant);
      for (const t of [(-b - root) / a, (-b + root) / a]) {
        const y = origin.y + dir.y * t;
        if (y >= yMin && y <= yMax) consider(t);
      }
    }
  }
  if (Math.abs(dir.y) > 1e-16) {
    for (const y of [yMin, yMax]) {
      const t = (y - origin.y) / dir.y;
      if ((ox + dir.x * t) ** 2 + (oz + dir.z * t) ** 2 <= radius * radius) consider(t);
    }
  }
  return best;
}
