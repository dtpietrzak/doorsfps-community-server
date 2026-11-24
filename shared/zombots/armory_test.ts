import { assertEquals } from "@std/assert";
import {
  WEAPON_ORDER,
  WEAPON_PISTOL,
  WEAPON_RIFLE,
  WEAPON_SHOTGUN,
} from "../sim/weapons.ts";
import { Armory, ZOMBOTS_RACK_WEAPON_ID, type ZombotsGunRack } from "./armory.ts";
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
  assertEquals(REACH, 2.2);
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
