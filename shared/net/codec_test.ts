import { assert, assertEquals, assertLess } from "jsr:@std/assert@1";
import { socketIoBinaryEventBytes, socketIoJsonEventBytes } from "./bytes.ts";
import { decodeGamePacket, encodeGamePacket } from "./codec.ts";
import { GAME_PROTO, isEmptyGameEvent, isGameEvent } from "./opcodes.ts";

function roundtrip(event: string, payload?: unknown): unknown {
  const buf = encodeGamePacket(event, payload);
  assert(buf, `encode ${event}`);
  const decoded = decodeGamePacket(buf);
  assert(decoded, `decode ${event}`);
  assertEquals(decoded.event, event);
  return decoded.payload;
}

function motionPlayer(id: string, i: number) {
  return {
    id,
    x: 1.234 + i,
    y: 2.1,
    z: -3.456,
    yaw: 1.23,
    pitch: -0.12,
    health: i === 0 ? 200 : 87,
    scale: i === 0 ? 1.15 : undefined,
    alive: true,
    team: i % 2 === 0 ? "A" : "B",
    crouch: false,
    slide: false,
    velocityX: -2.34,
    velocityY: 0.45,
    velocityZ: 8.76,
    weapon: 1,
    ammoInMag: 12,
    spareClips: 3,
    reloading: false,
    switching: false,
    sprintStamina: 2.35,
    keys: 5,
    lastProcessedInputSeq: 440 + i,
    inputHoldTicks: 2,
  };
}

const miniMap = {
  version: 1 as const,
  name: "yard",
  bounds: { minX: -20, maxX: 20, minZ: -20, maxZ: 20 },
  gridSize: 1,
  walls: [
    { id: "w1", a: { x: -4, z: -2 }, b: { x: 4, z: -2 } },
    { id: "w2", a: { x: 0, z: 0 }, b: { x: 0, z: 6 }, kind: "half" as const },
  ],
  teamA: {
    corners: [0, 1] as [0, 1],
    edge: "south" as const,
    doorHalfWidth: 2,
    spawnRadius: 4,
  },
  teamB: {
    corners: [2, 3] as [2, 3],
    edge: "north" as const,
    doorHalfWidth: 2,
    spawnRadius: 4,
  },
  wallCorners: [{ x: -4, z: -2 }, { x: 4, z: -2 }],
  botHints: [{
    id: "nudge-a",
    kind: "nudge" as const,
    team: "A" as const,
    points: [
      { x: -2, z: -8 },
      { x: 0, z: 0 },
      { x: 2, z: 8 },
    ],
  }],
};

Deno.test("empty events are named on Socket.IO (no binary envelope tax)", () => {
  for (const ev of ["reload", "ready", "leave", "requestPoseHeartbeat"]) {
    assertEquals(isEmptyGameEvent(ev), true);
    assertEquals(isGameEvent(ev), true);
    const named = socketIoJsonEventBytes(ev);
    const header = encodeGamePacket(ev)!;
    const asBinary = socketIoBinaryEventBytes(header.byteLength);
    assertLess(named, asBinary);
  }
});

Deno.test("Input binary+envelope is smaller than JSON", () => {
  const input = {
    sequence: 12345,
    forward: true,
    backward: false,
    left: false,
    right: true,
    jump: false,
    sprint: true,
    crouch: false,
    meleeLunge: true,
    yaw: 1.234,
    pitch: -0.12,
  };
  const buf = encodeGamePacket("input", input)!;
  assertLess(buf.byteLength, 16);
  assertLess(
    socketIoBinaryEventBytes(buf.byteLength),
    socketIoJsonEventBytes("input", input),
  );
  const back = roundtrip("input", input) as typeof input;
  assertEquals(back.sequence, 12345);
  assertEquals(back.forward, true);
  assertEquals(back.right, true);
  assertEquals(back.sprint, true);
  assertEquals(back.meleeLunge, true);
  assertEquals(Math.round(back.yaw * 1000), 1234);
  assertEquals(Math.round(back.pitch * 1000), -120);
});

Deno.test("8-player motion snapshot is much smaller than JSON", () => {
  const players = Array.from(
    { length: 8 },
    (_, i) => motionPlayer(`id${i}`, i),
  );
  const snap = {
    tick: 1800,
    doorsOpen: true,
    doorChangeTick: 2100,
    matchEndTick: 36000,
    scores: { A: 3, B: 2 },
    phase: "live",
    transport: { emitSeq: 9, emitAtMs: 1_700_000_000_000, kind: "volatile" },
    players,
    projectiles: [],
  };
  const buf = encodeGamePacket("snapshot", snap)!;
  assertLess(buf.byteLength, 1200);
  assertLess(
    socketIoBinaryEventBytes(buf.byteLength),
    socketIoJsonEventBytes("snapshot", snap) * 0.5,
  );
  const back = roundtrip("snapshot", snap) as typeof snap;
  assertEquals(back.tick, 1800);
  assertEquals(back.doorsOpen, true);
  assertEquals(back.scores, { A: 3, B: 2 });
  assertEquals(back.players.length, 8);
  assertEquals(back.players[0]!.id, "id0");
  assertEquals(back.players[0]!.health, 200);
  assertEquals(back.players[0]!.scale, 1.15);
  assertEquals(back.players[0]!.velocityX, -2.34);
  assertEquals(back.players[0]!.velocityY, 0.45);
  assertEquals(back.players[0]!.velocityZ, 8.76);
  assertEquals(Math.round(back.players[0]!.x * 1000), Math.round(1.234 * 1000));
  assertEquals(back.transport?.kind, "volatile");
});

Deno.test("16-player motion snapshot stays under 3KB on the wire", () => {
  const players = Array.from(
    { length: 16 },
    (_, i) => motionPlayer(`sock${i}abcdefgh`, i),
  );
  const snap = {
    tick: 99,
    doorsOpen: false,
    doorChangeTick: 120,
    matchEndTick: 36000,
    scores: { A: 11, B: 9 },
    players,
    projectiles: [],
  };
  const buf = encodeGamePacket("snapshot", snap)!;
  const wire = socketIoBinaryEventBytes(buf.byteLength);
  const json = socketIoJsonEventBytes("snapshot", snap);
  assertLess(wire, 3000);
  assertLess(wire, json * 0.45);
});

Deno.test("CombatBurst / Shoot / Ping roundtrip and beat JSON", () => {
  const burst = {
    outcomes: [{
      shot: {
        shooterId: "s1",
        origin: [1, 2, 3] as [number, number, number],
        direction: [0, 0, 1] as [number, number, number],
        weapon: 1,
        hitId: "t1",
        hitZone: "head",
        hitPoint: [4, 5, 6] as [number, number, number],
      },
      damages: [{
        targetId: "t1",
        shooterId: "s1",
        damage: 34,
        health: 66,
        zone: "head",
        alive: true,
        critical: true,
        hitSlowStacks: 1,
        hitSlowEndsAtTick: 200,
      }],
      deaths: [{
        victimId: "t1",
        killerId: "s1",
        zone: "head",
        weapon: 1,
        killerName: "Ada",
        victimName: "Bob",
        killerTeam: "A",
        victimTeam: "B",
        victimIsAgent: true,
      }],
      leech: true,
    }],
  };
  const back = roundtrip("combatBurst", burst) as typeof burst;
  assertEquals(back.outcomes[0]!.shot.hitZone, "head");
  assertEquals(back.outcomes[0]!.deaths![0]!.victimName, "Bob");

  // Melee swing outcome roundtrips its marker (miss included).
  const meleeBurst = {
    outcomes: [{
      shot: {
        shooterId: "s1",
        origin: [1, 2, 3] as [number, number, number],
        direction: [0, 0, 1] as [number, number, number],
        weapon: 0,
        hitId: null,
        hitZone: null,
        hitPoint: null,
        melee: true,
      },
    }],
  };
  const mBurstBack = roundtrip("combatBurst", meleeBurst) as typeof meleeBurst;
  assertEquals(mBurstBack.outcomes[0]!.shot.melee, true);
  assertEquals(back.outcomes[0]!.leech, true);
  const buf = encodeGamePacket("combatBurst", burst)!;
  assertLess(
    socketIoBinaryEventBytes(buf.byteLength),
    socketIoJsonEventBytes("combatBurst", burst),
  );

  const shoot = {
    yaw: 0.5,
    pitch: -0.25,
    origin: [1, 1.6, 2] as [number, number, number],
    sequence: 9,
    clientTick: 1700,
    lastAppliedSnapshotTick: 1710,
  };
  const sback = roundtrip("shoot", shoot) as typeof shoot;
  assertEquals(sback.sequence, 9);
  assertEquals(sback.clientTick, 1700);
  assertEquals(sback.lastAppliedSnapshotTick, 1710);

  // Pistol-whip request shares the shoot wire shape on its own opcode.
  const mback = roundtrip("melee", shoot) as typeof shoot;
  assertEquals(mback.sequence, 9);
  assertEquals(mback.clientTick, 1700);
  assertEquals(mback.lastAppliedSnapshotTick, 1710);

  const ping = {
    t: Date.now(),
    srv: { hz: 60, avg: 0.12, peak: 0.4, budgetMs: 16.67 },
    net: {
      vSent: 10,
      vDrop: 1,
      hb: 2,
      peakWb: 3,
      hSent: 40,
      hDrop: 4,
      hPeakWb: 8,
      hDropClients: 1,
      rwClamp: 3,
      rwFwd: 2,
      rwBack: 1,
      hRwClamp: 9,
    },
  };
  const pback = roundtrip("ping", ping) as typeof ping;
  assertEquals(pback.t, ping.t);
  assertEquals(pback.srv?.hz, 60);
  assertEquals(pback.net?.vDrop, 1);
  assertEquals(pback.net?.rwClamp, 3);
  assertEquals(pback.net?.rwFwd, 2);
  assertEquals(pback.net?.hRwClamp, 9);
});

Deno.test("Welcome + map is smaller than JSON", () => {
  const spawn = {
    ...motionPlayer("me", 0),
    name: "Ada",
    score: 2,
    kills: 1,
    deaths: 0,
    xp: 1200,
    mmsRankId: "steel",
    head: 1,
    visor: 0,
    shoulder: 0,
    body: 0,
    leg: 0,
    hue: 0.1,
    gunHue: -0.2,
    pistol: 1,
    rifle: 0,
    crosshair: 2,
  };
  const welcome = {
    id: "me",
    serverName: "Local",
    tickRate: 60,
    snapshotRate: 20,
    tick: 40,
    doorsOpen: true,
    doorChangeTick: 90,
    matchEndTick: 36000,
    spawn,
    players: [spawn],
    team: "A",
    map: miniMap,
    scores: { A: 0, B: 0 },
    ranked: false,
    autofillBots: 8,
    ownedAbilities: ["quick", "bullets2"],
    skillLoadout: ["quick", "glitch", null, null],
  };
  const buf = encodeGamePacket("welcome", welcome)!;
  assertLess(
    socketIoBinaryEventBytes(buf.byteLength),
    socketIoJsonEventBytes("welcome", welcome),
  );
  const back = roundtrip("welcome", welcome) as typeof welcome;
  assertEquals(back.id, "me");
  assertEquals(back.map.name, "yard");
  assertEquals(back.map.walls.length, 2);
  assertEquals(back.map.botHints, miniMap.botHints);
  assertEquals(back.skillLoadout, ["quick", "glitch", null, null]);
  assertEquals(back.ownedAbilities, ["quick", "bullets2"]);
  assertEquals(back.autofillBots, 8);

  const raidWelcome = {
    ...welcome,
    matchKind: "raid" as const,
    raid: { door: 1, goal: 5, respawnMs: 4000, title: "Raid" },
  };
  const rback = roundtrip("welcome", raidWelcome) as typeof raidWelcome;
  assertEquals(rback.matchKind, "raid");
  assertEquals(rback.raid.goal, 5);
});

Deno.test("full-cosmetics snapshot roundtrips every style slot", () => {
  const player = {
    ...motionPlayer("style", 3),
    name: "Styles",
    head: 4,
    visor: 1,
    shoulder: 2,
    body: 3,
    leg: 1,
    hue: 0.5,
    gunHue: -0.5,
    pistol: 1,
    rifle: 2,
    shotgun: 3,
    crosshair: 4,
    scope: 2,
  };
  const back = roundtrip("snapshot", {
    tick: 7,
    doorsOpen: true,
    doorChangeTick: 8,
    matchEndTick: 36000,
    scores: { A: 0, B: 0 },
    players: [player],
    projectiles: [],
  }) as { players: typeof player[] };
  const seen = back.players[0]!;
  assertEquals(seen.head, 4);
  assertEquals(seen.visor, 1);
  assertEquals(seen.shoulder, 2);
  assertEquals(seen.body, 3);
  assertEquals(seen.leg, 1);
  assertEquals(seen.pistol, 1);
  assertEquals(seen.rifle, 2);
  assertEquals(seen.shotgun, 3);
  assertEquals(seen.crosshair, 4);
  assertEquals(seen.scope, 2);
  // Scope is the trailing cosmetics byte, so the slots before it stay put.
  assertEquals(
    [seen.head, seen.visor, seen.shoulder, seen.body, seen.leg, seen.pistol, seen.rifle, seen.shotgun, seen.crosshair],
    [4, 1, 2, 3, 1, 1, 2, 3, 4],
  );
});

Deno.test("color cosmetics roundtrip after the scope byte", () => {
  const player = {
    ...motionPlayer("colors", 3),
    name: "Colors",
    head: 2,
    crosshair: 1,
    scope: 3,
    bulletHue: -1.5,
    crosshairColor: 200 | (60 << 9) | (70 << 16),
    nameHue: -1.24,
  };
  const back = roundtrip("snapshot", {
    tick: 7,
    doorsOpen: true,
    doorChangeTick: 8,
    matchEndTick: 36000,
    scores: { A: 0, B: 0 },
    players: [player],
    projectiles: [],
  }) as { players: typeof player[] };
  const seen = back.players[0]!;
  assertEquals(seen.scope, 3);
  assertEquals(seen.bulletHue, -1.5);
  assertEquals(seen.crosshairColor, player.crosshairColor);
  assertEquals(seen.nameHue, -1.24);

  const defaults = roundtrip("snapshot", {
    tick: 7,
    doorsOpen: true,
    doorChangeTick: 8,
    matchEndTick: 36000,
    scores: { A: 0, B: 0 },
    players: [{ ...motionPlayer("plain", 3), name: "Plain", head: 1 }],
    projectiles: [],
  }) as { players: typeof player[] };
  assertEquals(defaults.players[0]!.crosshairColor, -1);
  assertEquals(defaults.players[0]!.nameHue, 0);
  assertEquals(defaults.players[0]!.bulletHue, 0);
});

Deno.test("malformed buffers decode to null", () => {
  assertEquals(decodeGamePacket(null), null);
  assertEquals(decodeGamePacket("nope"), null);
  assertEquals(decodeGamePacket(new Uint8Array([99, 1, 0, 0])), null);
  const trunc = encodeGamePacket("input", {
    sequence: 1,
    forward: true,
    backward: false,
    left: false,
    right: false,
    jump: false,
    sprint: false,
    crouch: false,
    yaw: 0,
    pitch: 0,
  })!;
  assertEquals(decodeGamePacket(trunc.subarray(0, 3)), null);
  const junk = new Uint8Array([GAME_PROTO, 99, 0, 0]);
  assertEquals(decodeGamePacket(junk), null);
});

Deno.test("lifecycle packets roundtrip", () => {
  const player = {
    ...motionPlayer("p1", 1),
    name: "Cara",
    score: 4,
    kills: 2,
    deaths: 1,
    xp: 10,
    mmsRankId: "iron",
  };
  assertEquals(
    (roundtrip("playerLeft", { id: "p1" }) as { id: string }).id,
    "p1",
  );
  const joined = roundtrip("playerJoined", player) as typeof player;
  assertEquals(joined.name, "Cara");
  const stage = roundtrip("mapChange", {
    map: miniMap,
    scores: { A: 5, B: 0 },
    players: [player],
    doorsOpen: true,
    doorChangeTick: 500,
    matchEndTick: 18_000,
    endedAsDraw: false,
    raidStage: true,
    prevMap: "Cornfield",
    nextMap: "Levels",
  }) as {
    map: { name: string };
    raidStage?: boolean;
    prevMap?: string;
    nextMap?: string;
  };
  assertEquals(stage.map.name, "yard");
  assertEquals(stage.raidStage, true);
  assertEquals(stage.prevMap, "Cornfield");
  assertEquals(stage.nextMap, "Levels");
  const go = roundtrip("gameOver", {
    winner: "A",
    scores: { A: 21, B: 14 },
    players: [{
      id: "p1",
      name: "Cara",
      team: "A",
      score: 4,
      kills: 2,
      deaths: 1,
      alive: true,
      xp: 10,
      mmsRankId: "iron",
      founderBadge: false,
    }],
    restartInSeconds: 20,
    mapVote: { options: [{ name: "yard", votes: 1 }], voterCount: 1 },
    xpMode: "unranked",
  }) as { winner: string; mapVote: { voterCount: number } };
  assertEquals(go.winner, "A");
  assertEquals(go.mapVote.voterCount, 1);
});

Deno.test("scoreboard kills stay signed (teamkill −2 must not wrap to u16)", () => {
  const player = {
    ...motionPlayer("p1", 1),
    name: "Cara",
    score: 0,
    kills: -2,
    deaths: 1,
  };
  const joined = roundtrip("playerJoined", player) as typeof player;
  assertEquals(joined.kills, -2);
  assertEquals(joined.deaths, 1);

  const scored = roundtrip("score", {
    scorerId: "p1",
    team: "A",
    scores: { A: 1, B: 0 },
    player,
  }) as { player: typeof player };
  assertEquals(scored.player.kills, -2);

  const go = roundtrip("gameOver", {
    winner: "B",
    scores: { A: 0, B: 21 },
    players: [{
      id: "p1",
      name: "Cara",
      team: "A",
      score: 0,
      kills: -2,
      deaths: 1,
      alive: false,
      xp: 10,
      mmsRankId: "iron",
      founderBadge: false,
    }],
    restartInSeconds: 20,
  }) as { players: Array<{ kills: number }> };
  assertEquals(go.players[0]!.kills, -2);
});

Deno.test("CombatBurst: shotgun pellet block roundtrips (flag 16)", () => {
  const pellets = [
    {
      direction: [0, 0, -1] as [number, number, number],
      hitId: "t1",
      hitZone: "head",
      hitPoint: [0, 1.5, 0.25] as [number, number, number],
    },
    {
      direction: [0.5, 0, -0.75] as [number, number, number],
      hitId: "t2",
      hitZone: "body",
      hitPoint: [1, 1.25, 0.5] as [number, number, number],
    },
    // Wall impact: point, no player.
    {
      direction: [-0.5, 0.25, -0.75] as [number, number, number],
      hitId: null,
      hitZone: null,
      hitPoint: [-2, 2.5, 3] as [number, number, number],
    },
    // Out of range: nothing.
    {
      direction: [0, 0.5, -0.75] as [number, number, number],
      hitId: null,
      hitZone: null,
      hitPoint: null,
    },
  ];
  const burst = {
    outcomes: [{
      shot: {
        shooterId: "s1",
        origin: [0, 1.5, 8] as [number, number, number],
        direction: pellets[0]!.direction,
        weapon: 2,
        hitId: "t1",
        hitZone: "head",
        hitPoint: pellets[0]!.hitPoint,
        pellets,
      },
    }],
  };
  const back = roundtrip("combatBurst", burst) as typeof burst;
  assertEquals(back.outcomes[0]!.shot, burst.outcomes[0]!.shot);

  // Single-pellet shots carry no block (no pellets key after decode).
  const single = roundtrip("combatBurst", {
    outcomes: [{ shot: { ...burst.outcomes[0]!.shot, pellets: undefined } }],
  }) as typeof burst;
  assertEquals("pellets" in back.outcomes[0]!.shot, true);
  assertEquals("pellets" in single.outcomes[0]!.shot, false);
});

Deno.test("snapshot: shotgun pumping rides bit 7 of the weapon byte", () => {
  const base = {
    tick: 5,
    doorsOpen: false,
    doorChangeTick: 10,
    matchEndTick: 100,
    scores: { A: 0, B: 0 },
    phase: "live",
    transport: { emitSeq: 1, emitAtMs: 1_700_000_000_000, kind: "volatile" },
    players: [],
    projectiles: [],
  };
  const pumping = { ...motionPlayer("p", 1), weapon: 2, pumping: true };
  const idle = { ...motionPlayer("q", 2), weapon: 2 };
  const out = roundtrip("snapshot", {
    ...base,
    players: [pumping, idle],
  }) as { players: { weapon?: number; pumping?: boolean }[] };
  assertEquals(out.players[0]!.weapon, 2);
  assertEquals(out.players[0]!.pumping, true);
  assertEquals(out.players[1]!.weapon, 2);
  assertEquals(out.players[1]!.pumping, undefined);
});
