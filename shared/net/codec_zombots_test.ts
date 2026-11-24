/**
 * Zombots wire additions (notes/zombots.md step 13): the player zombots byte,
 * the HUD block, Interact, and the Welcome / GameOver extensions. The golden
 * hex was captured from the codec before any zombots change, so a match
 * proves arena, ranked and raid bytes did not move.
 */
import { assertEquals } from "@std/assert";
import { decodeGamePacket, encodeGamePacket } from "./codec.ts";

const GOLDEN_SNAPSHOT = {
  tick: 1234,
  doorsOpen: true,
  doorChangeTick: 1200,
  matchEndTick: 99999,
  scores: { A: 3, B: 2 },
  phase: "live",
  players: [
    {
      id: "p1", x: 1.5, y: 1.7, z: -3.25, yaw: 0.5, pitch: -0.1, health: 87,
      alive: true, team: "A", crouch: true, weapon: 1, ammoInMag: 20, spareClips: 3,
      sprintStamina: 0.75, velocityX: 1, velocityY: 0, velocityZ: -2, keys: 5,
      lastProcessedInputSeq: 77, inputHoldTicks: 2, reloading: true,
    },
    {
      id: "bot:1", name: "bot", x: -4, y: 1.7, z: 8, yaw: 3, pitch: 0, health: 0,
      alive: false, team: "B", weapon: 2, pumping: true, botDec: 9, score: 4, kills: 2, deaths: -2,
      head: 1, hue: 0.25,
    },
  ],
  projectiles: [],
};
const GOLDEN_GAME_OVER = {
  winner: "A",
  scores: { A: 21, B: 18 },
  players: [{ id: "p1", name: "Alpha", team: "A", score: 10, kills: 5, deaths: 1, alive: true, xp: 100 }],
  restartInSeconds: 12,
  returnToMenu: true,
  matchKind: "raid",
  raid: { door: 3, goal: 5, respawnMs: 4000, title: "Crossroads", map: "Crossroads" },
};

const GOLDEN_HEX = {
  snapshot: "04100300d2040000b00400009f86010003000200010251f03800027031dc050000a40600004ef3fffff4019cff57646400000038ff0114034b004d00000002050220400705626f743a31000080c09a99d93f0000004100004040000000000064820900000003626f7404000200feff0100000000fa00000000000000000000ffffffff000000",
  playerJoined: "041200000220400705626f743a31000080c09a99d93f0000004100004040000000000064820900000003626f7404000200feff0100000000fa00000000000000000000ffffffff0000",
  gameOver: "04217100150012000102703105416c706861000a00050001000164000000ff000c0305a00f00000a43726f7373726f616473010a43726f7373726f616473",
};

function hex(bytes: Uint8Array | null): string {
  if (!bytes) return "null";
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function roundTrip(event: string, payload: unknown): unknown {
  const bytes = encodeGamePacket(event, payload);
  if (!bytes) throw new Error(`${event} did not encode`);
  const decoded = decodeGamePacket(bytes);
  if (!decoded) throw new Error(`${event} did not decode`);
  assertEquals(decoded.event, event);
  return decoded.payload;
}

Deno.test("non-zombots packets keep their pre-zombots bytes", () => {
  assertEquals(hex(encodeGamePacket("snapshot", GOLDEN_SNAPSHOT)), GOLDEN_HEX.snapshot);
  assertEquals(
    hex(encodeGamePacket("playerJoined", GOLDEN_SNAPSHOT.players[1])),
    GOLDEN_HEX.playerJoined,
  );
  assertEquals(hex(encodeGamePacket("gameOver", GOLDEN_GAME_OVER)), GOLDEN_HEX.gameOver);
});

Deno.test("downed and armedMask ride the zombots byte", () => {
  const base = {
    id: "p1",
    x: 1,
    y: 1.7,
    z: 2,
    yaw: 0,
    pitch: 0,
    health: 0,
    alive: false,
    team: "A" as const,
  };
  const rows = [
    { ...base, weapon: 0, downed: true as const, armedMask: 0 },
    { ...base, weapon: 2, pumping: true, armedMask: 0b101 },
    { ...base, armedMask: 0 },
    { ...base, downed: true as const },
    { ...base, weapon: 1 },
  ];
  const decoded = roundTrip("snapshot", {
    tick: 1,
    doorChangeTick: 0,
    matchEndTick: 0,
    scores: { A: 0, B: 0 },
    players: rows,
    projectiles: [],
  }) as { players: Record<string, unknown>[] };
  const pick = (p: Record<string, unknown>) => ({
    weapon: p.weapon,
    pumping: p.pumping,
    downed: p.downed,
    armedMask: p.armedMask,
  });
  assertEquals(decoded.players.map(pick), [
    { weapon: 0, pumping: undefined, downed: true, armedMask: 0 },
    { weapon: 2, pumping: true, downed: undefined, armedMask: 0b101 },
    // No weapon on the row: the sentinel id keeps it absent after decode.
    { weapon: undefined, pumping: undefined, downed: undefined, armedMask: 0 },
    { weapon: undefined, pumping: undefined, downed: true, armedMask: undefined },
    { weapon: 1, pumping: undefined, downed: undefined, armedMask: undefined },
  ]);
});

Deno.test("windowCrawlVariant and windowCrawlProgress ride the zombots byte", () => {
  const base = {
    id: "z1",
    x: 1,
    y: 2.1,
    z: 0,
    yaw: 0,
    pitch: 0,
    health: 100,
    alive: true,
    team: "B" as const,
    armedMask: 0,
  };
  const rows = [
    { ...base, windowCrawlVariant: 1 as const, windowCrawlProgress: 0 },
    { ...base, windowCrawlVariant: 2 as const, windowCrawlProgress: 0.5 },
    { ...base, windowCrawlVariant: 3 as const, windowCrawlProgress: 1 },
    { ...base },
  ];
  const decoded = roundTrip("snapshot", {
    tick: 10,
    doorChangeTick: 0,
    matchEndTick: 0,
    scores: { A: 0, B: 0 },
    players: rows,
    projectiles: [],
  }) as {
    players: {
      windowCrawlVariant?: number;
      windowCrawlProgress?: number;
      armedMask?: number;
    }[];
  };
  assertEquals(decoded.players[0]!.windowCrawlVariant, 1);
  assertEquals(decoded.players[0]!.windowCrawlProgress, 0);
  assertEquals(decoded.players[0]!.armedMask, 0);
  assertEquals(decoded.players[1]!.windowCrawlVariant, 2);
  assertEquals(
    Math.abs((decoded.players[1]!.windowCrawlProgress ?? 0) - 0.5) < 0.02,
    true,
  );
  assertEquals(decoded.players[2]!.windowCrawlVariant, 3);
  assertEquals(decoded.players[2]!.windowCrawlProgress, 1);
  assertEquals(decoded.players[3]!.windowCrawlVariant, undefined);
  assertEquals(decoded.players[3]!.windowCrawlProgress, undefined);
});

const HUD = {
  phase: "wave",
  wave: 7,
  zombiesLeft: 19,
  nextWaveAtTick: 0,
  openDoorIds: ["door-1", "door-2"],
  players: [
    { id: "p1", points: 1250, downed: false },
    { id: "p2", points: 0, downed: true },
  ],
  revives: [{ reviverId: "p1", targetId: "p2", presses: 13 }],
  events: [
    { kind: "waveStart", wave: 7, zombieCount: 30 },
    { kind: "waveCleared", wave: 6 },
    { kind: "playerDowned", playerId: "p2" },
    { kind: "playerRevived", playerId: "p2", by: "p1", health: 0.5 },
    { kind: "pointsChanged", playerId: "p1", points: 1250, delta: -50, reason: "revivePress" },
    { kind: "doorOpened", doorId: "door-2", by: "p1" },
    { kind: "weaponTaken", playerId: "p1", rackId: "rack-2", weapon: "rifle" },
    { kind: "runOver", waveReached: 7 },
  ],
};

Deno.test("ZombotsState carries the whole HUD block", () => {
  assertEquals(roundTrip("zombotsState", HUD), HUD);
  const quiet = { ...HUD, phase: "intermission", nextWaveAtTick: 123456 };
  delete (quiet as { events?: unknown }).events;
  assertEquals(roundTrip("zombotsState", quiet), quiet);
});

Deno.test("Interact has the Shoot wire shape", () => {
  const packet = { yaw: 1.25, pitch: -0.5, origin: [1, 2, 3], clientTick: 99 };
  assertEquals(roundTrip("interact", packet), packet);
});

Deno.test("GameOver carries the zombots kind and block", () => {
  const over = {
    winner: "B",
    scores: { A: 0, B: 0 },
    players: [],
    restartInSeconds: 10,
    matchKind: "zombots",
    zombots: { ...HUD, phase: "over", events: [{ kind: "runOver", waveReached: 7 }] },
  };
  const decoded = roundTrip("gameOver", over) as Record<string, unknown>;
  assertEquals(decoded.matchKind, "zombots");
  assertEquals(decoded.zombots, over.zombots);
});
