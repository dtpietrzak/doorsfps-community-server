/**
 * Join identity: protocol, community password, spectate token, ranked / open
 * token, and guest name. Cosmetic and progression fields land on one
 * JoinProfile. GameServer still admits the seat (jti, party cap, reclaim,
 * drain, name, bots, reservation acks). A raid token carries its claims on
 * the result; the seat path activates the raid. This file never imports
 * GameServer.
 */

import { consumeAdminActionJti, verifyAdminActionToken } from "../authority/adminAuth.ts";
import { verifyRankedJoinToken } from "../authority/rankedAuth.ts";
import type { AuthorityPublicKeys } from "../shared/authority/authorityTokens.ts";
import { checkPlayerName } from "../shared/authority/nameModeration.ts";
import type { MmsRankId } from "../shared/progression/mmsRanks.ts";
import { GAME_PROTO } from "../shared/net/index.ts";
import type { PlayerEquipment } from "../shared/sim/game.ts";
import type { SkillLoadout, SkillProductId } from "../shared/sim/skills.ts";
import { JoinErrors, type TeamId } from "../protocol/network.ts";
import type { ServerJoinMode } from "./gameServerOptions.ts";
import type { SessionData } from "../transport/types.ts";

/** 15 cosmetics plus the progression fields a join token can carry. */
export type JoinProfile = {
  head?: number;
  visor?: number;
  shoulder?: number;
  body?: number;
  leg?: number;
  hue?: number;
  gunHue?: number;
  bulletHue?: number;
  crosshairColor?: number;
  nameHue?: number;
  pistol?: number;
  rifle?: number;
  shotgun?: number;
  /** Rifle optic 0…4. Omitted joins use Standard. */
  scope?: number;
  crosshair?: number;
  ownedAbilities: SkillProductId[];
  skillLoadout?: SkillLoadout;
  xp?: number;
  mmsRankId?: MmsRankId;
  founderBadge?: boolean;
  /** False when the claim is absent. */
  synthetic: boolean;
};

/** Claim fields profileFromClaims reads. Null means "not present". */
export type JoinClaimFields = {
  head?: number | null;
  visor?: number | null;
  shoulder?: number | null;
  body?: number | null;
  leg?: number | null;
  hue?: number | null;
  gunHue?: number | null;
  bulletHue?: number | null;
  crosshairColor?: number | null;
  nameHue?: number | null;
  pistol?: number | null;
  rifle?: number | null;
  shotgun?: number | null;
  scope?: number | null;
  crosshair?: number | null;
  ownedAbilities?: SkillProductId[] | null;
  skillLoadout?: SkillLoadout | null;
  xp?: number;
  mmsRankId?: MmsRankId;
  founderBadge?: boolean;
  synthetic?: boolean;
};

/**
 * Flat success shape authenticateJoin still returns. Spectators omit the
 * profile fields. Seat admission fills reclaim and botsEvictedForJoin.
 */
export type AdmittedJoin = {
  ok: true;
  name: string;
  spectator?: boolean;
  reclaimPlayerId?: string;
  accountUserId?: string;
  partyId?: string;
  partySize?: number;
  assignmentId?: string;
  /** Bots removed during middleware seat free (S9-PR3 metrics). */
  botsEvictedForJoin?: number;
  /** Present for a raid token. The seat path activates from this bag. */
  raidJoin?: RaidJoinInput;
} & Partial<JoinProfile>;

export type VerifyJoinFailure = { ok: false; error: string };

/** Identity before seat admission. admissionJti is consumed by GameServer. */
export type VerifiedPlayerJoin = {
  ok: true;
  spectator?: false;
  name: string;
  accountUserId?: string;
  partyId?: string;
  partySize?: number;
  assignmentId?: string;
  admissionJti?: string;
  admissionExp?: number;
  /** Present for a raid token. The seat path activates from this bag. */
  raidJoin?: RaidJoinInput;
  profile: JoinProfile;
};

export type VerifyJoinIdentityResult =
  | VerifyJoinFailure
  | AdmittedJoin & { spectator: true }
  | VerifiedPlayerJoin;

export type RaidJoinInput = {
  team?: TeamId;
  raidId?: string;
  partySize?: number;
  soloRaid?: boolean;
};

export type JoinAuthContext = {
  isCommunityHost: boolean;
  joinPassword: string | null;
  authorityTokenPublicKeys: AuthorityPublicKeys;
  rankedServerId: string;
  joinMode: ServerJoinMode;
  openAssignmentRequired: boolean;
  openOfficial: boolean;
  isRaidRuntime: boolean;
  raidPartyTimedOut(partyId: string | undefined): boolean;
  raidJoinConflict(input: { team?: TeamId; raidId?: string }): boolean;
};

/** Roster writes the two reclaim sites already share. */
export interface ReclaimProfilePlayer {
  setEquipment(equipment: PlayerEquipment): void;
  setOwnedAbilities(owned: SkillProductId[]): void;
  setSkillLoadout(loadout: SkillLoadout): void;
  setProgression(
    xp: unknown,
    mmsRankId: unknown,
    founderBadge?: unknown,
  ): void;
}

/** Constant-time-ish compare so join passwords are not leaked by timing. */
export function joinPasswordsMatch(expected: string, provided: string): boolean {
  const a = new TextEncoder().encode(expected);
  const b = new TextEncoder().encode(provided);
  const n = Math.max(a.length, b.length);
  let diff = a.length === b.length ? 0 : 1;
  for (let i = 0; i < n; i++) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}

/**
 * Copy cosmetics and progression off a join token.
 * Only non-null cosmetic fields are copied. ownedAbilities defaults to [].
 * skillLoadout is copied only when it is an array.
 */
export function profileFromClaims(claims: JoinClaimFields): JoinProfile {
  const profile: JoinProfile = {
    ownedAbilities: claims.ownedAbilities ?? [],
    synthetic: claims.synthetic === true,
  };
  if (claims.head != null) profile.head = claims.head;
  if (claims.visor != null) profile.visor = claims.visor;
  if (claims.shoulder != null) profile.shoulder = claims.shoulder;
  if (claims.body != null) profile.body = claims.body;
  if (claims.leg != null) profile.leg = claims.leg;
  if (claims.hue != null) profile.hue = claims.hue;
  if (claims.gunHue != null) profile.gunHue = claims.gunHue;
  if (claims.bulletHue != null) profile.bulletHue = claims.bulletHue;
  if (claims.crosshairColor != null) profile.crosshairColor = claims.crosshairColor;
  if (claims.nameHue != null) profile.nameHue = claims.nameHue;
  if (claims.pistol != null) profile.pistol = claims.pistol;
  if (claims.rifle != null) profile.rifle = claims.rifle;
  if (claims.shotgun != null) profile.shotgun = claims.shotgun;
  if (claims.scope != null) profile.scope = claims.scope;
  if (claims.crosshair != null) profile.crosshair = claims.crosshair;
  if (Array.isArray(claims.skillLoadout)) {
    profile.skillLoadout = claims.skillLoadout;
  }
  if (claims.xp !== undefined) profile.xp = claims.xp;
  if (claims.mmsRankId !== undefined) profile.mmsRankId = claims.mmsRankId;
  if (claims.founderBadge !== undefined) profile.founderBadge = claims.founderBadge;
  return profile;
}

/**
 * Session bag written by the authenticate callback.
 * mmsRankId is copied only when truthy. founderBadge and synthetic are
 * stored as true or left absent.
 */
export function sessionDataFromJoin(result: AdmittedJoin): Partial<SessionData> {
  const data: Partial<SessionData> = { playerName: result.name };
  if (result.spectator) data.isSpectator = true;
  if (result.reclaimPlayerId) data.reclaimPlayerId = result.reclaimPlayerId;
  if (result.accountUserId) data.accountUserId = result.accountUserId;
  if (result.partyId) data.partyId = result.partyId;
  if (result.partySize != null) data.partySize = result.partySize;
  if (result.raidJoin) data.raidJoin = result.raidJoin;
  if (result.assignmentId) data.assignmentId = result.assignmentId;
  if (
    result.botsEvictedForJoin != null && result.botsEvictedForJoin > 0
  ) {
    data.botsEvictedForJoin = result.botsEvictedForJoin;
  }
  if (result.head != null) data.head = result.head;
  if (result.visor != null) data.visor = result.visor;
  if (result.shoulder != null) data.shoulder = result.shoulder;
  if (result.body != null) data.body = result.body;
  if (result.leg != null) data.leg = result.leg;
  if (result.hue != null) data.hue = result.hue;
  if (result.gunHue != null) data.gunHue = result.gunHue;
  if (result.bulletHue != null) data.bulletHue = result.bulletHue;
  if (result.crosshairColor != null) {
    data.crosshairColor = result.crosshairColor;
  }
  if (result.nameHue != null) data.nameHue = result.nameHue;
  if (result.pistol != null) data.pistol = result.pistol;
  if (result.rifle != null) data.rifle = result.rifle;
  if (result.shotgun != null) data.shotgun = result.shotgun;
  if (result.scope != null) data.scope = result.scope;
  if (result.crosshair != null) data.crosshair = result.crosshair;
  if (Array.isArray(result.ownedAbilities)) {
    data.ownedAbilities = result.ownedAbilities;
  }
  if (Array.isArray(result.skillLoadout)) {
    data.skillLoadout = result.skillLoadout;
  }
  if (result.xp != null) data.xp = result.xp;
  if (result.mmsRankId) data.mmsRankId = result.mmsRankId;
  if (result.founderBadge) data.founderBadge = true;
  if (result.synthetic) data.synthetic = true;
  return data;
}

/**
 * Equipment for a seated human. Null unless at least one cosmetic field is a
 * number. Missing numbers default to 0, except crosshairColor, which
 * defaults to -1.
 */
export function equipmentFromSessionData(
  data: SessionEquipmentSource,
): PlayerEquipment | null {
  return typeof data.head === "number" ||
      typeof data.visor === "number" ||
      typeof data.shoulder === "number" ||
      typeof data.body === "number" ||
      typeof data.leg === "number" ||
      typeof data.hue === "number" ||
      typeof data.gunHue === "number" ||
      typeof data.bulletHue === "number" ||
      typeof data.crosshairColor === "number" ||
      typeof data.nameHue === "number" ||
      typeof data.pistol === "number" ||
      typeof data.rifle === "number" ||
      typeof data.shotgun === "number" ||
      typeof data.scope === "number" ||
      typeof data.crosshair === "number"
    ? {
      head: typeof data.head === "number" ? data.head : 0,
      visor: typeof data.visor === "number" ? data.visor : 0,
      shoulder: typeof data.shoulder === "number" ? data.shoulder : 0,
      body: typeof data.body === "number" ? data.body : 0,
      leg: typeof data.leg === "number" ? data.leg : 0,
      hue: typeof data.hue === "number" ? data.hue : 0,
      gunHue: typeof data.gunHue === "number" ? data.gunHue : 0,
      bulletHue: typeof data.bulletHue === "number" ? data.bulletHue : 0,
      crosshairColor: typeof data.crosshairColor === "number"
        ? data.crosshairColor
        : -1,
      nameHue: typeof data.nameHue === "number" ? data.nameHue : 0,
      pistol: typeof data.pistol === "number" ? data.pistol : 0,
      rifle: typeof data.rifle === "number" ? data.rifle : 0,
      shotgun: typeof data.shotgun === "number" ? data.shotgun : 0,
      scope: typeof data.scope === "number" ? data.scope : 0,
      crosshair: typeof data.crosshair === "number" ? data.crosshair : 0,
    }
    : null;
}

export type SessionEquipmentSource = {
  head?: unknown;
  visor?: unknown;
  shoulder?: unknown;
  body?: unknown;
  leg?: unknown;
  hue?: unknown;
  gunHue?: unknown;
  bulletHue?: unknown;
  crosshairColor?: unknown;
  nameHue?: unknown;
  pistol?: unknown;
  rifle?: unknown;
  shotgun?: unknown;
  scope?: unknown;
  crosshair?: unknown;
};

/**
 * Apply a reconnect profile. Same writes on the early reclaim and the
 * late session-conflict takeover.
 */
export function applyReclaimProfile(
  player: ReclaimProfilePlayer,
  data: SessionData,
): void {
  const equipment = equipmentFromSessionData(data);
  if (equipment) player.setEquipment(equipment);
  if (Array.isArray(data.ownedAbilities)) {
    player.setOwnedAbilities(data.ownedAbilities);
  }
  if (Array.isArray(data.skillLoadout)) {
    player.setSkillLoadout(data.skillLoadout);
  }
  player.setProgression(
    data.xp,
    data.mmsRankId,
    data.founderBadge,
  );
}

/**
 * Resolve who is connecting.
 * Ranked: authority-issued join token required (username is the Clerk username).
 * Open official: authority-issued join token required (account or reservation).
 * Community: plain name only, after the join password.
 * Admin spectate: authority admin action token (cmd=spectate); no player slot.
 *
 * A raid token activates the raid here, before the caller runs drain, name,
 * and seat checks.
 */
export async function verifyJoinIdentity(
  authBag: Record<string, unknown> | null | undefined,
  ctx: JoinAuthContext,
): Promise<VerifyJoinIdentityResult> {
  const auth = authBag ?? {};
  if (Number(auth.proto) !== GAME_PROTO) {
    return { ok: false, error: JoinErrors.ProtocolMismatch };
  }
  if (ctx.isCommunityHost) {
    const provided = typeof auth.password === "string" ? auth.password : "";
    if (!ctx.joinPassword || provided.length === 0) {
      return { ok: false, error: JoinErrors.PasswordRequired };
    }
    if (!joinPasswordsMatch(ctx.joinPassword, provided)) {
      return { ok: false, error: JoinErrors.PasswordInvalid };
    }
  }
  const wantSpectate = auth.spectate === true ||
    auth.spectate === 1 ||
    auth.spectate === "1" ||
    auth.spectate === "true";

  if (wantSpectate) {
    if (Object.keys(ctx.authorityTokenPublicKeys).length === 0) {
      return { ok: false, error: JoinErrors.SpectateDenied };
    }
    const adminToken = auth.adminToken ?? auth.spectateToken ?? auth.token;
    const verified = await verifyAdminActionToken(
      adminToken,
      ctx.authorityTokenPublicKeys,
      ctx.rankedServerId,
    );
    if (!verified.ok || verified.claims.cmd !== "spectate") {
      return { ok: false, error: JoinErrors.SpectateDenied };
    }
    if (
      !consumeAdminActionJti(verified.claims.jti, verified.claims.exp)
    ) {
      return { ok: false, error: JoinErrors.SpectateDenied };
    }
    return {
      ok: true,
      spectator: true,
      name: "Spectator",
      accountUserId: verified.claims.sub,
    };
  }

  const token = auth.joinToken ?? auth.token;
  const requireOpenAssignment = ctx.openAssignmentRequired;

  if (ctx.joinMode === "ranked") {
    if (Object.keys(ctx.authorityTokenPublicKeys).length === 0) {
      return { ok: false, error: JoinErrors.AuthInvalid };
    }
    if (token == null || token === "") {
      return { ok: false, error: JoinErrors.AuthRequired };
    }
    const claims = await verifyRankedJoinToken(
      token,
      ctx.authorityTokenPublicKeys,
      ctx.rankedServerId,
    );
    if (!claims) {
      return { ok: false, error: JoinErrors.AuthInvalid };
    }
    return {
      ok: true,
      name: claims.username,
      accountUserId: claims.sub,
      ...(claims.partyId ? { partyId: claims.partyId } : {}),
      ...(claims.partySize != null ? { partySize: claims.partySize } : {}),
      profile: profileFromClaims(claims),
    };
  } else if (
    token != null && token !== "" &&
    Object.keys(ctx.authorityTokenPublicKeys).length > 0
  ) {
    // Open official: account join for open match/win + kill/door XP.
    // When OPEN_ASSIGNMENT_REQUIRED, the token must carry placement claims.
    const claims = await verifyRankedJoinToken(
      token,
      ctx.authorityTokenPublicKeys,
      ctx.rankedServerId,
      { requireOpenAssignment },
    );
    if (!claims) {
      return {
        ok: false,
        error: requireOpenAssignment
          ? JoinErrors.AssignmentRequired
          : JoinErrors.AuthInvalid,
      };
    }
    const tokenIsRaid = claims.matchKind === "raid" ||
      claims.modeId === "raid";
    if (tokenIsRaid !== ctx.isRaidRuntime) {
      return { ok: false, error: JoinErrors.AuthInvalid };
    }
    if (tokenIsRaid) {
      if (ctx.raidPartyTimedOut(claims.partyId)) {
        return { ok: false, error: JoinErrors.AssignmentInvalid };
      }
      if (
        ctx.raidJoinConflict({
          team: claims.team,
          raidId: claims.raidId,
        })
      ) {
        return { ok: false, error: JoinErrors.AuthInvalid };
      }
    }
    return {
      ok: true,
      name: claims.username,
      accountUserId: claims.sub,
      ...(claims.partyId ? { partyId: claims.partyId } : {}),
      ...(claims.partySize != null ? { partySize: claims.partySize } : {}),
      ...(claims.assignmentId ? { assignmentId: claims.assignmentId } : {}),
      ...(claims.jti
        ? { admissionJti: claims.jti, admissionExp: claims.exp }
        : {}),
      ...(tokenIsRaid
        ? {
          raidJoin: {
            team: claims.team,
            raidId: claims.raidId,
            partySize: claims.partySize,
            soloRaid: claims.soloRaid,
          },
        }
        : {}),
      profile: profileFromClaims(claims),
    };
  } else if (ctx.openOfficial) {
    // Official runtimes only admit authority-issued account/reservation
    // join tokens; a bare name is never enough.
    return {
      ok: false,
      error: requireOpenAssignment
        ? JoinErrors.AssignmentRequired
        : JoinErrors.AuthRequired,
    };
  } else {
    // Community: guest name only (no authority dependency).
    const checked = checkPlayerName(auth.name);
    if (!checked.ok) {
      if (checked.reason === "required") {
        return { ok: false, error: JoinErrors.NameRequired };
      }
      if (checked.reason === "profanity") {
        return { ok: false, error: JoinErrors.NameNotAllowed };
      }
      return { ok: false, error: JoinErrors.NameInvalid };
    }
    // Community name joins own no special abilities.
    return {
      ok: true,
      name: checked.name,
      profile: profileFromClaims({}),
    };
  }
}
