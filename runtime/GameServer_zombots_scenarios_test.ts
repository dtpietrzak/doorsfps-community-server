/**
 * Zombots scenarios on Zombots-01 (notes/zombots.md step 16), through a real
 * GameServer: humans seat through the session handlers and act with real
 * packets (MapLoaded, Input, Shoot, Interact). Zombie AI is not run (the
 * bot think loop is not driven), so zombies stand where they spawn and the
 * test moves them. Positions come from the map layout, not hard-coded
 * coordinates; numbers come from ZOMBOTS_TUNING.
 */
import { assert, assertEquals, assertExists, assertNotEquals } from "@std/assert";
import { NoopAuthorityAdapter } from "../authority/adapter.ts";
import type { Player } from "../players/Player.ts";
import { PLAYER_HEIGHT } from "../players/Player.ts";
import {
  type GameOverPacket,
  NetEvents,
  SPAWN_INVULN_TICKS,
  WEAPON_PISTOL,
} from "../protocol/network.ts";
import { spareClipsForWeapon } from "../shared/sim/weapons.ts";
import { ZOMBOTS_RACK_WEAPON_ID } from "../shared/zombots/armory.ts";
import type { ZombotsHudPacket } from "../shared/zombots/zombotsHud.ts";
import { ZombotsDoorState, zombotsRoomGraph } from "../shared/zombots/zombotsDoors.ts";
import { zombotsLayout } from "../shared/zombots/zombotsLayout.ts";
import { ZOMBOTS_TUNING } from "../shared/zombots/zombotsTuning.ts";
import { wallMountOffset } from "../shared/world/slidingDoors.ts";
import type { ClientSession, SessionHub } from "../transport/types.ts";
import { loadMapFile } from "../world/loadMap.ts";
import type { DoorsMap } from "../world/map.ts";
import { MapCollision } from "../world/MapCollision.ts";
import { TICK_HZ } from "./GameLoop.ts";
import { GameServer } from "./GameServer.ts";
import { botThinkFrame, driveTick, serverInternals } from "./gameServerTestHarness.ts";
import { zombotsPadMap } from "./zombotsRuntime.ts";

const ZOMBOTS_01 = new URL("../maps/zombots/Zombots-01.doors.json", import.meta.url);
const TICK_MS = 1000 / TICK_HZ;
const T = ZOMBOTS_TUNING;

type Sent = { event: string; payload: unknown };
type Vec2 = { x: number; z: number };

// ── geometry from the map ───────────────────────────────────────────────────

/** Yaw whose forward vector (-sin, -cos) points along `dir`. */
function yawToward(dir: Vec2): number {
  return Math.atan2(-dir.x, -dir.z);
}

function unit(v: Vec2): Vec2 {
  const len = Math.hypot(v.x, v.z);
  return { x: v.x / len, z: v.z / len };
}

/** Everything the scenarios read off the map, once. */
function mapFacts(rawMap: DoorsMap) {
  const map = zombotsPadMap(rawMap);
  const layout = zombotsLayout(map);
  assertEquals(layout.errors, []);
  const phases = layout.phases!;
  const doors = new ZombotsDoorState(map).all();
  const doorRooms = zombotsRoomGraph(map).doorRooms;
  const rackOf = (weapon: string) => {
    const placed = layout.rackPhase.find((r) => r.weapon === weapon)!;
    const rack = map.gunRacks!.find((r) => r.id === placed.rackId)!;
    return { center: rack.center, facing: placed.facing!, id: rack.id, weapon };
  };
  /** The door joining phase `from` and `from + 1`, with the walk across it. */
  const doorBetween = (from: 1 | 2) => {
    const rooms = [phases[from - 1], phases[from]];
    const entry = doorRooms.find((d) =>
      d.rooms && rooms.includes(d.rooms[0]) && rooms.includes(d.rooms[1])
    )!;
    const door = doors.find((d) => d.id === entry.doorId)!;
    const wall = map.walls.find((w) => w.id === door.wallId)!;
    const along = unit({ x: wall.b.x - wall.a.x, z: wall.b.z - wall.a.z });
    const normal = { x: -along.z, z: along.x };
    const at = (side: number): Vec2 => ({
      x: door.reachPoint.x + normal.x * side,
      z: door.reachPoint.z + normal.z * side,
    });
    // Pick the sign that lands in the lower phase's room.
    const lowSign = layout.roomOf(at(1.2)) === rooms[0] ? 1 : -1;
    assertEquals(layout.roomOf(at(lowSign * 1.2)), rooms[0]);
    assertEquals(layout.roomOf(at(-lowSign * 1.2)), rooms[1]);
    return { door, low: at(lowSign * 1.2), high: at(-lowSign * 1.2) };
  };
  return { map, layout, phases, doors, rackOf, doorBetween };
}

// ── rig ─────────────────────────────────────────────────────────────────────

function fakeSession(id: string, name: string) {
  const sent: Sent[] = [];
  const ons = new Map<string, (payload?: unknown) => void>();
  const session = {
    id,
    kind: "websocket",
    auth: {},
    data: { playerName: name },
    emit: (event: string, payload?: unknown) => {
      sent.push({ event, payload });
    },
    emitVolatile: () => "sent" as const,
    on: (event: string, handler: (payload?: unknown) => void) => {
      ons.set(event, handler);
    },
    disconnect: () => {},
    isWritable: () => true,
    writeBufferLength: () => 0,
  } as unknown as ClientSession;
  return { session, sent, ons };
}

/**
 * Zombots-01 has no power rack yet: hang one on the pistol rack's wall, beside
 * it, on whichever side the board still fits.
 */
function addPowerRackBesidePistol(map: DoorsMap): void {
  const pistol = map.gunRacks!.find((r) => r.weapon === "pistol")!;
  const wall = map.walls.find((w) => w.id === pistol.wallId)!;
  const len = Math.hypot(wall.b.x - wall.a.x, wall.b.z - wall.a.z);
  const ux = (wall.b.x - wall.a.x) / len;
  const uz = (wall.b.z - wall.a.z) / len;
  for (const step of [1.3, -1.3]) {
    const center = { x: pistol.center.x + ux * step, z: pistol.center.z + uz * step };
    const mount = wallMountOffset(wall.a, wall.b, center);
    if (!mount || mount.s - 0.6 < 0 || mount.s + 0.6 > mount.len) continue;
    map.gunRacks!.push({
      id: "power-test",
      wallId: wall.id,
      center,
      weapon: "power",
      ...(pistol.face !== undefined ? { face: pistol.face } : {}),
    });
    return;
  }
  throw new Error("no room for a power rack beside the pistol rack");
}

async function makeRig(opts: { powerRack?: boolean } = {}) {
  const map = await loadMapFile(ZOMBOTS_01.pathname);
  if (opts.powerRack) addPowerRackBesidePistol(map);
  const server = new GameServer({
    name: "zombots-scenarios",
    port: 0,
    host: "127.0.0.1",
    map,
    collision: new MapCollision(map),
    autofillBots: 0,
    joinMode: "open",
    rankedServerId: "zombots",
    modeId: "zombots",
    authorityAdapter: new NoopAuthorityAdapter(),
  });
  const internals = serverInternals(server);

  // The hub start() builds, minus the socket: it records broadcasts and hands
  // connections to the real session handlers.
  const broadcast: Sent[] = [];
  const members: ClientSession[] = [];
  let connect: ((session: ClientSession) => void) | null = null;
  const hub = {
    size: 0,
    authenticate: () => {},
    onConnect: (fn: (session: ClientSession) => void) => {
      connect = fn;
    },
    emit: (event: string, payload?: unknown) => {
      broadcast.push({ event, payload });
    },
    get: (id: string) => members.find((m) => m.id === id),
    sessions: () => members,
    close: () => Promise.resolve(),
  } as unknown as SessionHub;
  internals.sessions = hub as unknown as typeof internals.sessions;
  internals.registerEvents();

  let tick = internals.players.tick;
  // Session handlers read the loop's tick; the loop itself is never started.
  internals.loop = {
    get tickCount() {
      return tick;
    },
  };
  const clients = new Map<string, ReturnType<typeof fakeSession>>();

  const rig = {
    server,
    internals,
    map,
    broadcast,
    get tick() {
      return tick;
    },
    /** Seat a human through the real connect path and send MapLoaded. */
    join(name: string): Player {
      const client = fakeSession(`sock-${name}`, name);
      members.push(client.session);
      connect!(client.session);
      clients.set(name, client);
      const player = internals.players.getBySocket(client.session.id);
      assertExists(player, `${name} was not seated`);
      client.ons.get(NetEvents.MapLoaded)!();
      return player;
    },
    /** A real client packet. */
    send(name: string, event: string, payload?: unknown) {
      const handler = clients.get(name)!.ons.get(event);
      assertExists(handler, `no handler for ${event}`);
      handler(payload);
    },
    tickOnce() {
      tick += 1;
      const { result } = driveTick(server, tick, tick * TICK_MS);
      internals.emitSimTickEvents(tick, result.events);
      internals.zombotsRuntime.flush();
      return result;
    },
    ticks(n: number) {
      for (let i = 0; i < n; i++) rig.tickOnce();
    },
    /** Tick until `done()`; fails after `max` ticks. */
    until(done: () => boolean, max: number, what: string) {
      for (let i = 0; i < max; i++) {
        if (done()) return;
        rig.tickOnce();
      }
      if (!done()) throw new Error(`gave up waiting for ${what}`);
    },
    hud(): ZombotsHudPacket {
      return internals.zombotsRuntime.hud()!;
    },
    points(id: string): number {
      return rig.hud().players.find((p) => p.id === id)!.points;
    },
    zombies(): Player[] {
      return [...internals.players.all()].filter((p) => p.isBot);
    },
    /** Teleport a human, past spawn protection, looking along `yaw`. */
    stand(player: Player, at: Vec2, yaw: number) {
      player.x = at.x;
      player.y = PLAYER_HEIGHT;
      player.z = at.z;
      player.yaw = yaw;
      player.pitch = 0;
      player.spawnedAtTick = tick - SPAWN_INVULN_TICKS - 1;
      player.recordPose(tick);
    },
    /** Packets sent to one client. */
    sent(name: string): { event: string; payload: unknown }[] {
      return clients.get(name)!.sent;
    },
    gameOvers(): GameOverPacket[] {
      return broadcast.filter((b) => b.event === NetEvents.GameOver)
        .map((b) => b.payload as GameOverPacket);
    },
  };
  return rig;
}

type Rig = Awaited<ReturnType<typeof makeRig>>;

const FIRST_WAVE_TICKS = Math.ceil(T.timing.firstIntermissionMs / TICK_MS) + 5;

/** Join, then run to the first tick of wave 1. */
function startWave1(rig: Rig, ...names: string[]): Player[] {
  const players = names.map((n) => rig.join(n));
  rig.until(() => rig.hud().phase === "wave", FIRST_WAVE_TICKS + 60, "wave 1");
  return players;
}

/** Stand at the rack, looking at it, and press Interact. */
function takeFromRack(
  rig: Rig,
  player: Player,
  rack: ReturnType<ReturnType<typeof mapFacts>["rackOf"]>,
  /** Top the purse up to a gun rack's price first (power racks are funded by their test). */
  fund = rack.weapon !== "power",
) {
  if (fund) {
    const ledger = (rig.internals.zombotsRuntime as unknown as {
      run: { ledger: { get(id: string): number; award(id: string, reason: string): unknown } };
    }).run.ledger;
    while (ledger.get(player.id) < T.racks.gunCost) ledger.award(player.id, "kill");
  }
  rig.stand(player, {
    x: rack.center.x + rack.facing.x * 1.0,
    z: rack.center.z + rack.facing.z * 1.0,
  }, yawToward({ x: -rack.facing.x, z: -rack.facing.z }));
  rig.send(player.name, NetEvents.Interact, { yaw: player.yaw, pitch: 0 });
  rig.tickOnce();
}

// ── 1. waves ────────────────────────────────────────────────────────────────

Deno.test("zombots scenario: wave 1 spawns, clearing it starts wave 2 after the intermission", async () => {
  const rig = await makeRig();
  const facts = mapFacts(rig.map);
  const [p1] = startWave1(rig, "Alpha");
  assertEquals(rig.hud().wave, 1);
  // Let the wave finish spawning: the HUD counts every zombie still to kill.
  rig.until(
    () => rig.hud().zombiesLeft === rig.zombies().length,
    600,
    "all of wave 1 to be on the field",
  );
  const total = rig.zombies().length;
  assertEquals(total, T.waves.baseCount);
  assertEquals(rig.hud().zombiesLeft, total);

  // Arm at the pistol rack, then shoot each zombie from the rack's room. The
  // zombies are placed in front of the barrel; the kill itself is a real
  // Shoot packet resolved by the Weapons phase.
  const rack = facts.rackOf("pistol");
  takeFromRack(rig, p1, rack);
  assert(p1.isWeaponArmed(WEAPON_PISTOL));
  const muzzleYaw = yawToward({ x: rack.facing.x, z: rack.facing.z });
  const pointsBefore = rig.points("sock-Alpha");
  let guard = 0;
  while (rig.zombies().length > 0 && guard++ < 2000) {
    const z = rig.zombies()[0];
    rig.stand(p1, {
      x: rack.center.x + rack.facing.x * 1.0,
      z: rack.center.z + rack.facing.z * 1.0,
    }, muzzleYaw);
    z.x = p1.x + rack.facing.x * 3;
    z.z = p1.z + rack.facing.z * 3;
    z.y = PLAYER_HEIGHT;
    z.recordPose(rig.tick);
    if (p1.ammoInMag === 0) {
      rig.send("Alpha", NetEvents.Reload);
    } else {
      rig.send("Alpha", NetEvents.Shoot, { yaw: muzzleYaw, pitch: 0, sequence: guard });
    }
    rig.ticks(4);
  }
  assertEquals(rig.zombies().length, 0, "zombies left after the shooting");
  assertEquals(rig.hud().zombiesLeft, 0);
  assertEquals(rig.hud().phase, "intermission");
  // Hits and kills paid the shooter, plus the wave-survived bonus.
  assert(rig.points("sock-Alpha") >= pointsBefore + total * T.points.kill);

  // Wave 2 starts once the intermission runs out, and is bigger.
  rig.until(() => rig.hud().wave === 2, Math.ceil(T.timing.intermissionMs / TICK_MS) + 120, "wave 2");
  assertEquals(rig.hud().phase, "wave");
  rig.until(() => rig.zombies().length > 0, 120, "a wave 2 zombie");
  assert(rig.hud().zombiesLeft > total);
});

// ── 2. wipe ─────────────────────────────────────────────────────────────────

Deno.test("zombots scenario: all humans down ends the run, nobody respawns, the sit returns everyone to the menu", async () => {
  const rig = await makeRig();
  const facts = mapFacts(rig.map);
  const [a, b] = startWave1(rig, "Alpha", "Bravo");
  assertEquals(rig.hud().wave, 1);

  // Dirty the run: Alpha takes the pistol and buys the first door.
  takeFromRack(rig, a, facts.rackOf("pistol"));
  assert(a.isWeaponArmed(WEAPON_PISTOL));
  const gate = facts.doorBetween(1);
  const ledger = (rig.internals.zombotsRuntime as unknown as {
    run: { ledger: { get(id: string): number; award(id: string, reason: string): unknown } };
  }).run.ledger;
  while (ledger.get("sock-Alpha") < gate.door.cost) ledger.award("sock-Alpha", "kill");
  rig.stand(a, gate.low, yawToward(sub(gate.door.reachPoint, gate.low)));
  rig.send("Alpha", NetEvents.Interact, { yaw: a.yaw, pitch: 0 });
  rig.tickOnce();
  const collision = rig.internals.players.getCollision();
  assertEquals(collision.isSlidingDoorOpen(gate.door.id), true);
  const waveReached = rig.hud().wave;

  // One down is not a wipe.
  a.takeDamage(10_000, "body", rig.tick, rig.tick * TICK_MS);
  assertEquals(a.downed, true);
  rig.ticks(3);
  assertEquals(rig.gameOvers().length, 0);
  assertEquals(rig.internals.players.isMatchOver(), false);

  b.takeDamage(10_000, "body", rig.tick, rig.tick * TICK_MS);
  rig.ticks(2);
  const over = rig.gameOvers()[0];
  assertExists(over, "no GameOver after every human went down");
  assertEquals(over.matchKind, "zombots");
  assertEquals(over.zombots?.wave, waveReached);
  assertEquals(over.zombots?.phase, "over");
  assertEquals(rig.zombies().length, 0);

  // No respawns while the run is over, however long we wait.
  rig.ticks(Math.ceil(TICK_HZ * 8));
  for (const p of [a, b]) {
    assertEquals(p.alive, false);
    assertEquals(p.downed, true);
  }

  // The run-over screen returns to the menu, like a raid.
  assertEquals(over.returnToMenu, true);

  // The sit ends: both are kicked to the menu and no new run starts.
  const mapChanges = rig.broadcast.filter((b) => b.event === NetEvents.MapChange).length;
  rig.until(() => rig.internals.players.humanCount() === 0, TICK_HZ * 60, "the return to menu");
  for (const name of ["Alpha", "Bravo"]) {
    const kicked = rig.sent(name).find((m) => m.event === NetEvents.Kicked);
    assertExists(kicked, `${name} was not sent to the menu`);
    assertEquals((kicked.payload as { reason?: string }).reason, "return_to_menu");
  }
  rig.ticks(2);
  assertEquals(
    rig.broadcast.filter((b) => b.event === NetEvents.MapChange).length,
    mapChanges,
    "a new run started in place",
  );

  // The slot idles clean for the next party: doors shut, no zombies.
  const fresh = rig.internals.players.getCollision();
  assertNotEquals(fresh, collision);
  assertEquals(fresh.isSlidingDoorOpen(gate.door.id), false);
  assertEquals(rig.hud().phase, "waiting");
  assertEquals(rig.hud().openDoorIds, []);
  assertEquals(botThinkFrame(rig.server, rig.tick).openSlidingDoorIds, []);
  assertEquals(rig.zombies().length, 0);

  // The next party plays a new run under its own match identity.
  const idBefore = rig.internals.runtimeMatchId;
  const c = rig.join("Charlie");
  rig.ticks(2);
  assertNotEquals(rig.internals.runtimeMatchId, idBefore);
  assertEquals(c.alive, true);
  assertEquals(c.armedMask(), 0);
  assertEquals(rig.points("sock-Charlie"), T.points.start);
});

function sub(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, z: a.z - b.z };
}

// ── 3. door buy ─────────────────────────────────────────────────────────────

Deno.test("zombots scenario: a door buy debits the purse and opens the door for everyone", async () => {
  const rig = await makeRig();
  const facts = mapFacts(rig.map);
  const [buyer, walker] = startWave1(rig, "Alpha", "Bravo");
  const gate = facts.doorBetween(1);
  const toDoor = (from: Vec2) => yawToward(sub(gate.door.reachPoint, from));
  const collision = rig.internals.players.getCollision();
  assertEquals(collision.isSlidingDoorOpen(gate.door.id), false);
  assertEquals(botThinkFrame(rig.server, rig.tick).openSlidingDoorIds, []);

  // The walker holds forward at the shut door and stays on the low side.
  const walk = () => {
    rig.stand(walker, gate.low, toDoor(gate.low));
    rig.send("Bravo", NetEvents.Input, {
      sequence: 1,
      forward: true,
      backward: false,
      left: false,
      right: false,
      jump: false,
      sprint: false,
      crouch: false,
      yaw: walker.yaw,
      pitch: 0,
    });
    rig.ticks(TICK_HZ);
  };
  walk();
  assertEquals(facts.layout.phaseOf({ x: walker.x, z: walker.z }), 1, "walked through a shut door");

  // The buyer earns enough for the door, pays, and the purse drops by exactly the door cost.
  assertEquals(gate.door.cost, 500);
  const ledger = (rig.internals.zombotsRuntime as unknown as {
    run: { ledger: { get(id: string): number; award(id: string, reason: string): unknown } };
  }).run.ledger;
  while (ledger.get("sock-Alpha") < gate.door.cost) ledger.award("sock-Alpha", "kill");
  const beforeAlpha = rig.points("sock-Alpha");
  const beforeBravo = rig.points("sock-Bravo");
  rig.stand(buyer, gate.low, toDoor(gate.low));
  rig.send("Alpha", NetEvents.Interact, { yaw: buyer.yaw, pitch: 0 });
  rig.tickOnce();
  assertEquals(beforeAlpha - rig.points("sock-Alpha"), gate.door.cost);
  assertEquals(rig.points("sock-Bravo"), beforeBravo, "the other purse must not move");
  assertEquals(collision.isSlidingDoorOpen(gate.door.id), true);
  assertEquals(rig.hud().openDoorIds, [gate.door.id]);
  assertEquals(botThinkFrame(rig.server, rig.tick).openSlidingDoorIds, [gate.door.id]);
  // The HUD block that went out carries the open door.
  const huds = rig.broadcast.filter((b) => b.event === NetEvents.ZombotsState)
    .map((b) => b.payload as ZombotsHudPacket);
  assert(huds.some((h) => h.events?.some((e) => e.kind === "doorOpened" && e.doorId === gate.door.id)));

  // Another player now walks through it.
  walk();
  assertEquals(facts.layout.phaseOf({ x: walker.x, z: walker.z }), 2, "the open door did not let the walker through");
  assertEquals(rig.points("sock-Bravo"), beforeBravo);
});

Deno.test("zombots scenario: a broke player's door buy is refused", async () => {
  const rig = await makeRig();
  const facts = mapFacts(rig.map);
  const [buyer] = startWave1(rig, "Alpha");
  const first = facts.doorBetween(1);
  // The start purse does not cover the first door.
  assert(rig.points("sock-Alpha") < first.door.cost);

  const purse = rig.points("sock-Alpha");
  rig.stand(buyer, first.low, yawToward(sub(first.door.reachPoint, first.low)));
  rig.send("Alpha", NetEvents.Interact, { yaw: buyer.yaw, pitch: 0 });
  rig.tickOnce();
  const collision = rig.internals.players.getCollision();
  assertEquals(collision.isSlidingDoorOpen(first.door.id), false);
  assertEquals(rig.points("sock-Alpha"), purse);
  assertEquals(rig.hud().openDoorIds, []);
  assertEquals(botThinkFrame(rig.server, rig.tick).openSlidingDoorIds, []);
});

// ── 4. unarmed start and the rack ───────────────────────────────────────────

Deno.test("zombots scenario: unarmed players can't fire until they take from the rack", async () => {
  const rig = await makeRig();
  const facts = mapFacts(rig.map);
  const [p1] = startWave1(rig, "Alpha");
  assertEquals(p1.armedMask(), 0);
  const rack = facts.rackOf("pistol");
  const pistol = ZOMBOTS_RACK_WEAPON_ID.pistol;
  assertEquals(pistol, WEAPON_PISTOL);
  const bursts = (result: ReturnType<Rig["tickOnce"]>) =>
    result.events.filter((e) => e.type === "CombatBurst");

  // Standing in the pistol room, away from the rack: the shot is refused.
  const shootAt = {
    x: rack.center.x + rack.facing.x * 3,
    z: rack.center.z + rack.facing.z * 3,
  };
  const fireYaw = yawToward(rack.facing);
  rig.stand(p1, shootAt, fireYaw);
  const mag = p1.ammoInMagFor(WEAPON_PISTOL);
  rig.send("Alpha", NetEvents.Shoot, { yaw: fireYaw, pitch: 0, sequence: 1 });
  assertEquals(bursts(rig.tickOnce()).length, 0, "an unarmed shot fired");
  assertEquals(p1.ammoInMagFor(WEAPON_PISTOL), mag);

  // Interact at the rack arms the pistol with a full mag.
  takeFromRack(rig, p1, rack);
  assertEquals(p1.isWeaponArmed(WEAPON_PISTOL), true);
  assertEquals(p1.armedMask(), 1 << WEAPON_PISTOL);
  const full = p1.ammoInMag;
  assert(full > 0);

  // Drawing the pistol takes a moment; then the same packet fires.
  rig.ticks(TICK_HZ);
  rig.stand(p1, shootAt, fireYaw);
  rig.send("Alpha", NetEvents.Shoot, { yaw: fireYaw, pitch: 0, sequence: 2 });
  assertEquals(bursts(rig.tickOnce()).length, 1, "the armed shot was refused");
  assertEquals(p1.ammoInMag, full - 1);

  // Reload once so spare clips drop, then fire another round so the current mag is partial.
  const fullSpares = p1.spareClips;
  rig.send("Alpha", NetEvents.Reload);
  rig.ticks(TICK_HZ * 2);
  assertEquals(p1.spareClips, fullSpares - 1);
  assertEquals(p1.ammoInMag, full);
  rig.stand(p1, shootAt, fireYaw);
  rig.send("Alpha", NetEvents.Shoot, { yaw: fireYaw, pitch: 0, sequence: 3 });
  assertEquals(bursts(rig.tickOnce()).length, 1);
  assertEquals(p1.ammoInMag, full - 1);

  // A second take replenishes spare clips without refilling the current mag and arms nothing new.
  rig.ticks(TICK_HZ);
  assert(p1.ammoInMag < full);
  takeFromRack(rig, p1, rack);
  assertEquals(p1.ammoInMag, full - 1);
  assertEquals(p1.spareClips, fullSpares);
  assertEquals(p1.armedMask(), 1 << WEAPON_PISTOL);
});

Deno.test("zombots scenario: a gun rack use costs 100, and full spare mags are refused for free", async () => {
  const rig = await makeRig();
  const facts = mapFacts(rig.map);
  const [p1] = startWave1(rig, "Alpha");
  const rack = facts.rackOf("pistol");
  const ledger = (rig.internals.zombotsRuntime as unknown as {
    run: {
      ledger: {
        get(id: string): number;
        award(id: string, reason: string): unknown;
        trySpend(id: string, cost: number, reason: string): unknown;
      };
    };
  }).run.ledger;
  const fullSpares = spareClipsForWeapon(WEAPON_PISTOL);

  // Short of 100: nothing happens.
  ledger.trySpend(p1.id, ledger.get(p1.id), "door");
  assertEquals(ledger.get(p1.id), 0);
  takeFromRack(rig, p1, rack, false);
  assertEquals(p1.armedMask(), 0);

  // First take pays 100.
  while (ledger.get(p1.id) < 250) ledger.award(p1.id, "kill");
  const before = ledger.get(p1.id);
  takeFromRack(rig, p1, rack, false);
  assertEquals(p1.armedMask(), 1 << WEAPON_PISTOL);
  assertEquals(ledger.get(p1.id), before - T.racks.gunCost);

  // Spares are full: refused, nothing charged.
  const afterTake = ledger.get(p1.id);
  rig.ticks(TICK_HZ);
  assertEquals(p1.spareClipsFor(WEAPON_PISTOL), fullSpares);
  takeFromRack(rig, p1, rack, false);
  assertEquals(ledger.get(p1.id), afterTake);

  // Use a spare mag: the next use refills the spares for 100.
  (p1 as unknown as { loadouts: Record<number, { spareClips: number }> })
    .loadouts[WEAPON_PISTOL]!.spareClips = fullSpares - 1;
  assertEquals(p1.spareClipsFor(WEAPON_PISTOL), fullSpares - 1);
  takeFromRack(rig, p1, rack, false);
  assertEquals(ledger.get(p1.id), afterTake - T.racks.gunCost);
  assertEquals(p1.spareClipsFor(WEAPON_PISTOL), fullSpares);
});

// ── 4b. power recharge rack ─────────────────────────────────────────────────

Deno.test("zombots scenario: a power rack restores spent skills for 500 zompoints, and never charges for nothing", async () => {
  const rig = await makeRig({ powerRack: true });
  const facts = mapFacts(rig.map);
  const [p1] = startWave1(rig, "Alpha");
  const rack = facts.rackOf("power");
  const cost = T.racks.powerCost;
  assertEquals(cost, 500);
  const ledger = (rig.internals.zombotsRuntime as unknown as {
    run: { ledger: { get(id: string): number; award(id: string, reason: string): unknown } };
  }).run.ledger;
  const players = rig.internals.players;

  // Spawn locks the kit until a capture, which zombots never has.
  p1.lockAbilityChargesUntilDoor();
  assertEquals(players.canPowerRecharge(p1.id), true);

  // Short of 500: refused, still spent, nothing debited.
  const before = ledger.get(p1.id);
  assert(before < cost);
  takeFromRack(rig, p1, rack);
  assertEquals(ledger.get(p1.id), before);
  assertEquals(players.canPowerRecharge(p1.id), true);

  // With 500 it pays and the charges come back after the regen window.
  while (ledger.get(p1.id) < cost) ledger.award(p1.id, "kill");
  const rich = ledger.get(p1.id);
  takeFromRack(rig, p1, rack);
  assertEquals(ledger.get(p1.id), rich - cost);
  assertEquals(rig.points(p1.id), rich - cost);
  rig.ticks(TICK_HZ * 2);
  assertEquals(Object.keys(p1.abilitySpent).length, 0, "skills were not restored");
  assertEquals(players.canPowerRecharge(p1.id), false);

  // Nothing spent now: a press costs nothing.
  const after = ledger.get(p1.id);
  while (ledger.get(p1.id) < cost) ledger.award(p1.id, "kill");
  const stocked = ledger.get(p1.id);
  assert(stocked >= after);
  takeFromRack(rig, p1, rack);
  assertEquals(ledger.get(p1.id), stocked);
});

// ── 5. revive ───────────────────────────────────────────────────────────────

Deno.test("zombots scenario: a downed player is revived by paid presses; looking away resets", async () => {
  const rig = await makeRig();
  const facts = mapFacts(rig.map);
  const [helper, down] = startWave1(rig, "Alpha", "Bravo");
  const presses = T.revive.presses;
  const cost = T.revive.costPerPress;
  // Both stand in the pistol room, one step apart.
  const rack = facts.rackOf("pistol");
  const bodyAt = {
    x: rack.center.x + rack.facing.x * 3,
    z: rack.center.z + rack.facing.z * 3,
  };
  const helperAt = {
    x: bodyAt.x + rack.facing.x * 1.2,
    z: bodyAt.z + rack.facing.z * 1.2,
  };
  const towardBody = yawToward({ x: -rack.facing.x, z: -rack.facing.z });
  const awayFromBody = yawToward(rack.facing);
  const stage = (yaw: number) => {
    rig.stand(down, bodyAt, 0);
    rig.stand(helper, helperAt, yaw);
  };
  stage(towardBody);

  // You can't revive a standing player: the press resolves to nothing.
  const purse = rig.points("sock-Alpha");
  rig.send("Alpha", NetEvents.Interact, { yaw: towardBody, pitch: 0 });
  rig.tickOnce();
  assertEquals(rig.points("sock-Alpha"), purse);
  assertEquals(rig.hud().revives, []);
  assertEquals(down.downed, false);

  down.takeDamage(10_000, "body", rig.tick, rig.tick * TICK_MS);
  assertEquals(down.downed, true);
  stage(towardBody);
  rig.tickOnce();
  assertEquals(rig.hud().players.find((p) => p.id === "sock-Bravo")?.downed, true);

  const press = () => {
    stage(towardBody);
    rig.send("Alpha", NetEvents.Interact, { yaw: towardBody, pitch: 0 });
    rig.tickOnce();
  };

  // 500 points cover ten presses (cost 50 each); the eleventh is refused.
  const affordable = Math.floor(T.points.start / cost);
  assert(affordable < presses, "tuning changed: the purse now covers a full revive");
  for (let i = 0; i < affordable; i++) press();
  assertEquals(rig.hud().revives[0]?.presses, affordable);
  assertEquals(rig.points("sock-Alpha"), purse - affordable * cost);
  press();
  assertEquals(rig.hud().revives[0]?.presses, affordable, "a broke press counted");
  assertEquals(rig.points("sock-Alpha"), purse - affordable * cost);
  assertEquals(down.downed, true);

  // Looking away resets the count to 0 and refunds nothing.
  stage(awayFromBody);
  rig.tickOnce();
  assertEquals(rig.hud().revives, []);
  assertEquals(rig.points("sock-Alpha"), purse - affordable * cost);

  // Top the purse up and press the full count on a fresh run of presses.
  const ledger = (rig.internals.zombotsRuntime as unknown as {
    run: { ledger: { award(id: string, reason: string): unknown } };
  }).run.ledger;
  for (let i = 0; i < (presses * cost) / T.points.kill; i++) ledger.award("sock-Alpha", "kill");
  const before = rig.points("sock-Alpha");
  for (let i = 0; i < presses - 1; i++) press();
  assertEquals(rig.hud().revives[0]?.presses, presses - 1);
  assertEquals(down.downed, true);
  press();
  assertEquals(down.downed, false);
  assertEquals(down.alive, true);
  assertEquals(down.health, Math.round(down.maxHealth * T.revive.healthFraction));
  assertEquals(before - rig.points("sock-Alpha"), presses * cost);
  assertEquals(rig.hud().revives, []);
  assertEquals(rig.hud().players.find((p) => p.id === "sock-Bravo")?.downed, false);
});
