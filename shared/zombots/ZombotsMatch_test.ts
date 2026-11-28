import { assertEquals } from "@std/assert";
import { createSimRng } from "../sim/simRng.ts";
import type { ZombotsEvent, ZombotsIntent, ZombotsSpawnPoint } from "./types.ts";
import {
  ZombotsMatch,
  zombotsWavePlan,
  type ZombotsMatchTuning,
} from "./ZombotsMatch.ts";
import { ZOMBOTS_TUNING } from "./zombotsTuning.ts";

const OPEN = (): boolean => true;

const PAD: ZombotsSpawnPoint = { id: "a", p: { x: 1, z: 2 } };

const ROOMS: readonly ZombotsSpawnPoint[] = [
  { id: "a", p: { x: 1, z: 2 } },
  { id: "b", p: { x: 3, z: 4 } },
  { id: "c", p: { x: 5, z: 6 } },
];

function withTuning(overrides: {
  timing?: Partial<ZombotsMatchTuning["timing"]>;
  waves?: Partial<ZombotsMatchTuning["waves"]>;
  zombie?: Partial<ZombotsMatchTuning["zombie"]>;
} = {}): ZombotsMatchTuning {
  return {
    players: {
      min: ZOMBOTS_TUNING.players.min,
      max: ZOMBOTS_TUNING.players.max,
    },
    timing: { ...ZOMBOTS_TUNING.timing, ...overrides.timing },
    waves: { ...ZOMBOTS_TUNING.waves, ...overrides.waves },
    zombie: { ...ZOMBOTS_TUNING.zombie, ...overrides.zombie },
  };
}

function join(playerId: string): ZombotsEvent {
  return { kind: "playerJoined", playerId };
}

function left(playerId: string): ZombotsEvent {
  return { kind: "playerLeft", playerId };
}

function down(playerId: string): ZombotsEvent {
  return { kind: "playerDowned", playerId };
}

function spawned(zombieId: string, spawnId = "a"): ZombotsEvent {
  return { kind: "zombieSpawned", zombieId, spawnId };
}

function killed(zombieId: string, by: string | null = "a"): ZombotsEvent {
  return { kind: "zombieKilled", zombieId, by };
}

function spawnIds(intents: readonly ZombotsIntent[]): string[] {
  const ids: string[] = [];
  for (const intent of intents) {
    if (intent.kind === "spawnZombie") ids.push(intent.spawnId);
  }
  return ids;
}

function flatTuning(): ZombotsMatchTuning {
  return withTuning({
    timing: {
      firstIntermissionMs: 100,
      intermissionMs: 200,
      spawnIntervalMs: 50,
    },
    waves: {
      baseCount: 3,
      growthPerWave: 0,
      playerCountMultiplier: [1, 1, 1, 1],
      maxAlive: 10,
    },
  });
}

Deno.test("zombotsWavePlan scales with humans and steps on the stock table", () => {
  const one = zombotsWavePlan(1, 1);
  assertEquals(one.count, 6);
  assertEquals(one.step, 0);
  assertEquals(one.health, ZOMBOTS_TUNING.zombie.baseHealth);
  assertEquals(one.meleeDamage, ZOMBOTS_TUNING.zombie.baseMeleeDamage);
  assertEquals(one.speedScale, ZOMBOTS_TUNING.zombie.baseSpeedScale);
  assertEquals(one.speedScale < ZOMBOTS_TUNING.zombie.maxSpeedScale, true);

  // playerCountMultiplier is [1, 1.6, 2.2, 2.8]. 6 times those, rounded.
  assertEquals(zombotsWavePlan(1, 2).count, 10);
  assertEquals(zombotsWavePlan(1, 3).count, 13);
  assertEquals(zombotsWavePlan(1, 4).count, 17);

  assertEquals(zombotsWavePlan(2, 1).count, 8);
  assertEquals(zombotsWavePlan(2, 1).step, 0);

  // step = floor((wave-1) / 2). Wave 3 is step 1.
  const stepped = zombotsWavePlan(3, 1);
  assertEquals(stepped.count, 10);
  assertEquals(stepped.step, 1);
  assertEquals(
    stepped.health,
    ZOMBOTS_TUNING.zombie.baseHealth + ZOMBOTS_TUNING.zombie.healthPerStep,
  );
  assertEquals(
    stepped.meleeDamage,
    ZOMBOTS_TUNING.zombie.baseMeleeDamage + ZOMBOTS_TUNING.zombie.meleeDamagePerStep,
  );
  assertEquals(zombotsWavePlan(4, 1).count, 12);
  assertEquals(zombotsWavePlan(4, 1).step, 1);
  assertEquals(zombotsWavePlan(4, 4).count, 34);
  assertEquals(zombotsWavePlan(4, 4).step, 1);

  // Wave 11 is step 5 (reaches speed cap 0.85), wave 13 is step 6 (past cap).
  const atCap = zombotsWavePlan(11, 1);
  const pastCap = zombotsWavePlan(13, 1);
  assertEquals(atCap.step, 5);
  assertEquals(
    atCap.health,
    ZOMBOTS_TUNING.zombie.baseHealth + ZOMBOTS_TUNING.zombie.healthPerStep * 5,
  );
  assertEquals(atCap.speedScale <= ZOMBOTS_TUNING.zombie.maxSpeedScale, true);
  assertEquals(pastCap.step, 6);
  assertEquals(pastCap.speedScale, ZOMBOTS_TUNING.zombie.maxSpeedScale);
  assertEquals(
    pastCap.health,
    ZOMBOTS_TUNING.zombie.baseHealth + ZOMBOTS_TUNING.zombie.healthPerStep * 6,
  );
  assertEquals(
    pastCap.meleeDamage,
    ZOMBOTS_TUNING.zombie.baseMeleeDamage +
      ZOMBOTS_TUNING.zombie.meleeDamagePerStep * 6,
  );
  const uncapped = ZOMBOTS_TUNING.zombie.baseSpeedScale +
    ZOMBOTS_TUNING.zombie.speedScalePerStep * pastCap.step;
  assertEquals(uncapped > ZOMBOTS_TUNING.zombie.maxSpeedScale, true);

  assertEquals(zombotsWavePlan(1, 0).humans, 1);
  assertEquals(zombotsWavePlan(1, 0).count, one.count);
  assertEquals(zombotsWavePlan(1, 99).humans, 4);
  assertEquals(zombotsWavePlan(1, 99).count, zombotsWavePlan(1, 4).count);
  assertEquals(zombotsWavePlan(1, 1.9).humans, 1);
  assertEquals(zombotsWavePlan(0, 1), one);
  assertEquals(zombotsWavePlan(3.9, 1).wave, 3);
  assertEquals(zombotsWavePlan(3.9, 1).count, stepped.count);

  const custom = withTuning({
    waves: { baseCount: 1, growthPerWave: 10, stepEveryWaves: 2 },
  });
  assertEquals(zombotsWavePlan(2, 1, custom).step, 0);
  assertEquals(zombotsWavePlan(2, 1, custom).count, 11);
  assertEquals(zombotsWavePlan(3, 1, custom).step, 1);
  assertEquals(zombotsWavePlan(3, 1, custom).count, 21);
});

Deno.test("first intermission starts the wave on time and spaces spawns", () => {
  const first = ZOMBOTS_TUNING.timing.firstIntermissionMs;
  const gap = ZOMBOTS_TUNING.timing.spawnIntervalMs;
  const match = new ZombotsMatch({ zombieSpawns: [PAD], rng: () => 0 });

  assertEquals(match.phase, "waiting");
  assertEquals(match.wave, 0);
  assertEquals(match.zombiesLeft, 0);
  assertEquals(match.tick(60_000, [], OPEN), []);
  assertEquals(match.phase, "waiting");

  assertEquals(match.tick(0, [join("p")], OPEN), []);
  assertEquals(match.phase, "intermission");
  assertEquals(match.msUntilNextWave, first);

  // A second human does not restart the countdown.
  assertEquals(match.tick(4_000, [], OPEN), []);
  assertEquals(match.tick(0, [join("q")], OPEN), []);
  assertEquals(match.msUntilNextWave, first - 4_000);
  assertEquals(match.humans.size, 2);

  const early = new ZombotsMatch({ zombieSpawns: [PAD], rng: () => 0 });
  assertEquals(early.tick(first - 1, [join("p")], OPEN), []);
  assertEquals(early.phase, "intermission");
  assertEquals(early.msUntilNextWave, 1);

  const started = match.tick(first - 4_000, [], OPEN);
  const plan = zombotsWavePlan(1, 2);
  assertEquals(match.phase, "wave");
  assertEquals(match.wave, 1);
  assertEquals(match.msUntilNextWave, 0);
  assertEquals(started[0], { kind: "waveStart", wave: 1, zombieCount: plan.count });
  assertEquals(plan.count, 10);
  assertEquals(started[1], {
    kind: "spawnZombie",
    wave: 1,
    spawnId: "a",
    p: { x: 1, z: 2 },
    health: plan.health,
    speedScale: plan.speedScale,
    modelScale: 1,
    grandpa: false,
    tall: false,
    meleeDamage: plan.meleeDamage,
  });
  assertEquals(started.length, 2);
  assertEquals(match.zombiesLeft, plan.count);

  assertEquals(match.tick(gap - 1, [], OPEN), []);
  const next = match.tick(1, [], OPEN);
  assertEquals(next.length, 1);
  assertEquals(next[0].kind, "spawnZombie");
  assertEquals(match.zombiesLeft, plan.count);
});

Deno.test("four humans scale the first wave from the stock table", () => {
  const match = new ZombotsMatch({ zombieSpawns: [PAD], rng: () => 0 });
  const intents = match.tick(
    ZOMBOTS_TUNING.timing.firstIntermissionMs,
    [join("a"), join("b"), join("c"), join("d")],
    OPEN,
  );
  assertEquals(intents[0], {
    kind: "waveStart",
    wave: 1,
    zombieCount: zombotsWavePlan(1, 4).count,
  });
  assertEquals(zombotsWavePlan(1, 4).count, 17);
  assertEquals(match.zombiesLeft, 17);
});

Deno.test("pending spawns count against maxAlive", () => {
  const tuning = withTuning({
    timing: { firstIntermissionMs: 10, intermissionMs: 10, spawnIntervalMs: 100 },
    waves: {
      baseCount: 5,
      growthPerWave: 0,
      playerCountMultiplier: [1, 1, 1, 1],
      maxAlive: 2,
    },
  });
  const match = new ZombotsMatch({
    zombieSpawns: [PAD],
    rng: () => 0,
    tuning,
  });
  const started = match.tick(10_000, [join("p")], OPEN);
  assertEquals(started[0], { kind: "waveStart", wave: 1, zombieCount: 5 });
  assertEquals(spawnIds(started).length, 2);
  assertEquals(match.zombiesLeft, 5);

  assertEquals(spawnIds(match.tick(10_000, [], OPEN)), []);
  assertEquals(match.zombiesLeft, 5);

  assertEquals(match.tick(0, [spawned("z1"), spawned("z2")], OPEN), []);
  assertEquals(spawnIds(match.tick(10_000, [], OPEN)), []);

  // The duplicate id must not free a slot or consume a second pending spawn.
  assertEquals(match.tick(0, [spawned("z1")], OPEN), []);
  assertEquals(match.zombiesLeft, 5);

  // The gap already elapsed while the cap was full, so the death's own
  // tick fills the slot. A second tick does not, because the cap is full again.
  const freed = match.tick(0, [killed("z1")], OPEN);
  assertEquals(spawnIds(freed), ["a"]);
  assertEquals(match.phase, "wave");
  assertEquals(match.zombiesLeft, 4);
  assertEquals(spawnIds(match.tick(0, [], OPEN)), []);
});

Deno.test("round-robin skips spawns the gate closes", () => {
  const tuning = withTuning({
    timing: { firstIntermissionMs: 5, intermissionMs: 5, spawnIntervalMs: 0 },
    waves: {
      baseCount: 6,
      growthPerWave: 0,
      playerCountMultiplier: [1, 1, 1, 1],
      maxAlive: 10,
    },
  });
  let draws = 0;
  const match = new ZombotsMatch({
    zombieSpawns: ROOMS,
    rng: () => {
      draws += 1;
      return 0;
    },
    tuning,
  });
  const intents = match.tick(5, [join("p")], (id) => id !== "b");
  assertEquals(spawnIds(intents), ["a", "c", "a", "c", "a", "c"]);
  assertEquals(intents[1], {
    kind: "spawnZombie",
    wave: 1,
    spawnId: "a",
    p: { x: 1, z: 2 },
    health: zombotsWavePlan(1, 1, tuning).health,
    speedScale: zombotsWavePlan(1, 1, tuning).speedScale,
    modelScale: 1,
    grandpa: false,
    tall: false,
    meleeDamage: zombotsWavePlan(1, 1, tuning).meleeDamage,
  });
  // One draw for the wave, not one draw per zombie.
  assertEquals(draws, 1);
});

Deno.test("round-robin falls back to constructor order when every spawn is closed", () => {
  const tuning = withTuning({
    timing: { firstIntermissionMs: 5, intermissionMs: 5, spawnIntervalMs: 0 },
    waves: {
      baseCount: 6,
      growthPerWave: 0,
      playerCountMultiplier: [1, 1, 1, 1],
      maxAlive: 10,
    },
  });
  // These ids sort lexicographically as s1, s10, s2. The walk must not sort them.
  const spawns: ZombotsSpawnPoint[] = [
    { id: "s2", p: { x: 0, z: 0 } },
    { id: "s10", p: { x: 1, z: 0 } },
    { id: "s1", p: { x: 2, z: 0 } },
  ];
  const match = new ZombotsMatch({
    zombieSpawns: spawns,
    rng: () => 0,
    tuning,
  });
  const intents = match.tick(5, [join("p")], () => false);
  assertEquals(spawnIds(intents), ["s2", "s10", "s1", "s2", "s10", "s1"]);
});

Deno.test("round-robin starts at an rng offset into the gated list", () => {
  const tuning = withTuning({
    timing: { firstIntermissionMs: 5, intermissionMs: 5, spawnIntervalMs: 0 },
    waves: {
      baseCount: 6,
      growthPerWave: 0,
      playerCountMultiplier: [1, 1, 1, 1],
      maxAlive: 10,
    },
  });
  // 0.5 * 3 = 1.5, so the walk starts at index 1.
  const offset = new ZombotsMatch({
    zombieSpawns: ROOMS,
    rng: () => 0.5,
    tuning,
  });
  assertEquals(
    spawnIds(offset.tick(5, [join("p")], OPEN)),
    ["b", "c", "a", "b", "c", "a"],
  );

  // A draw of 1 is outside [0, 1). Clamp it instead of indexing off the list.
  const clamped = new ZombotsMatch({
    zombieSpawns: ROOMS,
    rng: () => 1,
    tuning,
  });
  assertEquals(
    spawnIds(clamped.tick(5, [join("p")], OPEN)),
    ["c", "a", "b", "c", "a", "b"],
  );
});

Deno.test("an empty spawn list emits no zombies and can still wipe", () => {
  const tuning = flatTuning();
  let draws = 0;
  let gates = 0;
  const match = new ZombotsMatch({
    zombieSpawns: [],
    rng: () => {
      draws += 1;
      return 0;
    },
    tuning,
  });
  const started = match.tick(tuning.timing.firstIntermissionMs, [join("p")], () => {
    gates += 1;
    return true;
  });
  assertEquals(started, [{ kind: "waveStart", wave: 1, zombieCount: 3 }]);
  assertEquals(match.phase, "wave");
  assertEquals(match.zombiesLeft, 3);
  assertEquals(draws, 0);
  assertEquals(gates, 0);

  const stalled = match.tick(10_000, [killed("nobody")], () => {
    gates += 1;
    return true;
  });
  assertEquals(stalled, []);
  assertEquals(match.phase, "wave");

  const ended = match.tick(0, [down("p")], OPEN);
  assertEquals(ended, [{ kind: "runOver", waveReached: 1 }]);
  assertEquals(match.phase, "over");
});

Deno.test("a wave clears only after every one of its zombies is dead", () => {
  const tuning = flatTuning();
  const match = new ZombotsMatch({ zombieSpawns: [PAD], rng: () => 0, tuning });
  match.tick(0, [join("p")], OPEN);

  assertEquals(match.tick(tuning.timing.firstIntermissionMs - 1, [], OPEN), []);
  assertEquals(match.msUntilNextWave, 1);

  const started = match.tick(1, [], OPEN);
  assertEquals(started[0], { kind: "waveStart", wave: 1, zombieCount: 3 });
  assertEquals(spawnIds(started), ["a"]);
  assertEquals(match.zombiesLeft, 3);

  assertEquals(match.tick(tuning.timing.spawnIntervalMs - 1, [], OPEN), []);
  assertEquals(spawnIds(match.tick(1, [], OPEN)), ["a"]);

  // Both confirmed zombies die. The third was never emitted, so the wave stays up.
  // A repeated spawn id and a kill for an unknown id do not change the count.
  assertEquals(
    match.tick(0, [
      spawned("z1"),
      spawned("z1"),
      spawned("z2"),
      killed("z1", null),
      killed("z2"),
      killed("nobody"),
    ], OPEN),
    [],
  );
  assertEquals(match.zombiesLeft, 1);
  assertEquals(match.phase, "wave");

  assertEquals(spawnIds(match.tick(tuning.timing.spawnIntervalMs, [], OPEN)), ["a"]);
  assertEquals(match.tick(0, [spawned("z3")], OPEN), []);
  assertEquals(match.zombiesLeft, 1);
  assertEquals(match.phase, "wave");

  const cleared = match.tick(0, [killed("z3"), killed("z3")], OPEN);
  assertEquals(cleared, [{ kind: "waveCleared", wave: 1 }]);
  assertEquals(match.phase, "intermission");
  assertEquals(match.wave, 1);
  assertEquals(match.zombiesLeft, 0);
  assertEquals(match.msUntilNextWave, tuning.timing.intermissionMs);

  assertEquals(match.tick(tuning.timing.intermissionMs - 1, [], OPEN), []);
  assertEquals(match.phase, "intermission");
  assertEquals(match.wave, 1);
  assertEquals(match.msUntilNextWave, 1);

  const next = match.tick(1, [], OPEN);
  assertEquals(next[0], { kind: "waveStart", wave: 2, zombieCount: 3 });
  assertEquals(match.phase, "wave");
  assertEquals(match.msUntilNextWave, 0);
});

Deno.test("later waves scale with who is connected, and downed humans stay down", () => {
  const tuning = withTuning({
    timing: { firstIntermissionMs: 100, intermissionMs: 100, spawnIntervalMs: 0 },
    waves: { maxAlive: 30 },
  });
  const match = new ZombotsMatch({ zombieSpawns: [PAD], rng: () => 0, tuning });
  const first = match.tick(100, [join("a")], OPEN);
  assertEquals(first[0], { kind: "waveStart", wave: 1, zombieCount: 6 });

  assertEquals(match.tick(0, [join("b"), join("c"), join("d"), down("a")], OPEN), []);
  assertEquals(match.phase, "wave");
  assertEquals(match.downed.has("a"), true);
  assertEquals(match.humans.size, 4);

  const ids = ["z1", "z2", "z3", "z4", "z5", "z6"];
  const events: ZombotsEvent[] = [];
  for (const id of ids) events.push(spawned(id));
  for (const id of ids) events.push(killed(id));
  assertEquals(match.tick(0, events, OPEN), [{ kind: "waveCleared", wave: 1 }]);
  assertEquals(match.downed.has("a"), true);

  const second = match.tick(100, [], OPEN);
  assertEquals(second[0], {
    kind: "waveStart",
    wave: 2,
    zombieCount: zombotsWavePlan(2, 4, tuning).count,
  });
  assertEquals(zombotsWavePlan(2, 4, tuning).count, 22);
  assertEquals(match.downed.has("a"), true);
  assertEquals(match.downed.has("b"), false);
  assertEquals(spawnIds(second).length, 22);
});

Deno.test("spawn intents carry the stepped health, speed and damage", () => {
  const tuning = withTuning({
    timing: { firstIntermissionMs: 10, intermissionMs: 10, spawnIntervalMs: 0 },
    waves: {
      baseCount: 1,
      growthPerWave: 0,
      playerCountMultiplier: [1, 1, 1, 1],
      maxAlive: 5,
      stepEveryWaves: 1,
    },
  });
  const match = new ZombotsMatch({ zombieSpawns: [PAD], rng: () => 0, tuning });
  const first = match.tick(10, [join("p")], OPEN);
  const wave1 = zombotsWavePlan(1, 1, tuning);
  assertEquals(wave1.step, 0);
  assertEquals(first[1], {
    kind: "spawnZombie",
    wave: 1,
    spawnId: "a",
    p: { x: 1, z: 2 },
    health: wave1.health,
    speedScale: wave1.speedScale,
    modelScale: 1,
    grandpa: false,
    tall: false,
    meleeDamage: wave1.meleeDamage,
  });

  assertEquals(
    match.tick(0, [spawned("z1"), killed("z1")], OPEN),
    [{ kind: "waveCleared", wave: 1 }],
  );
  const second = match.tick(10, [], OPEN);
  const wave2 = zombotsWavePlan(2, 1, tuning);
  assertEquals(wave2.step, 1);
  assertEquals(
    wave2.health,
    ZOMBOTS_TUNING.zombie.baseHealth + ZOMBOTS_TUNING.zombie.healthPerStep,
  );
  assertEquals(
    wave2.meleeDamage,
    ZOMBOTS_TUNING.zombie.baseMeleeDamage + ZOMBOTS_TUNING.zombie.meleeDamagePerStep,
  );
  assertEquals(wave2.speedScale > ZOMBOTS_TUNING.zombie.baseSpeedScale, true);
  assertEquals(wave2.speedScale <= ZOMBOTS_TUNING.zombie.maxSpeedScale, true);
  assertEquals(second[0], { kind: "waveStart", wave: 2, zombieCount: 1 });
  assertEquals(second[1], {
    kind: "spawnZombie",
    wave: 2,
    spawnId: "a",
    p: { x: 1, z: 2 },
    health: wave2.health,
    speedScale: wave2.speedScale,
    modelScale: 1,
    grandpa: false,
    tall: false,
    meleeDamage: wave2.meleeDamage,
  });
});

Deno.test("everyone down ends the run once", () => {
  const tuning = flatTuning();
  const match = new ZombotsMatch({ zombieSpawns: [PAD], rng: () => 0, tuning });
  match.tick(tuning.timing.firstIntermissionMs, [join("a"), join("b")], OPEN);
  assertEquals(match.wave, 1);

  assertEquals(match.tick(0, [down("stranger")], OPEN), []);
  assertEquals(match.downed.size, 0);

  assertEquals(match.tick(0, [down("a")], OPEN), []);
  assertEquals(match.phase, "wave");
  assertEquals([...match.downed], ["a"]);

  // A repeated join must not stand a downed human back up.
  assertEquals(match.tick(0, [join("a")], OPEN), []);
  assertEquals(match.downed.has("a"), true);

  const ended = match.tick(5_000, [down("b"), killed("ghost"), join("c")], OPEN);
  assertEquals(ended, [{ kind: "runOver", waveReached: 1 }]);
  assertEquals(match.phase, "over");
  assertEquals(match.wave, 1);
  assertEquals([...match.humans], ["a", "b"]);
  assertEquals(match.humans.has("c"), false);

  assertEquals(match.tick(60_000, [down("a"), join("c")], OPEN), []);
  assertEquals(match.phase, "over");
  match.markRevived("a");
  assertEquals(match.downed.has("a"), true);

  // Clearing the last zombie and then wiping in the same step does not
  // roll into the next wave. The dt is dropped with the run.
  const oneZombie = withTuning({
    timing: {
      firstIntermissionMs: 100,
      intermissionMs: 200,
      spawnIntervalMs: 50,
    },
    waves: {
      baseCount: 1,
      growthPerWave: 0,
      playerCountMultiplier: [1, 1, 1, 1],
      maxAlive: 10,
    },
  });
  const sameStep = new ZombotsMatch({
    zombieSpawns: [PAD],
    rng: () => 0,
    tuning: oneZombie,
  });
  sameStep.tick(oneZombie.timing.firstIntermissionMs, [join("a"), join("b")], OPEN);
  const intents = sameStep.tick(
    tuning.timing.intermissionMs,
    [spawned("z1"), killed("z1"), down("a"), down("b")],
    OPEN,
  );
  assertEquals(intents, [
    { kind: "waveCleared", wave: 1 },
    { kind: "runOver", waveReached: 1 },
  ]);
  assertEquals(sameStep.phase, "over");
  assertEquals(sameStep.wave, 1);
});

Deno.test("a revived human keeps a wipe from landing", () => {
  const tuning = flatTuning();
  const match = new ZombotsMatch({ zombieSpawns: [PAD], rng: () => 0, tuning });
  match.tick(0, [join("a"), join("b")], OPEN);
  assertEquals(match.phase, "intermission");

  assertEquals(match.tick(0, [down("a")], OPEN), []);
  assertEquals(match.phase, "intermission");
  match.markRevived("a");
  assertEquals(match.downed.has("a"), false);

  assertEquals(match.tick(0, [down("b")], OPEN), []);
  assertEquals(match.phase, "intermission");
  assertEquals(match.downed.has("b"), true);

  const ended = match.tick(0, [down("a")], OPEN);
  assertEquals(ended, [{ kind: "runOver", waveReached: 0 }]);
  assertEquals(match.phase, "over");
  assertEquals(match.tick(1_000, [], OPEN), []);
});

Deno.test("leaving humans end the run only when nobody is left standing", () => {
  const tuning = flatTuning();
  const match = new ZombotsMatch({ zombieSpawns: [PAD], rng: () => 0, tuning });
  match.tick(0, [join("a"), join("b")], OPEN);

  assertEquals(match.tick(0, [left("b")], OPEN), []);
  assertEquals([...match.humans], ["a"]);
  assertEquals(match.phase, "intermission");

  const ended = match.tick(1_000, [left("a")], OPEN);
  assertEquals(ended, [{ kind: "runOver", waveReached: 0 }]);
  assertEquals(match.phase, "over");
  assertEquals(match.tick(1_000, [join("a")], OPEN), []);

  // Leaving during the wave does not squeeze a spawn into that same step.
  const inWave = new ZombotsMatch({ zombieSpawns: [PAD], rng: () => 0, tuning });
  inWave.tick(tuning.timing.firstIntermissionMs, [join("a")], OPEN);
  assertEquals(inWave.wave, 1);
  const leftMidWave = inWave.tick(10_000, [left("a")], OPEN);
  assertEquals(leftMidWave, [{ kind: "runOver", waveReached: 1 }]);
  assertEquals(spawnIds(leftMidWave), []);

  // A downed human who leaves is gone. The one still up keeps the run going.
  const downedLeaves = new ZombotsMatch({
    zombieSpawns: [PAD],
    rng: () => 0,
    tuning,
  });
  downedLeaves.tick(0, [join("a"), join("b")], OPEN);
  downedLeaves.tick(0, [down("a")], OPEN);
  assertEquals(downedLeaves.tick(0, [left("a")], OPEN), []);
  assertEquals(downedLeaves.downed.has("a"), false);
  assertEquals([...downedLeaves.humans], ["b"]);
  assertEquals(downedLeaves.phase, "intermission");

  // The last living human leaving, with a downed human still connected, is a wipe.
  const lastLiving = new ZombotsMatch({
    zombieSpawns: [PAD],
    rng: () => 0,
    tuning,
  });
  lastLiving.tick(tuning.timing.firstIntermissionMs, [join("a"), join("b")], OPEN);
  lastLiving.tick(0, [down("a")], OPEN);
  assertEquals(lastLiving.tick(0, [left("b")], OPEN), [
    { kind: "runOver", waveReached: 1 },
  ]);

  // playerLeft drops the body. A later join of that id is alive again.
  const rejoined = new ZombotsMatch({ zombieSpawns: [PAD], rng: () => 0, tuning });
  rejoined.tick(0, [join("a"), join("b")], OPEN);
  rejoined.tick(0, [down("a")], OPEN);
  rejoined.tick(0, [left("a")], OPEN);
  rejoined.tick(0, [join("a")], OPEN);
  assertEquals(rejoined.downed.has("a"), false);
  assertEquals([...rejoined.humans], ["b", "a"]);
  assertEquals(rejoined.phase, "intermission");
});

Deno.test("a seeded rng repeats the same intents", () => {
  const tuning = withTuning({
    timing: { firstIntermissionMs: 100, intermissionMs: 150, spawnIntervalMs: 100 },
    waves: {
      baseCount: 3,
      growthPerWave: 1,
      playerCountMultiplier: [1, 1, 1, 1],
      maxAlive: 2,
    },
  });

  const play = (seed: number) => {
    const match = new ZombotsMatch({
      zombieSpawns: ROOMS,
      rng: createSimRng(seed),
      tuning,
    });
    const gate = (id: string): boolean => id !== "b";
    const log: ZombotsIntent[][] = [];
    const step = (dtMs: number, events: readonly ZombotsEvent[]) => {
      log.push(match.tick(dtMs, events, gate));
    };
    step(0, [join("a"), join("b")]);
    step(tuning.timing.firstIntermissionMs, []);
    step(tuning.timing.spawnIntervalMs, []);
    step(1_000, []);
    step(0, [spawned("z1", "a"), spawned("z2", "c"), down("a")]);
    step(0, [killed("z1")]);
    match.markRevived("a");
    step(tuning.timing.spawnIntervalMs, [killed("z2"), spawned("z3", "a")]);
    step(0, [killed("z3"), spawned("z4", "c"), killed("z4")]);
    step(tuning.timing.intermissionMs, []);
    return {
      log,
      phase: match.phase,
      wave: match.wave,
      zombiesLeft: match.zombiesLeft,
      msUntilNextWave: match.msUntilNextWave,
      humans: [...match.humans],
      downed: [...match.downed],
    };
  };

  assertEquals(play(42), play(42));
  assertEquals(play(7), play(7));
});

Deno.test("every 10th zombot across waves is a smaller double-speed mini", () => {
  const tuning = withTuning({
    timing: { firstIntermissionMs: 10, intermissionMs: 10, spawnIntervalMs: 0 },
    waves: {
      // 6 in wave 1, 8 in wave 2, 10 in wave 3, 12 in wave 4 → 36 total
      baseCount: 6,
      growthPerWave: 2,
      playerCountMultiplier: [1, 1, 1, 1],
      maxAlive: 20,
      stepEveryWaves: 3,
    },
  });
  const match = new ZombotsMatch({ zombieSpawns: [PAD], rng: () => 0, tuning });
  const spawns: Array<Extract<ZombotsIntent, { kind: "spawnZombie" }>> = [];

  const collectAndClearWave = (intents: ZombotsIntent[]) => {
    const waveSpawns = intents.filter(
      (i): i is Extract<ZombotsIntent, { kind: "spawnZombie" }> =>
        i.kind === "spawnZombie",
    );
    spawns.push(...waveSpawns);
    const events: ZombotsEvent[] = [];
    for (let i = 0; i < waveSpawns.length; i++) {
      const id = `z-${spawns.length - waveSpawns.length + i + 1}`;
      events.push(spawned(id), killed(id));
    }
    match.tick(0, events, OPEN);
  };

  // Wave 1 (6), wave 2 (8 → 14), wave 3 (10 → 24), wave 4 (12 → 36, stepped speed).
  collectAndClearWave(match.tick(10, [join("p")], OPEN));
  collectAndClearWave(match.tick(10, [], OPEN));
  collectAndClearWave(match.tick(10, [], OPEN));
  collectAndClearWave(match.tick(10, [], OPEN));

  assertEquals(spawns.length, 36);
  for (let i = 0; i < spawns.length; i++) {
    const seq = i + 1;
    const intent = spawns[i]!;
    const plan = zombotsWavePlan(intent.wave, 1, tuning);
    const isMini = seq % 10 === 0;
    const isGrandpa = !isMini && seq % 7 === 0;
    const isTall = !isMini && !isGrandpa && seq % 17 === 0;
    assertEquals(
      intent.modelScale,
      isMini ? ZOMBOTS_TUNING.zombie.miniModelScale : 1,
      `zombot ${seq} modelScale`,
    );
    assertEquals(
      intent.speedScale,
      isMini
        ? plan.speedScale * ZOMBOTS_TUNING.zombie.miniSpeedMultiplier
        : isGrandpa
        ? plan.speedScale * ZOMBOTS_TUNING.zombie.grandpaSpeedMultiplier
        : isTall
        ? plan.speedScale * ZOMBOTS_TUNING.zombie.tallWalkSpeedMultiplier
        : plan.speedScale,
      `zombot ${seq} speedScale`,
    );
    assertEquals(intent.grandpa, isGrandpa, `zombot ${seq} grandpa`);
    assertEquals(intent.tall, isTall, `zombot ${seq} tall`);
    assertEquals(
      intent.health,
      isGrandpa
        ? Math.round(plan.health * ZOMBOTS_TUNING.zombie.grandpaHealthMultiplier)
        : plan.health,
      `zombot ${seq} health`,
    );
  }
});
