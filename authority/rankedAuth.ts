/**
 * Authority admission verification for official game servers.
 *
 * Tokens are issued by the authority backend after Clerk session verification.
 * Community servers never load this path.
 */

import {
  normalizeAccountUsername,
  normalizePlayerEquipment,
} from "../shared/sim/game.ts";
import {
  normalizeOwnedSkills,
  normalizeSkillLoadout,
} from "../shared/sim/skills.ts";
import { MMS_RANKS, type MmsRankId } from "../shared/progression/mmsRanks.ts";
import {
  type AuthorityPublicKeys,
  JOIN_TOKEN_TYPE,
  loadAuthorityPublicKeysFromEnv,
  parseOpenAssignmentClaims,
  type RankedJoinClaims,
  verifyAuthorityToken,
} from "../shared/authority/authorityTokens.ts";
import { resolveOfficialMode } from "../shared/progression/modeUnlocks.ts";

export type { RankedJoinClaims } from "../shared/authority/authorityTokens.ts";

export type VerifyAdmissionOptions = {
  /**
   * When true, require open assignment claims (`assignmentId` + `jti`).
   * Used by official open runtimes under OPEN_ASSIGNMENT_REQUIRED.
   * Ranked and community paths leave this false.
   */
  requireOpenAssignment?: boolean;
};

/**
 * Verify an authority-issued ranked/open account join token.
 * @param expectedServerId When set, token must target this authentic id.
 */
export async function verifyRankedJoinToken(
  token: unknown,
  publicKeys: AuthorityPublicKeys,
  expectedServerId?: string,
  options: VerifyAdmissionOptions = {},
): Promise<RankedJoinClaims | null> {
  const raw = await verifyAuthorityToken(token, publicKeys, JOIN_TOKEN_TYPE);
  if (!raw) return null;

  if (
    typeof raw.sub !== "string" ||
    typeof raw.username !== "string" ||
    typeof raw.serverId !== "string" ||
    typeof raw.exp !== "number"
  ) {
    return null;
  }

  if (raw.exp < Math.floor(Date.now() / 1000)) return null;
  if (expectedServerId && raw.serverId !== expectedServerId) return null;

  const name = normalizeAccountUsername(raw.username);
  if (!name) return null;

  const assignment = parseOpenAssignmentClaims(raw, {
    required: options.requireOpenAssignment === true,
  });
  if (assignment === null) return null;

  const partyId = typeof raw.partyId === "string" && raw.partyId.trim()
    ? raw.partyId.trim()
    : undefined;
  let partySize: number | undefined;
  if (
    typeof raw.partySize === "number" &&
    Number.isFinite(raw.partySize)
  ) {
    partySize = Math.max(1, Math.min(8, Math.floor(raw.partySize)));
  }

  const equipment = normalizePlayerEquipment({
    head: raw.head,
    visor: raw.visor,
    shoulder: raw.shoulder,
    body: raw.body,
    leg: raw.leg,
    hue: raw.hue,
    gunHue: raw.gunHue,
    bulletHue: raw.bulletHue,
    crosshairColor: raw.crosshairColor,
    nameHue: raw.nameHue,
    pistol: raw.pistol,
    rifle: raw.rifle,
    shotgun: raw.shotgun,
    scope: raw.scope,
    crosshair: raw.crosshair,
  });

  const ownedAbilities = normalizeOwnedSkills(raw.ownedAbilities);
  const skillLoadout = Array.isArray(raw.skillLoadout)
    ? normalizeSkillLoadout(raw.skillLoadout, ownedAbilities)
    : undefined;
  const xp = typeof raw.xp === "number" && Number.isFinite(raw.xp)
    ? Math.max(0, Math.trunc(raw.xp))
    : undefined;
  const mmsRankId = typeof raw.mmsRankId === "string" &&
      MMS_RANKS.some((rank) => rank.id === raw.mmsRankId)
    ? raw.mmsRankId as MmsRankId
    : undefined;
  const founderBadge = raw.founderBadge === true;
  const synthetic = raw.synthetic === true;

  const modeId = typeof raw.modeId === "string" && raw.modeId.trim()
    ? raw.modeId.trim()
    : undefined;
  const raidId = typeof raw.raidId === "string" && raw.raidId.trim()
    ? raw.raidId.trim()
    : undefined;
  const team = raw.team === "A" || raw.team === "B" ? raw.team : undefined;
  const matchKind = raw.matchKind === "raid" ? "raid" as const : undefined;
  const soloRaid = raw.soloRaid === true;

  return {
    sub: raw.sub,
    username: name,
    serverId: raw.serverId,
    exp: raw.exp,
    ...(modeId ? { modeId } : {}),
    ...(raidId ? { raidId } : {}),
    ...(team ? { team } : {}),
    ...(matchKind ? { matchKind } : {}),
    ...(soloRaid ? { soloRaid: true as const } : {}),
    ...(partyId ? { partyId } : {}),
    ...(partySize != null ? { partySize } : {}),
    ...(assignment
      ? { jti: assignment.jti, assignmentId: assignment.assignmentId }
      : {}),
    head: equipment.head,
    visor: equipment.visor,
    shoulder: equipment.shoulder,
    body: equipment.body,
    leg: equipment.leg,
    hue: equipment.hue,
    gunHue: equipment.gunHue,
    bulletHue: equipment.bulletHue,
    crosshairColor: equipment.crosshairColor,
    nameHue: equipment.nameHue,
    pistol: equipment.pistol,
    rifle: equipment.rifle,
    shotgun: equipment.shotgun,
    scope: equipment.scope,
    crosshair: equipment.crosshair,
    ownedAbilities,
    ...(skillLoadout != null ? { skillLoadout } : {}),
    ...(xp != null ? { xp } : {}),
    ...(mmsRankId ? { mmsRankId } : {}),
    ...(founderBadge ? { founderBadge: true } : {}),
    ...(synthetic ? { synthetic: true as const } : {}),
  };
}

export function loadTokenPublicKeysFromEnv(): AuthorityPublicKeys {
  return loadAuthorityPublicKeysFromEnv();
}

/**
 * Official open runtimes: require assignment-bearing admissions when true.
 * Defaults off for dual-accept rollout with legacy clients.
 */
export function loadOpenAssignmentRequiredFromEnv(): boolean {
  const raw = Deno.env.get("OPEN_ASSIGNMENT_REQUIRED");
  if (raw === undefined) return false;
  switch (raw.trim().toLowerCase()) {
    case "1":
    case "true":
    case "yes":
    case "on":
      return true;
    case "0":
    case "false":
    case "no":
    case "off":
      return false;
    default:
      throw new Error("OPEN_ASSIGNMENT_REQUIRED must be true or false");
  }
}

export function isRankedModeFromEnv(): boolean {
  const raw = Deno.env.get("SERVER_JOIN_MODE")?.trim().toLowerCase() ||
    Deno.env.get("RANKED")?.trim().toLowerCase() ||
    "";
  return raw === "ranked" || raw === "1" || raw === "true" || raw === "yes";
}

export function rankedServerIdFromEnv(): string {
  return Deno.env.get("RANKED_SERVER_ID")?.trim() || "ranked";
}

/**
 * Official open authentic modes (authority-issued account join).
 * Orchestrator sets RANKED_SERVER_ID to the runtime id and DOORS_MODE_ID to the
 * occupancy mode. Community hosts leave RANKED_SERVER_ID unset (defaults to
 * "ranked") and must not load the scoped reporting credentials.
 *
 * After host+slot cutover, runtime ids like `g00/0` do not encode mode — pass
 * `modeId` (from DOORS_MODE_ID) so open-official detection still works.
 */
export const OPEN_OFFICIAL_SERVER_IDS = ["easy", "medium", "hard"] as const;

export type OpenOfficialServerId = (typeof OPEN_OFFICIAL_SERVER_IDS)[number];

/**
 * True when this process is an official open Easy/Medium/Hard runtime.
 * Prefer `modeId`; `id` alone still works for legacy mode-bearing server ids.
 */
export function isOpenOfficialServerId(
  id: string | null | undefined,
  modeId?: string | null,
): boolean {
  const occupancy = (modeId ?? "").trim().toLowerCase();
  if (occupancy === "raid" || (id ?? "").trim().toLowerCase() === "raid") {
    return true;
  }
  const mode = resolveOfficialMode({ modeId, serverId: id });
  return mode === "easy" || mode === "medium" || mode === "hard";
}
