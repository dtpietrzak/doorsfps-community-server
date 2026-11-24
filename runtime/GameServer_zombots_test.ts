/**
 * Zombots GameServer smoke (notes/zombots.md step 11): a zombots runtime on
 * Zombots-01 seats a human on the pad, arms nothing, and wave 1 sends
 * zombie bots in. The full scenarios are step 16.
 */
import { assert, assertEquals } from "@std/assert";
import { NoopAuthorityAdapter } from "../authority/adapter.ts";
import { ZOMBOTS_TUNING } from "../shared/zombots/zombotsTuning.ts";
import { loadMapFile } from "../world/loadMap.ts";
import { MapCollision } from "../world/MapCollision.ts";
import { TICK_HZ } from "./GameLoop.ts";
import { GameServer } from "./GameServer.ts";
import { serverInternals } from "./gameServerTestHarness.ts";

const ZOMBOTS_01 = new URL("../maps/zombots/Zombots-01.doors.json", import.meta.url);

Deno.test("zombots GameServer: wave 1 spawns zombie bots on Zombots-01", async () => {
  const map = await loadMapFile(ZOMBOTS_01.pathname);
  const server = new GameServer({
    name: "zombots-smoke",
    port: 0,
    host: "127.0.0.1",
    map,
    collision: new MapCollision(map),
    autofillBots: 4,
    joinMode: "open",
    rankedServerId: "zombots",
    modeId: "zombots",
    authorityAdapter: new NoopAuthorityAdapter(),
  });
  const internals = serverInternals(server);
  // No arena fill in zombots, even with autofill configured.
  assertEquals(internals.bots.count, 0);
  const human = internals.players.add("p1", "Alpha", "A", undefined, 0);
  internals.zombotsRuntime.markLoaded("p1");
  assertEquals(human.armedMask(), 0);

  const waveTicks = Math.ceil(ZOMBOTS_TUNING.timing.firstIntermissionMs / (1000 / TICK_HZ)) + 5;
  let tick = internals.players.tick;
  for (let i = 0; i < waveTicks; i++) {
    tick += 1;
    internals.stepSim(tick, tick * 1000 / TICK_HZ);
    internals.players.drainAuthoritativeEvents();
  }
  const hud = internals.zombotsRuntime.hud()!;
  assertEquals(hud.phase, "wave");
  assertEquals(hud.wave, 1);
  const zombies = [...internals.players.all()].filter((p) => p.isBot);
  assert(zombies.length >= 1, "wave 1 spawned no zombies");
  for (const z of zombies) {
    assertEquals(z.team, "B");
    assertEquals(z.climbsWindows, true);
    assertEquals(z.armedMask(), 0);
    assertEquals(z.meleeDamageOverride, ZOMBOTS_TUNING.zombie.baseMeleeDamage);
  }
  assertEquals(internals.players.isMatchOver(), false);

  // The zombie brain thinks and moves them, through the normal bot loop.
  const z = zombies[0];
  const start = { x: z.x, z: z.z };
  for (let i = 0; i < TICK_HZ * 2; i++) {
    tick += 1;
    internals.stepSim(tick, tick * 1000 / TICK_HZ);
    internals.players.drainAuthoritativeEvents();
    internals.bots.thinkAll(tick, internals.players.getCollision());
  }
  assert(Math.hypot(z.x - start.x, z.z - start.z) > 0.5, "zombie never moved");
});
