import { assertEquals, assertExists } from "jsr:@std/assert@1";
import { PISTOL } from "../shared/sim/weapons.ts";
import { PlayerManager } from "./PlayerManager.ts";
import { SPAWN_INVULN_TICKS } from "../protocol/network.ts";
import type { DoorsMap } from "../world/map.ts";
import { MapCollision } from "../world/MapCollision.ts";

const miniMap: DoorsMap = {
  name: "bot-damage-test",
  version: 1,
  bounds: { minX: -50, maxX: 50, minZ: -50, maxZ: 50 },
  gridSize: 1,
  walls: [],
  teamA: {
    corners: [0, 1],
    edge: "south",
    doorHalfWidth: 2,
    spawnRadius: 4,
  },
  teamB: {
    corners: [2, 3],
    edge: "north",
    doorHalfWidth: 2,
    spawnRadius: 4,
  },
};

const TICK = SPAWN_INVULN_TICKS + 60;

type Shooter = "human" | "arenaBot" | "raidBot";

function shootHead(
  shooterRole: Shooter,
  raidScaleSample = 0.5,
  raidMatch = false,
): { damage: number; victimHealth: number } {
  // Per-shot draw order: spread (2 samples for pistol still cone) → damage →
  // raid scale (raid bots only). Spread samples are dummies. Any extra draw
  // throws, so arena bots / humans prove they skip the scale sample.
  const samples = shooterRole === "raidBot"
    ? [0.25, 0.75, 0.5, raidScaleSample]
    : [0.25, 0.75, 0.5];
  const players = new PlayerManager(new MapCollision(miniMap), {
    damageRandom: () => {
      const v = samples.shift();
      if (v === undefined) throw new Error("unexpected extra damage draw");
      return v;
    },
  });
  if (raidMatch) players.setRaidDoorPolicy("idle");
  const shooter = shooterRole === "human"
    ? players.add("shooter", "Human", "A")
    : players.addBot("shooter", "Bot", {
      team: "A",
      isRaidBot: shooterRole === "raidBot",
    });
  const victim = players.add("victim", "Victim", "B");

  shooter.x = 0;
  shooter.y = 1.7;
  shooter.z = 5;
  shooter.yaw = 0;
  shooter.pitch = 0;
  shooter.spawnedAtTick = 0;
  for (let t = TICK - 16; t <= TICK; t++) shooter.recordPose(t);

  victim.x = 0;
  victim.y = 1.7;
  victim.z = 0;
  victim.spawnedAtTick = 0;
  victim.health = 100;
  for (let t = TICK - 16; t <= TICK; t++) victim.recordPose(t);

  const outcome = players.handleShoot(shooter.id, TICK, {
    yaw: 0,
    pitch: 0,
    clientTick: TICK,
    origin: [0, 1.7, 5],
  });
  assertExists(outcome?.damages);
  assertEquals(samples.length, 0, "every scripted draw consumed");
  return {
    damage: outcome.damages[0]!.damage,
    victimHealth: victim.health,
  };
}

const full = (damage: number) => ({ damage, victimHealth: 100 - damage });

Deno.test("arena bot deals full damage with no extra draw (same as a human)", () => {
  assertEquals(shootHead("arenaBot"), full(PISTOL.headDamage));
  assertEquals(shootHead("human"), full(PISTOL.headDamage));
});

Deno.test("non-raid bot inside a raid match is not scaled", () => {
  assertEquals(shootHead("arenaBot", 0.5, true), full(PISTOL.headDamage));
});

Deno.test("raid bot damage ranges from a tenth to a fifth of the rolled damage", () => {
  const normalDamage = PISTOL.headDamage;
  assertEquals(shootHead("raidBot", 0), full(Math.round(normalDamage * 0.1)));
  assertEquals(
    shootHead("raidBot", 0.5),
    full(Math.round(normalDamage * 0.15)),
  );
  assertEquals(shootHead("raidBot", 1), full(Math.round(normalDamage * 0.2)));
});
