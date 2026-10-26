/**
 * PR3 Bullets — for 3s, shooting does not consume magazine ammo.
 * Run: deno test -A server/players/ability_bullets_test.ts
 */
import { assertEquals } from "jsr:@std/assert@1";
import { abilityDurationTicks } from "../shared/sim/abilities.ts";
import { getWeapon, WEAPON_PISTOL } from "../protocol/network.ts";
import { Player } from "./Player.ts";

const durationTicks = abilityDurationTicks("bullets");
const pistol = getWeapon(WEAPON_PISTOL);
const cd = pistol.fireCooldownTicks;

function makePlayer(): Player {
  const p = new Player("b", "BulletsTester", "A", {
    spawn: { x: 0, z: 0, yaw: Math.PI },
  });
  p.spawnedAtTick = 0;
  p.restoreAbilityCharges();
  return p;
}

/** Drain mag by shooting on cooldown cadence (no free-ammo flags). */
function emptyMag(p: Player, startTick = 0): number {
  let tick = startTick;
  while (p.ammoInMag > 0) {
    assertEquals(p.canShoot(tick), true);
    p.markShot(tick);
    tick += cd;
  }
  return tick;
}

/** Fire once at `tick` if canShoot; advances lastShot via markShot. */
function fireIfPossible(p: Player, tick: number): boolean {
  if (!p.canShoot(tick)) return false;
  p.markShot(tick);
  return true;
}

Deno.test("tryActivateAbility bullets sets end tick and isAbilityActive", () => {
  const p = makePlayer();
  const tick = 10;
  assertEquals(p.tryActivateAbility("bullets", tick), true);
  assertEquals(p.isAbilityActive("bullets", tick), true);
  assertEquals(p.isAbilityActive("bullets", tick + durationTicks - 1), true);
  assertEquals(p.isAbilityActive("bullets", tick + durationTicks), false);
  // Re-activate while active is no-op
  assertEquals(p.tryActivateAbility("bullets", tick + 1), false);
});

Deno.test("Bullets free-fire: many rounds without mag decrease", () => {
  const p = makePlayer();
  const startTick = 0;
  const startMag = p.ammoInMag;
  assertEquals(startMag > 0, true);
  assertEquals(p.tryActivateAbility("bullets", startTick), true);

  let shots = 0;
  // Fire on cooldown cadence for the full window.
  for (let t = startTick; t < startTick + durationTicks; t++) {
    if (fireIfPossible(p, t)) shots++;
  }
  assertEquals(shots > 1, true);
  assertEquals(p.ammoInMag, startMag);
  assertEquals(p.hasFreeAmmo(startTick + durationTicks - 1), true);
});

Deno.test("Bullets allows fire from empty mag while active", () => {
  const p = makePlayer();
  const emptiedAt = emptyMag(p);
  assertEquals(p.ammoInMag, 0);
  // Cooldown elapsed after last empty-mag shot → still blocked (no ammo).
  assertEquals(p.canShoot(emptiedAt), false);

  // Activate after fire cooldown so canShoot only gates on ammo/ability.
  const tick = emptiedAt + cd;
  assertEquals(p.tryActivateAbility("bullets", tick), true);
  assertEquals(p.canShoot(tick), true);
  assertEquals(fireIfPossible(p, tick), true);
  assertEquals(p.ammoInMag, 0);
});

Deno.test("After Bullets expires, ammo consumption resumes", () => {
  const p = makePlayer();
  const startTick = 0;
  assertEquals(p.tryActivateAbility("bullets", startTick), true);

  // Spend the whole window without losing ammo.
  for (let t = startTick; t < startTick + durationTicks; t++) {
    fireIfPossible(p, t);
  }
  const magAtEnd = p.ammoInMag;
  assertEquals(magAtEnd, pistol.magSize);

  // Wait out remaining fire cooldown after the last free shot in-window.
  const after = startTick + durationTicks + cd;
  assertEquals(p.isAbilityActive("bullets", after), false);
  assertEquals(p.hasFreeAmmo(after), false);
  assertEquals(p.canShoot(after), true);
  assertEquals(fireIfPossible(p, after), true);
  assertEquals(p.ammoInMag, magAtEnd - 1);
});

Deno.test("Bullets does not stomp permanent unlimitedAmmo", () => {
  const p = makePlayer();
  p.unlimitedAmmo = true;
  // Cannot empty mag while unlimited — force empty via loadout path would
  // require private setters; assert free-fire without ability instead.
  assertEquals(p.hasFreeAmmo(0), true);
  assertEquals(p.canShoot(0), true);
  const mag = p.ammoInMag;
  p.markShot(0);
  assertEquals(p.ammoInMag, mag);

  // Activate Bullets then expire — unlimitedAmmo still free-fire.
  assertEquals(p.tryActivateAbility("bullets", 10), true);
  const after = 10 + durationTicks + cd;
  assertEquals(p.isAbilityActive("bullets", after), false);
  assertEquals(p.hasFreeAmmo(after), true);
  assertEquals(p.canShoot(after), true);
  p.markShot(after);
  assertEquals(p.ammoInMag, mag);
});

Deno.test("snapshot includes active bullets ability while window open", () => {
  const p = makePlayer();
  const tick = 20;
  p.tryActivateAbility("bullets", tick);
  const snap = p.toSnapshot(tick, "motion");
  assertEquals(Array.isArray(snap.abilities), true);
  assertEquals(snap.abilities!.some((a) => a.id === "bullets"), true);
  const entry = snap.abilities!.find((a) => a.id === "bullets")!;
  assertEquals(entry.endsAtTick, tick + durationTicks);

  const after = p.toSnapshot(tick + durationTicks, "motion");
  const still = after.abilities?.some((a) => a.id === "bullets") ?? false;
  assertEquals(still, false);
});

Deno.test("dead player cannot activate Bullets", () => {
  const p = makePlayer();
  p.alive = false;
  assertEquals(p.tryActivateAbility("bullets", 0), false);
});

Deno.test("fire cooldown still enforced while Bullets active", () => {
  const p = makePlayer();
  const tick = 0;
  assertEquals(p.tryActivateAbility("bullets", tick), true);
  assertEquals(fireIfPossible(p, tick), true);
  // Immediate next tick within cooldown → blocked.
  if (cd > 1) {
    assertEquals(p.canShoot(tick + 1), false);
  }
  // After cooldown → allowed, still no mag cost.
  const ready = tick + cd;
  const mag = p.ammoInMag;
  assertEquals(fireIfPossible(p, ready), true);
  assertEquals(p.ammoInMag, mag);
});
