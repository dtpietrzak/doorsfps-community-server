import { assertEquals } from "@std/assert";
import { GAME_PROTO } from "../shared/net/index.ts";
import { issueRankedJoinToken } from "../shared/authority/tokenIssuer.ts";
import { JoinErrors } from "../protocol/network.ts";
import type { SessionData } from "../transport/types.ts";
import {
  applyReclaimProfile,
  equipmentFromSessionData,
  type JoinAuthContext,
  type JoinClaimFields,
  joinPasswordsMatch,
  profileFromClaims,
  type ReclaimProfilePlayer,
  sessionDataFromJoin,
  verifyJoinIdentity,
  type VerifiedPlayerJoin,
} from "./joinAuth.ts";

function base64(value: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(value)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function keys() {
  const pair = await crypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"],
  ) as CryptoKeyPair;
  return {
    privateKey: base64(
      await crypto.subtle.exportKey("pkcs8", pair.privateKey),
    ),
    publicKeys: {
      current: base64(await crypto.subtle.exportKey("spki", pair.publicKey)),
    },
  };
}

function ctx(overrides: Partial<JoinAuthContext> = {}): JoinAuthContext {
  return {
    isCommunityHost: false,
    joinPassword: null,
    authorityTokenPublicKeys: {},
    rankedServerId: "ranked",
    joinMode: "open",
    openAssignmentRequired: false,
    openOfficial: false,
    isRaidRuntime: false,
    raidPartyTimedOut: () => false,
    raidJoinConflict: () => false,
    ...overrides,
  };
}

Deno.test("profileFromClaims copies only non-null cosmetics", () => {
  const profile = profileFromClaims({
    head: null,
    visor: 0,
    body: 3,
    crosshairColor: -1,
    ownedAbilities: null,
    skillLoadout: null,
    synthetic: false,
  });
  assertEquals(profile.head, undefined);
  assertEquals(profile.visor, 0);
  assertEquals(profile.body, 3);
  assertEquals(profile.crosshairColor, -1);
  assertEquals(profile.rifle, undefined);
  assertEquals(profile.ownedAbilities, []);
  assertEquals(profile.skillLoadout, undefined);
  assertEquals(profile.synthetic, false);
  assertEquals(profile.xp, undefined);
  assertEquals(profile.founderBadge, undefined);

  const full = profileFromClaims({
    ownedAbilities: ["quick"],
    skillLoadout: [null],
    xp: 0,
    mmsRankId: "scrap",
    founderBadge: false,
    synthetic: true,
  });
  assertEquals(full.ownedAbilities, ["quick"]);
  assertEquals(full.skillLoadout, [null]);
  assertEquals(full.xp, 0);
  assertEquals(full.mmsRankId, "scrap");
  assertEquals(full.founderBadge, false);
  assertEquals(full.synthetic, true);

  const notAnArray = profileFromClaims({
    skillLoadout: { slot: 1 } as unknown as JoinClaimFields["skillLoadout"],
  });
  assertEquals(notAnArray.skillLoadout, undefined);
  assertEquals(notAnArray.ownedAbilities, []);
});

Deno.test("sessionDataFromJoin keeps truthy rank and true-or-absent flags", () => {
  const data = sessionDataFromJoin({
    ok: true,
    name: "Ada",
    accountUserId: "user_1",
    partyId: "party-1",
    partySize: 0,
    botsEvictedForJoin: 0,
    head: 0,
    crosshairColor: -1,
    visor: null as unknown as number,
    ownedAbilities: ["quick"],
    skillLoadout: [null],
    xp: 0,
    mmsRankId: "scrap",
    founderBadge: true,
    synthetic: true,
  });
  assertEquals(data, {
    playerName: "Ada",
    accountUserId: "user_1",
    partyId: "party-1",
    partySize: 0,
    head: 0,
    crosshairColor: -1,
    ownedAbilities: ["quick"],
    skillLoadout: [null],
    xp: 0,
    mmsRankId: "scrap",
    founderBadge: true,
    synthetic: true,
  });

  const absent = sessionDataFromJoin({
    ok: true,
    name: "Ada",
    botsEvictedForJoin: 2,
    mmsRankId: "" as unknown as "scrap",
    founderBadge: false,
    synthetic: false,
    xp: undefined,
  });
  assertEquals(absent.mmsRankId, undefined);
  assertEquals(absent.founderBadge, undefined);
  assertEquals(absent.synthetic, undefined);
  assertEquals(absent.xp, undefined);
  assertEquals(absent.ownedAbilities, undefined);
  assertEquals(absent.botsEvictedForJoin, 2);

  const spectator = sessionDataFromJoin({
    ok: true,
    spectator: true,
    name: "Spectator",
    accountUserId: "admin_1",
  });
  assertEquals(spectator, {
    playerName: "Spectator",
    isSpectator: true,
    accountUserId: "admin_1",
  });
});

Deno.test("equipmentFromSessionData defaults missing numbers and rejects a bare bag", () => {
  assertEquals(equipmentFromSessionData({}), null);
  assertEquals(equipmentFromSessionData({ head: "no", visor: null }), null);

  assertEquals(equipmentFromSessionData({ head: 0 }), {
    head: 0,
    visor: 0,
    shoulder: 0,
    body: 0,
    leg: 0,
    hue: 0,
    gunHue: 0,
    bulletHue: 0,
    crosshairColor: -1,
    nameHue: 0,
    pistol: 0,
    rifle: 0,
    shotgun: 0,
    scope: 0,
    crosshair: 0,
  });

  const colorOnly = equipmentFromSessionData({ crosshairColor: 4 });
  assertEquals(colorOnly?.crosshairColor, 4);
  assertEquals(colorOnly?.head, 0);
});

Deno.test("applyReclaimProfile writes equipment, abilities, and progression", () => {
  const calls: string[] = [];
  const player: ReclaimProfilePlayer = {
    setEquipment(equipment) {
      calls.push(`equipment:${equipment.head}`);
    },
    setOwnedAbilities(owned) {
      calls.push(`owned:${owned.join(",")}`);
    },
    setSkillLoadout(loadout) {
      calls.push(`loadout:${loadout.length}`);
    },
    setProgression(xp, mmsRankId, founderBadge) {
      calls.push(`progress:${xp}:${mmsRankId}:${founderBadge}`);
    },
  };
  applyReclaimProfile(player, {
    head: 2,
    ownedAbilities: ["quick"],
    xp: 4,
    mmsRankId: "scrap",
    founderBadge: true,
  });
  assertEquals(calls, [
    "equipment:2",
    "owned:quick",
    "progress:4:scrap:true",
  ]);

  calls.length = 0;
  applyReclaimProfile(player, {
    skillLoadout: "no",
  } as unknown as SessionData);
  assertEquals(calls, ["progress:undefined:undefined:undefined"]);
});

Deno.test("joinPasswordsMatch compares the whole password", () => {
  assertEquals(joinPasswordsMatch("secret", "secret"), true);
  assertEquals(joinPasswordsMatch("", ""), true);
  assertEquals(joinPasswordsMatch("secret", "Secret"), false);
  assertEquals(joinPasswordsMatch("secret", "secrets"), false);
});

Deno.test("verifyJoinIdentity rejects protocol, password, and guest name failures", async () => {
  const mismatch = await verifyJoinIdentity({ proto: 0 }, ctx());
  assertEquals(mismatch, { ok: false, error: JoinErrors.ProtocolMismatch });

  const community = ctx({
    isCommunityHost: true,
    joinPassword: "secret",
  });
  assertEquals(
    await verifyJoinIdentity({ proto: GAME_PROTO }, community),
    { ok: false, error: JoinErrors.PasswordRequired },
  );
  assertEquals(
    await verifyJoinIdentity(
      { proto: GAME_PROTO, password: "nope", name: "Tester" },
      community,
    ),
    { ok: false, error: JoinErrors.PasswordInvalid },
  );
  assertEquals(
    await verifyJoinIdentity(
      { proto: GAME_PROTO, password: "secret" },
      community,
    ),
    { ok: false, error: JoinErrors.NameRequired },
  );
  const guest = await verifyJoinIdentity(
    { proto: GAME_PROTO, password: "secret", name: "Tester" },
    community,
  );
  assertEquals(guest.ok, true);
  if (guest.ok && !guest.spectator) {
    assertEquals(guest.name, "Tester");
    assertEquals(guest.profile.ownedAbilities, []);
    assertEquals(guest.profile.synthetic, false);
    assertEquals(guest.profile.head, undefined);
  }

  assertEquals(
    await verifyJoinIdentity(
      { proto: GAME_PROTO, password: "secret", name: "bad name" },
      community,
    ),
    { ok: false, error: JoinErrors.NameInvalid },
  );
});

Deno.test("verifyJoinIdentity requires a token on official runtimes", async () => {
  assertEquals(
    await verifyJoinIdentity(
      { proto: GAME_PROTO, name: "Tester" },
      ctx({ joinMode: "ranked" }),
    ),
    { ok: false, error: JoinErrors.AuthInvalid },
  );
  const key = await keys();
  assertEquals(
    await verifyJoinIdentity(
      { proto: GAME_PROTO },
      ctx({
        joinMode: "ranked",
        authorityTokenPublicKeys: key.publicKeys,
      }),
    ),
    { ok: false, error: JoinErrors.AuthRequired },
  );
  assertEquals(
    await verifyJoinIdentity(
      { proto: GAME_PROTO, name: "Tester" },
      ctx({ openOfficial: true }),
    ),
    { ok: false, error: JoinErrors.AuthRequired },
  );
  assertEquals(
    await verifyJoinIdentity(
      { proto: GAME_PROTO, name: "Tester" },
      ctx({ openOfficial: true, openAssignmentRequired: true }),
    ),
    { ok: false, error: JoinErrors.AssignmentRequired },
  );
  assertEquals(
    await verifyJoinIdentity(
      { proto: GAME_PROTO, spectate: true },
      ctx(),
    ),
    { ok: false, error: JoinErrors.SpectateDenied },
  );
});

Deno.test("verifyJoinIdentity carries raid claims and does not activate", async () => {
  const key = await keys();
  const issued = await issueRankedJoinToken(
    {
      sub: "user_1",
      username: "Raider",
      serverId: "raid-1",
      matchKind: "raid",
      modeId: "raid",
      team: "B",
      raidId: "clocking-out",
      partyId: "party-9",
      partySize: 3,
      soloRaid: true,
      head: 4,
      synthetic: true,
    },
    key.privateKey,
    "current",
  );
  const raidCtx = ctx({
    authorityTokenPublicKeys: key.publicKeys,
    rankedServerId: "raid-1",
    isRaidRuntime: true,
  });
  const verified = await verifyJoinIdentity(
    { proto: GAME_PROTO, joinToken: issued.joinToken },
    raidCtx,
  );
  assertEquals(verified.ok, true);
  if (!verified.ok || verified.spectator) return;
  const player = verified as VerifiedPlayerJoin;
  assertEquals(player.raidJoin, {
    team: "B",
    raidId: "clocking-out",
    partySize: 3,
    soloRaid: true,
  });
  assertEquals(player.name, "Raider");
  assertEquals(player.partyId, "party-9");
  assertEquals(player.partySize, 3);
  assertEquals(player.profile.head, 4);
  assertEquals(player.profile.synthetic, true);
  assertEquals(
    sessionDataFromJoin({ ...player, ok: true }).raidJoin,
    player.raidJoin,
  );

  const mismatch = await verifyJoinIdentity(
    { proto: GAME_PROTO, joinToken: issued.joinToken },
    ctx({
      authorityTokenPublicKeys: key.publicKeys,
      rankedServerId: "raid-1",
      isRaidRuntime: false,
    }),
  );
  assertEquals(mismatch, { ok: false, error: JoinErrors.AuthInvalid });

  const pvp = await issueRankedJoinToken(
    {
      sub: "user_1",
      username: "Raider",
      serverId: "raid-1",
      modeId: "easy",
    },
    key.privateKey,
    "current",
  );
  const pvpResult = await verifyJoinIdentity(
    { proto: GAME_PROTO, joinToken: pvp.joinToken },
    raidCtx,
  );
  assertEquals(pvpResult, { ok: false, error: JoinErrors.AuthInvalid });
});

Deno.test("a timed-out or conflicting raid does not activate", async () => {
  const key = await keys();
  const issued = await issueRankedJoinToken(
    {
      sub: "user_1",
      username: "Raider",
      serverId: "raid-1",
      matchKind: "raid",
      modeId: "raid",
      team: "A",
      raidId: "clocking-out",
      partyId: "party-9",
    },
    key.privateKey,
    "current",
  );
  const timedOut = await verifyJoinIdentity(
    { proto: GAME_PROTO, joinToken: issued.joinToken },
    ctx({
      authorityTokenPublicKeys: key.publicKeys,
      rankedServerId: "raid-1",
      isRaidRuntime: true,
      raidPartyTimedOut: () => true,
    }),
  );
  assertEquals(timedOut, { ok: false, error: JoinErrors.AssignmentInvalid });

  const conflict = await verifyJoinIdentity(
    { proto: GAME_PROTO, joinToken: issued.joinToken },
    ctx({
      authorityTokenPublicKeys: key.publicKeys,
      rankedServerId: "raid-1",
      isRaidRuntime: true,
      raidJoinConflict: () => true,
    }),
  );
  assertEquals(conflict, { ok: false, error: JoinErrors.AuthInvalid });
});

Deno.test("ranked identity ignores assignment claims; open identity keeps them", async () => {
  const key = await keys();
  const issued = await issueRankedJoinToken(
    {
      sub: "user_1",
      username: "Ada",
      serverId: "easy",
      assignmentId: "asg_1",
      partyId: "party-1",
      partySize: 2,
    },
    key.privateKey,
    "current",
  );
  const ranked = await verifyJoinIdentity(
    { proto: GAME_PROTO, joinToken: issued.joinToken },
    ctx({
      joinMode: "ranked",
      rankedServerId: "easy",
      authorityTokenPublicKeys: key.publicKeys,
    }),
  );
  assertEquals(ranked.ok, true);
  if (!ranked.ok || ranked.spectator) return;
  assertEquals(ranked.assignmentId, undefined);
  assertEquals(ranked.admissionJti, undefined);
  assertEquals(ranked.partyId, "party-1");
  assertEquals(ranked.partySize, 2);

  const open = await verifyJoinIdentity(
    { proto: GAME_PROTO, joinToken: issued.joinToken },
    ctx({
      joinMode: "open",
      openOfficial: true,
      rankedServerId: "easy",
      authorityTokenPublicKeys: key.publicKeys,
    }),
  );
  if (!open.ok || open.spectator) {
    throw new Error("expected an open player identity");
  }
  assertEquals(open.assignmentId, "asg_1");
  assertEquals(typeof open.admissionJti, "string");
  assertEquals(open.profile.ownedAbilities, []);
});
