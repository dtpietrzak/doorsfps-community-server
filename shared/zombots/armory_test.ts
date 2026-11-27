import { assert, assertEquals } from "@std/assert";
import {
  WEAPON_ORDER,
  WEAPON_PISTOL,
  WEAPON_RIFLE,
  WEAPON_SHOTGUN,
} from "../sim/weapons.ts";
import {
  Armory,
  gunRackCost,
  gunRackMags,
  tryBuyFromRack,
  ZOMBOTS_RACK_WEAPON_ID,
  type ZombotsGunRack,
} from "./armory.ts";
import { ZOMBOTS_TUNING } from "./zombotsTuning.ts";

const REACH = ZOMBOTS_TUNING.racks.reach;
const EYE = { x: 0, z: 0 };

function rack(id: string, weapon: ZombotsGunRack["weapon"], center: { x: number; z: number }): ZombotsGunRack {
  return { id, weapon, center };
}

Deno.test("rack kinds map onto the sim weapon ids", () => {
  assertEquals(ZOMBOTS_RACK_WEAPON_ID.pistol, WEAPON_PISTOL);
  assertEquals(ZOMBOTS_RACK_WEAPON_ID.rifle, WEAPON_RIFLE);
  assertEquals(ZOMBOTS_RACK_WEAPON_ID.shotgun, WEAPON_SHOTGUN);
  assertEquals(WEAPON_PISTOL, 0);
  assertEquals(WEAPON_RIFLE, 1);
  assertEquals(WEAPON_SHOTGUN, 2);
});

Deno.test("players start unarmed", () => {
  const armory = new Armory();
  armory.join("a");
  armory.join("a");
  assertEquals(armory.armedWeapons("a"), []);
  assertEquals(armory.isArmed("a", WEAPON_PISTOL), false);
  assertEquals(armory.isArmed("a", WEAPON_RIFLE), false);
  assertEquals(armory.isArmed("a", WEAPON_SHOTGUN), false);
  assertEquals(armory.armedWeapons("missing"), []);
  assertEquals(armory.isArmed("missing", WEAPON_PISTOL), false);
});

Deno.test("exactly racks.reach is in reach and past it is refused", () => {
  assert(REACH > 0);
  const armory = new Armory();
  armory.join("a");
  armory.join("b");
  const pistol = rack("pistol-rack", "pistol", { x: REACH, z: 0 });

  assertEquals(armory.tryTakeFromRack("a", pistol, EYE, false), {
    kind: "ok",
    firstTake: true,
    weaponId: WEAPON_PISTOL,
    intent: {
      kind: "weaponTaken",
      playerId: "a",
      rackId: "pistol-rack",
      weapon: "pistol",
    },
  });
  assertEquals(armory.isArmed("a", WEAPON_PISTOL), true);

  // One step closer on the same axis is inside.
  assertEquals(
    armory.tryTakeFromRack("b", rack("near", "rifle", { x: REACH - 1, z: 0 }), EYE, false).kind,
    "ok",
  );

  const fresh = new Armory();
  fresh.join("a");
  assertEquals(
    fresh.tryTakeFromRack("a", rack("past", "pistol", { x: REACH + 1, z: 0 }), EYE, false),
    { kind: "refused", reason: "outOfReach" },
  );
  assertEquals(fresh.isArmed("a", WEAPON_PISTOL), false);
  // Both axes count: the corner of the reach square is outside the circle.
  assertEquals(
    fresh.tryTakeFromRack("a", rack("corner", "pistol", { x: REACH, z: REACH }), EYE, false),
    { kind: "refused", reason: "outOfReach" },
  );
  assertEquals(
    fresh.tryTakeFromRack("a", pistol, { x: Number.NaN, z: 0 }, false),
    { kind: "refused", reason: "outOfReach" },
  );
  assertEquals(fresh.armedWeapons("a"), []);
});

Deno.test("a second take is an ammo refill and emits nothing", () => {
  const armory = new Armory();
  armory.join("a");
  const pistol = rack("pistol-rack", "pistol", EYE);
  const first = armory.tryTakeFromRack("a", pistol, EYE, false);
  assertEquals(first.kind, "ok");
  if (first.kind === "ok") assertEquals(first.firstTake, true);

  const refill = armory.tryTakeFromRack("a", pistol, EYE, false);
  assertEquals(refill, { kind: "ok", firstTake: false, weaponId: WEAPON_PISTOL });
  // A different pistol rack is the same weapon, so it refills too.
  assertEquals(
    armory.tryTakeFromRack("a", rack("other-pistol", "pistol", EYE), EYE, false),
    { kind: "ok", firstTake: false, weaponId: WEAPON_PISTOL },
  );
  assertEquals(armory.isArmed("a", WEAPON_PISTOL), true);
  assertEquals(armory.armedWeapons("a"), [WEAPON_PISTOL]);
});

Deno.test("armed weapons follow WEAPON_ORDER, not take order", () => {
  const armory = new Armory();
  armory.join("a");
  assertEquals(
    armory.tryTakeFromRack("a", rack("sg", "shotgun", EYE), EYE, false).kind,
    "ok",
  );
  assertEquals(
    armory.tryTakeFromRack("a", rack("rf", "rifle", EYE), EYE, false).kind,
    "ok",
  );
  const pistol = armory.tryTakeFromRack("a", rack("ps", "pistol", EYE), EYE, false);
  assertEquals(pistol.kind, "ok");
  if (pistol.kind === "ok") {
    assertEquals(pistol.firstTake, true);
    assertEquals(pistol.weaponId, WEAPON_PISTOL);
    assertEquals(pistol.intent?.weapon, "pistol");
  }
  assertEquals(armory.armedWeapons("a"), [...WEAPON_ORDER]);
  assertEquals(armory.isArmed("a", WEAPON_SHOTGUN), true);
});

Deno.test("a downed player cannot take", () => {
  const armory = new Armory();
  armory.join("a");
  const pistol = rack("pistol-rack", "pistol", EYE);
  // Downed wins over reach, so a far rack still reports downed.
  assertEquals(
    armory.tryTakeFromRack("a", rack("far", "rifle", { x: REACH + 5, z: 0 }), EYE, true),
    { kind: "refused", reason: "downed" },
  );
  assertEquals(armory.tryTakeFromRack("a", pistol, EYE, true), {
    kind: "refused",
    reason: "downed",
  });
  assertEquals(armory.armedWeapons("a"), []);

  armory.tryTakeFromRack("a", rack("sg", "shotgun", EYE), EYE, false);
  assertEquals(armory.tryTakeFromRack("a", pistol, EYE, true), {
    kind: "refused",
    reason: "downed",
  });
  assertEquals(armory.armedWeapons("a"), [WEAPON_SHOTGUN]);
});

Deno.test("racks stay stocked for each player and leave disarms", () => {
  const armory = new Armory();
  armory.join("a");
  armory.join("b");
  const pistol = rack("pistol-rack", "pistol", EYE);
  armory.tryTakeFromRack("a", pistol, EYE, false);
  const other = armory.tryTakeFromRack("b", pistol, EYE, false);
  assertEquals(other.kind, "ok");
  if (other.kind === "ok") assertEquals(other.firstTake, true);
  assertEquals(armory.isArmed("a", WEAPON_PISTOL), true);
  assertEquals(armory.isArmed("b", WEAPON_PISTOL), true);

  // Not joined: refused even when downed, so the flag cannot enroll them.
  assertEquals(armory.tryTakeFromRack("c", pistol, EYE, true), {
    kind: "refused",
    reason: "absent",
  });

  armory.leave("a");
  assertEquals(armory.isArmed("a", WEAPON_PISTOL), false);
  assertEquals(armory.tryTakeFromRack("a", pistol, EYE, false), {
    kind: "refused",
    reason: "absent",
  });
  armory.join("a");
  assertEquals(armory.armedWeapons("a"), []);
  const again = armory.tryTakeFromRack("a", pistol, EYE, false);
  assertEquals(again.kind, "ok");
  if (again.kind === "ok") assertEquals(again.firstTake, true);
  assertEquals(armory.isArmed("b", WEAPON_PISTOL), true);
});

Deno.test("gun rack cost is 20 per mag for first take and missing spare mags on refill", () => {
  assertEquals(ZOMBOTS_TUNING.racks.gunCostPerMag, 20);
  // First take: 3 mags (loaded + 2 spares) = 60 for pistol, rifle, shotgun.
  for (const weaponId of WEAPON_ORDER) {
    assertEquals(gunRackMags(weaponId, false, 0), 3);
    assertEquals(gunRackCost(weaponId, false, 0), 60);
  }
  // Mag-reloading gun refills (pistol / rifle: 2 spare mags max).
  for (const weaponId of [WEAPON_PISTOL, WEAPON_RIFLE]) {
    assertEquals(gunRackCost(weaponId, true, 2), 0);
    assertEquals(gunRackCost(weaponId, true, 3), 0); // bonus spare clip
    assertEquals(gunRackCost(weaponId, true, 1), 20);
    assertEquals(gunRackCost(weaponId, true, 0), 40);
  }
  // Shell-reloading gun refill (shotgun: 10 spare shells, 5 shells per tube).
  assertEquals(gunRackCost(WEAPON_SHOTGUN, true, 10), 0);
  assertEquals(gunRackCost(WEAPON_SHOTGUN, true, 9), 20);
  assertEquals(gunRackCost(WEAPON_SHOTGUN, true, 5), 20);
  assertEquals(gunRackCost(WEAPON_SHOTGUN, true, 4), 40);
  assertEquals(gunRackCost(WEAPON_SHOTGUN, true, 0), 40);
});

// ── tryBuyFromRack: refusals never charge ───────────────────────────────────

function buy(
  armory: Armory,
  over: Partial<Parameters<typeof tryBuyFromRack>[1]> = {},
) {
  const charged: number[] = [];
  const result = tryBuyFromRack(armory, {
    playerId: "a",
    rack: rack("p", "pistol", { x: 0, z: 0 }),
    eye: EYE,
    isDowned: false,
    spareClips: 0,
    spareClipsFull: false,
    trySpend: (cost) => {
      charged.push(cost);
      return { ok: true };
    },
    ...over,
  });
  return { result, charged };
}

Deno.test("tryBuyFromRack: a first take charges every mag and arms", () => {
  const armory = new Armory();
  armory.join("a");
  const { result, charged } = buy(armory);
  const mags = gunRackMags(WEAPON_PISTOL, false, 0);
  assertEquals(charged, [mags * ZOMBOTS_TUNING.racks.gunCostPerMag]);
  assert(result.kind === "ok" && result.firstTake);
  assertEquals(armory.isArmed("a", WEAPON_PISTOL), true);
});

Deno.test("tryBuyFromRack: absent, downed, out of reach and full charge nothing", () => {
  const armory = new Armory();
  assertEquals(buy(armory).result, { kind: "refused", reason: "absent" });
  armory.join("a");
  for (
    const [over, reason] of [
      [{ isDowned: true }, "downed"],
      [{ eye: { x: 99, z: 0 } }, "outOfReach"],
    ] as const
  ) {
    const { result, charged } = buy(armory, over);
    assertEquals(result, { kind: "refused", reason });
    assertEquals(charged, []);
  }
  buy(armory); // arm the pistol
  const full = buy(armory, { spareClips: 99, spareClipsFull: true });
  assertEquals(full.result, { kind: "refused", reason: "full" });
  assertEquals(full.charged, []);
});

Deno.test("tryBuyFromRack: a broke player is refused and is not armed", () => {
  const armory = new Armory();
  armory.join("a");
  const { result } = buy(armory, { trySpend: () => ({ ok: false }) });
  assertEquals(result, { kind: "refused", reason: "notEnough" });
  assertEquals(armory.isArmed("a", WEAPON_PISTOL), false);
});
