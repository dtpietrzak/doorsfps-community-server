/**
 * Canonical third-person player proportions.
 *
 * The procedural cosmetics are authored against the measurements below and
 * then mapped into the current character silhouette. Keeping the mapping in
 * shared code lets the renderer, animation rig, and server hit volumes agree.
 */

export const PLAYER_AUTHORED_TORSO_BOTTOM_Y = 0.7;
export const PLAYER_AUTHORED_TORSO_TOP_Y = 1.284;
export const PLAYER_AUTHORED_HIP_Y = 0.58;
export const PLAYER_AUTHORED_HIP_TOP_Y = 0.65;
export const PLAYER_AUTHORED_HEAD_CENTER_Y = 1.55;
export const PLAYER_AUTHORED_HEAD_TOP_Y = 1.77;

/** Torso is translated onto the hips, never squashed. */
export const PLAYER_TORSO_HEIGHT_SCALE = 1;

/**
 * Set the hips slightly below their authored pivot. This shortens the thighs
 * while the knee and planted sole remain at their authored world heights.
 */
export const PLAYER_HIP_OFFSET_Y = -0.025;
export const PLAYER_HIP_Y = PLAYER_AUTHORED_HIP_Y + PLAYER_HIP_OFFSET_Y;

/**
 * Slide the whole upper assembly (head, visor, arms, torso) down until the
 * default torso bottom meets the default hip plate. No remaining waist gap.
 */
export const PLAYER_UPPER_BODY_OFFSET_Y = PLAYER_AUTHORED_HIP_TOP_Y +
  PLAYER_HIP_OFFSET_Y - PLAYER_AUTHORED_TORSO_BOTTOM_Y;

/** Uniform shell/detail/visor enlargement around the animated head center. */
export const PLAYER_HEAD_SCALE = 1.28 * 1.1;

/**
 * Helmet no longer slides down to pin the crown. Kept at 0 so the larger head
 * is allowed to raise overall height; the neck stays unscaled.
 */
export const PLAYER_HEAD_CONTENT_OFFSET_Y = 0;

/**
 * Extra drop of the head and neck only. Closes the collar without moving the
 * torso, so hips, legs, and figure scale stay put.
 */
export const PLAYER_HEAD_OFFSET_Y =
  -0.1 * (PLAYER_AUTHORED_TORSO_TOP_Y - PLAYER_AUTHORED_TORSO_BOTTOM_Y);

/**
 * Raise the visor (and first-person camera) a tad above helmet center.
 * Authored head-local Y; head scale and figure scale apply after.
 */
export const PLAYER_VISOR_LOCAL_Y = 0.022;

/**
 * Extra drop of the arms cosmetic: pads, hanging arms, and the held gun.
 * The torso stays put so the waist join does not reopen.
 */
export const PLAYER_ARM_OFFSET_Y = -0.05;

/**
 * Unscaled neck column in authored world Y. Bottom is buried in the torso so
 * slide and pitch cannot open a gap; top stays inside every helmet chin.
 */
export const PLAYER_NECK_BOTTOM_Y = 1.16;
export const PLAYER_NECK_TOP_Y = 1.50;

/** Head-top Y after helmet scale, before the waist slide and figure scale. */
export const PLAYER_HEAD_TOP_Y = PLAYER_AUTHORED_HEAD_CENTER_Y +
  (PLAYER_AUTHORED_HEAD_TOP_Y - PLAYER_AUTHORED_HEAD_CENTER_Y) *
    PLAYER_HEAD_SCALE;

/**
 * Uniform scale from the feet so the crown returns to PLAYER_HEAD_TOP_Y after
 * the waist-closing slide.
 */
export const PLAYER_FIGURE_SCALE = PLAYER_HEAD_TOP_Y /
  (PLAYER_HEAD_TOP_Y + PLAYER_UPPER_BODY_OFFSET_Y);

/** Thicken hands in the front silhouette without lengthening the grip wrap. */
export const PLAYER_HAND_THICKNESS_SCALE = 1.24;

/**
 * Per-style girth of hanging arms and shoulder pads. Length and the shared
 * weapon grip stay authored.
 * Standard +5%, Octo +10%, Diamond +15%, Spike +5%, Dome +10%, Football +10%,
 * Princess +5%, Zombie +15%, Secretary +5%.
 */
export const PLAYER_ARM_THICKNESS_SCALE = [
  1.05,
  1.1,
  1.15,
  1.05,
  1.1,
  1.1,
  1.05,
  1.15,
  1.05,
] as const;

export function playerArmThicknessScale(armType: number): number {
  const type = Number.isFinite(armType) ? Math.floor(armType) : 0;
  if (type < 0 || type >= PLAYER_ARM_THICKNESS_SCALE.length) return 1;
  return PLAYER_ARM_THICKNESS_SCALE[type]!;
}

/** Extra pad envelope after per-style arm girth. */
export const PLAYER_SHOULDER_SCALE_X = 1.05;
export const PLAYER_SHOULDER_SCALE_Y = 1.05;
export const PLAYER_SHOULDER_SCALE_Z = 1.15;

/** Add enough lateral width for shortened legs to read as deliberately stubby. */
export const PLAYER_LEG_THICKNESS_SCALE = 1.16;

/**
 * Extra bulk on standard / octo / diamond / spike / dome / zombie struts
 * and feet (left-right and front-back). Hip plates stay on the shared scale.
 */
export const PLAYER_STOCKY_LEG_THICKNESS_EXTRA = 1.2;

export function isStockyLegType(legType: number): boolean {
  switch (legType) {
    case 0:
    case 1:
    case 2:
    case 3:
    case 4:
    case 8:
      return true;
    default:
      return false;
  }
}

export function playerLegThicknessScale(legType: number): number {
  return isStockyLegType(legType)
    ? PLAYER_LEG_THICKNESS_SCALE * PLAYER_STOCKY_LEG_THICKNESS_EXTRA
    : PLAYER_LEG_THICKNESS_SCALE;
}

/** Front-back scale. Costume legs keep authored depth so their gait stays put. */
export function playerLegDepthScale(legType: number): number {
  return isStockyLegType(legType) ? playerLegThicknessScale(legType) : 1;
}

/**
 * Standard torso chassis depth (front→back). Stocky hip plates sit just inside
 * this so they read as the same mass without sticking out.
 */
export const PLAYER_AUTHORED_TORSO_DEPTH = 0.1452 * 2;
export const PLAYER_STOCKY_HIP_DEPTH = PLAYER_AUTHORED_TORSO_DEPTH * 0.96;

/** Shared black hip plate half-width (standard / octo / diamond / spike). */
export const PLAYER_HIP_PLATE_HALF_WIDTH = 0.17 * 1.1;
/** Authored hip-pivot X before spreading stocky struts to the plate edge. */
export const PLAYER_LEG_HIP_X = 0.09;
/** Keep the strut just inside the hip plate so the join cannot z-fight. */
export const PLAYER_LEG_HIP_INSET = 0.001;

function playerHipPlateHalfWidth(legType: number): number {
  switch (legType) {
    case 4:
      return PLAYER_HIP_PLATE_HALF_WIDTH * 1.16;
    case 8:
      return PLAYER_HIP_PLATE_HALF_WIDTH * 0.98;
    default:
      return PLAYER_HIP_PLATE_HALF_WIDTH;
  }
}

function playerLegHipStrutHalfWidth(legType: number): number {
  switch (legType) {
    case 2:
    case 3:
      return 0.062;
    case 4:
      return 0.05 * 0.98 * 1.05 * 1.12;
    case 8:
      return 0.05 * 1.08;
    default:
      return 0.05;
  }
}

/** Hip-pivot X so stocky strut outsides sit just inside the hip plate. */
export function playerLegHipX(legType: number): number {
  if (!isStockyLegType(legType)) return PLAYER_LEG_HIP_X;
  return playerHipPlateHalfWidth(legType) -
    playerLegHipStrutHalfWidth(legType) * playerLegThicknessScale(legType) -
    PLAYER_LEG_HIP_INSET;
}

/** Translate authored torso and attachment heights. */
export function playerUpperBodyWorldY(authoredY: number): number {
  return authoredY + PLAYER_UPPER_BODY_OFFSET_Y;
}

/** Head/neck follow the upper-body slide plus the extra collar drop. */
export function playerHeadWorldY(authoredY: number): number {
  return playerUpperBodyWorldY(authoredY) + PLAYER_HEAD_OFFSET_Y;
}

/**
 * Standing visor-center Y from feet. First-person view height must match this
 * so local aim sits in other players' visors.
 */
export const PLAYER_VISOR_CENTER_Y =
  (playerHeadWorldY(PLAYER_AUTHORED_HEAD_CENTER_Y) +
    PLAYER_VISOR_LOCAL_Y * PLAYER_HEAD_SCALE) * PLAYER_FIGURE_SCALE;

/** Standing helmet crown after the waist slide and figure scale. */
export const PLAYER_STAND_HEAD_TOP_WORLD_Y =
  playerHeadWorldY(PLAYER_HEAD_TOP_Y) * PLAYER_FIGURE_SCALE;

/** Full-crouch helmet crown — under half-walls (1.2). */
export const PLAYER_CROUCH_HEAD_TOP_Y = 1.0;

/** Stance Y-scale that drops the standing crown onto PLAYER_CROUCH_HEAD_TOP_Y. */
export const PLAYER_CROUCH_SCALE_Y =
  PLAYER_CROUCH_HEAD_TOP_Y / PLAYER_STAND_HEAD_TOP_WORLD_Y;

/** Crouch rest head-center Y before the waist slide and figure scale. */
export const PLAYER_AUTHORED_CROUCH_HEAD_CENTER_Y =
  PLAYER_AUTHORED_HEAD_CENTER_Y * PLAYER_CROUCH_SCALE_Y;

/** Crouched visor-center Y from feet after the shared stance Y-scale. */
export const PLAYER_CROUCH_VISOR_CENTER_Y =
  PLAYER_VISOR_CENTER_Y * PLAYER_CROUCH_SCALE_Y;

/** Pads, arms, and the held weapon follow the upper-body slide plus the extra drop. */
export function playerArmWorldY(authoredY: number): number {
  return playerUpperBodyWorldY(authoredY) + PLAYER_ARM_OFFSET_Y;
}

/** Torso follows the same slide; no Y-scale. */
export function playerTorsoWorldY(authoredY: number): number {
  return playerUpperBodyWorldY(authoredY);
}
