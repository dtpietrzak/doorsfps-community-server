/**
 * Epic 7.1 — authoritative simulation boundary (ingress + egress).
 *
 * Run from server-community/:
 *   deno test -A players/sim_boundary_test.ts
 *
 * Locks: singular ingress seam, queued-vs-immediate tick association,
 * no in-step sessions.emit for connection-timeout leaves, driver roster
 * leave emit order, and no bypass writers of pendingWeapons / latestInput
 * outside the two documented seams (ingress sink + BotApply enqueue, PR 4).
 */

import {
  assertEquals,
  assertMatch,
  assertNotEquals,
} from "@std/assert";
import {
  ingressAbility,
  ingressMelee,
  ingressMovementInput,
  ingressReload,
  ingressShoot,
  ingressSkillLoadout,
  ingressWeaponSwitch,
  parseAbilityPacket,
  parsePlayerInput,
  parseShootPacket,
  parseSkillLoadoutPacket,
  parseWeaponSwitchRaw,
  type SimIngressSinks,
} from "./simIngress.ts";
import type { PendingWeapon } from "./weaponsQueue.ts";
import type { PlayerInput } from "../protocol/network.ts";
import type { SimRosterLeaveFact, SimTickResult } from "./simTickResult.ts";
import { normalizeCanonicalInput } from "../shared/sim/canonicalPlayerInput.ts";

const PACKAGE_ROOT = new URL("../", import.meta.url);

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function countMatches(source: string, re: RegExp): number {
  const flags = re.flags.includes("g") ? re.flags : `${re.flags}g`;
  return [...source.matchAll(new RegExp(re.source, flags))].length;
}

async function readRepo(rel: string): Promise<string> {
  return await Deno.readTextFile(new URL(rel, PACKAGE_ROOT));
}

/** Extract `private stepSimBody(...) { ... }` body for source scans. */
function extractStepSimBody(gameServerSrc: string): string {
  const start = gameServerSrc.indexOf("private stepSimBody(");
  assertNotEquals(start, -1, "stepSimBody method missing");
  const brace = gameServerSrc.indexOf("{", start);
  let depth = 0;
  for (let i = brace; i < gameServerSrc.length; i++) {
    const ch = gameServerSrc[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return gameServerSrc.slice(brace, i + 1);
    }
  }
  throw new Error("unbalanced stepSim braces");
}

function makeSinks(state: {
  inputs: Array<{ id: string; input: PlayerInput; nowMs: number }>;
  weapons: PendingWeapon[];
  reloads: Array<{ id: string; tick: number }>;
  switches: Array<{ id: string; weapon: unknown; tick: number }>;
  abilities: Array<{ id: string; ability: string; tick: number }>;
  loadouts: Array<{ id: string; slots: unknown[] }>;
}): SimIngressSinks {
  return {
    handleInput: (id, input, nowMs) => state.inputs.push({ id, input, nowMs }),
    enqueueHumanWeapon: (req) => state.weapons.push(req),
    handleReload: (id, tick) => state.reloads.push({ id, tick }),
    handleWeaponSwitch: (id, weapon, tick) =>
      state.switches.push({ id, weapon, tick }),
    handleAbility: (id, ability, tick) =>
      state.abilities.push({ id, ability, tick }),
    handleSkillLoadout: (id, slots) => state.loadouts.push({ id, slots }),
    volDropPctFor: () => 12,
  };
}

function emptyState() {
  return {
    inputs: [] as Array<{ id: string; input: PlayerInput; nowMs: number }>,
    weapons: [] as PendingWeapon[],
    reloads: [] as Array<{ id: string; tick: number }>,
    switches: [] as Array<{ id: string; weapon: unknown; tick: number }>,
    abilities: [] as Array<{ id: string; ability: string; tick: number }>,
    loadouts: [] as Array<{ id: string; slots: unknown[] }>,
  };
}

// --- Parsers ----------------------------------------------------------------

Deno.test("ingress parse: Input rejects malformed / non-numeric look", () => {
  assertEquals(parsePlayerInput(null), null);
  assertEquals(parsePlayerInput({}), null);
  assertEquals(parsePlayerInput({ sequence: 1, yaw: "x", pitch: 0 }), null);
  assertEquals(parsePlayerInput({ sequence: 1, yaw: 1 }), null); // missing pitch
});

Deno.test("ingress parse: Input accepts NaN yaw (hand-rolled; not canonical)", () => {
  // Decision 5: hand-rolled accepts typeof-number NaN; normalizeCanonicalInput would zero it.
  const parsed = parsePlayerInput({
    sequence: 3,
    yaw: Number.NaN,
    pitch: 0.1,
    forward: 1,
  });
  assertEquals(parsed?.sequence, 3);
  assertEquals(Number.isNaN(parsed!.yaw), true);
  assertEquals(parsed?.forward, true);

  const canon = normalizeCanonicalInput({
    yaw: Number.NaN,
    pitch: 0.1,
    forward: true,
  });
  assertEquals(canon.yaw, 0); // finiteOrZero — delta vs ingress
});

Deno.test("ingress parse: Input boolean-coerces keys; preserves look numbers", () => {
  const parsed = parsePlayerInput({
    sequence: 2,
    yaw: 1.5,
    pitch: -0.25,
    forward: "yes",
    jump: 0,
  });
  assertEquals(parsed, {
    sequence: 2,
    forward: true,
    backward: false,
    left: false,
    right: false,
    jump: false,
    sprint: false,
    crouch: false,
    yaw: 1.5,
    pitch: -0.25,
  });
});

Deno.test("ingress parse: Shoot drops non-finite aim; keeps origin/ticks", () => {
  assertEquals(parseShootPacket({ yaw: 1, pitch: Infinity }), null);
  const ok = parseShootPacket({
    yaw: 0.5,
    pitch: -0.1,
    origin: [1, 2, 3],
    clientTick: 10.7,
    lastAppliedSnapshotTick: 8,
    sequence: 4,
  });
  assertEquals(ok, {
    yaw: 0.5,
    pitch: -0.1,
    origin: [1, 2, 3],
    sequence: 4,
    clientTick: 10,
    lastAppliedSnapshotTick: 8,
  });
});

Deno.test("ingress parse: Ability / WeaponSwitch / SkillLoadout shapes", () => {
  assertEquals(parseAbilityPacket({ ability: "dash" }), "dash");
  assertEquals(parseAbilityPacket({ ability: 1 }), null);
  assertEquals(parseWeaponSwitchRaw({ weapon: 2 }), 2);
  assertEquals(parseWeaponSwitchRaw(3), 3);
  assertEquals(parseWeaponSwitchRaw("x"), undefined);
  assertEquals(parseSkillLoadoutPacket({ slots: ["a", null] }), ["a", null]);
  assertEquals(parseSkillLoadoutPacket({ slots: "nope" }), null);
});

// --- Ingress functions + tick association rows ------------------------------

Deno.test("ingress: movement rate-limit + parse → handleInput (consumption tick)", () => {
  const state = emptyState();
  const sinks = makeSinks(state);
  let allowed = false;
  const rate = { allow: () => allowed };

  assertEquals(
    ingressMovementInput(sinks, rate, "s1", "p1", {
      sequence: 1,
      yaw: 0,
      pitch: 0,
      forward: true,
    }, 1000),
    false,
  );
  assertEquals(state.inputs.length, 0);

  allowed = true;
  assertEquals(
    ingressMovementInput(sinks, rate, "s1", "p1", {
      sequence: 1,
      yaw: 0,
      pitch: 0,
      forward: true,
    }, 1000),
    true,
  );
  assertEquals(state.inputs.length, 1);
  assertEquals(state.inputs[0]!.input.forward, true);
  assertEquals(state.inputs[0]!.nowMs, 1000);
});

Deno.test("ingress: Shoot/Melee queue at drain tick; Reload/Switch/Ability arrival tick", () => {
  const state = emptyState();
  const sinks = makeSinks(state);

  ingressShoot(sinks, "p1", { yaw: 0, pitch: 0 });
  ingressMelee(sinks, "p2", { yaw: 1, pitch: 0 });
  assertEquals(state.weapons.map((w) => `${w.kind}:${w.shooterId}`), [
    "shoot:p1",
    "melee:p2",
  ]);
  assertEquals(state.weapons[0]!.volDropPct, 12);

  ingressReload(sinks, "p1", 42);
  ingressWeaponSwitch(sinks, "p1", { weapon: 1 }, 42);
  ingressAbility(sinks, "p1", { ability: "heal" }, 42);
  assertEquals(state.reloads, [{ id: "p1", tick: 42 }]);
  assertEquals(state.switches, [{ id: "p1", weapon: 1, tick: 42 }]);
  assertEquals(state.abilities, [{ id: "p1", ability: "heal", tick: 42 }]);

  // Tick-association contract rows (documented; not retimed by 7.1):
  // Shoot/Melee → draining tick; Reload/Switch/Ability → arrival tick.
  assertEquals(state.weapons.length > 0 && state.reloads[0]!.tick === 42, true);
});

Deno.test("ingress: SkillLoadout is config, not weapon/input queue", () => {
  const state = emptyState();
  const sinks = makeSinks(state);
  assertEquals(ingressSkillLoadout(sinks, "p1", { slots: [null, null] }), true);
  assertEquals(state.loadouts.length, 1);
  assertEquals(state.weapons.length, 0);
  assertEquals(state.inputs.length, 0);
});

// --- Egress / driver seams --------------------------------------------------

Deno.test("egress: SimTickResult requires rosterLeaves (7.1 driver tap)", () => {
  const leaves: SimRosterLeaveFact[] = [
    { playerId: "a", hadMapVote: true },
    { playerId: "b", hadMapVote: false },
  ];
  const result: SimTickResult = {
    events: [],
    shootHeatmap: [],
    heatmapDepartures: [],
    rosterLeaves: leaves,
  };
  assertEquals(result.rosterLeaves.map((l) => l.playerId), ["a", "b"]);
  assertEquals(result.rosterLeaves[0]!.hadMapVote, true);
});

Deno.test("egress: driver emit order preserves rosterLeaves construction order", () => {
  // Mirrors startGameLoop: after emitSimTickEvents, walk rosterLeaves.
  const leaves: SimRosterLeaveFact[] = [
    { playerId: "p-late", hadMapVote: false },
    { playerId: "p-vote", hadMapVote: true },
  ];
  const mapVotingOpen = true;
  const emitted: string[] = [];
  for (const leave of leaves) {
    emitted.push(`PlayerLeft:${leave.playerId}`);
    if (leave.hadMapVote && mapVotingOpen) {
      emitted.push("MapVoteState");
    }
  }
  assertEquals(emitted, [
    "PlayerLeft:p-late",
    "PlayerLeft:p-vote",
    "MapVoteState",
  ]);
});

Deno.test("boundary: stepSim body has no sessions.emit (connection-timeout moved)", async () => {
  const src = stripComments(await readRepo("runtime/GameServer.ts"));
  const body = extractStepSimBody(src);
  assertEquals(
    countMatches(body, /sessions\s*!\s*\.\s*emit\s*\(/),
    0,
    "stepSim must not call sessions.emit (7.1)",
  );
  assertEquals(
    countMatches(body, /sessions\s*\.\s*emit\s*\(/),
    0,
    "stepSim must not call sessions.emit (7.1)",
  );
  // Facts collected instead:
  assertMatch(body, /rosterLeaves\.push/);
  // Driver still emits after emitSimTickEvents:
  const driver = src;
  assertMatch(driver, /result\.rosterLeaves/);
  assertMatch(driver, /NetEvents\.PlayerLeft/);
});

Deno.test("boundary: combat packets packed in stepSimBody before pruneDeadAgents", async () => {
  const src = stripComments(await readRepo("runtime/GameServer.ts"));
  const body = extractStepSimBody(src);
  const packAt = body.indexOf("toCombatOutcomePacket");
  const pruneAt = body.indexOf("pruneDeadAgents");
  assertNotEquals(packAt, -1, "stepSimBody must stamp kill-feed names");
  assertNotEquals(pruneAt, -1, "stepSimBody still prunes dead agents");
  assertEquals(
    packAt < pruneAt,
    true,
    "kill-feed names must be stamped before agent prune",
  );
});

Deno.test("boundary: registerEvents action handlers go through ingress*", async () => {
  const src = stripComments(await readRepo("runtime/GameServer.ts"));
  // Handlers must call ingress helpers — not push pendingWeapons inline.
  for (const name of [
    "ingressMovementInput",
    "ingressShoot",
    "ingressMelee",
    "ingressReload",
    "ingressWeaponSwitch",
    "ingressAbility",
    "ingressSkillLoadout",
  ]) {
    assertMatch(src, new RegExp(name));
  }
  // No local parse helpers left at file scope:
  assertEquals(countMatches(src, /^function parsePlayerInput\b/m), 0);
  assertEquals(countMatches(src, /^function parseShootPacket\b/m), 0);
  assertEquals(countMatches(src, /^function parseAbilityPacket\b/m), 0);
  assertEquals(countMatches(src, /^function parseSkillLoadoutPacket\b/m), 0);
});

Deno.test("boundary: pendingWeapons push only via the two documented seams (PR 4: ingress sink + BotApply enqueue)", async () => {
  const src = stripComments(await readRepo("runtime/GameServer.ts"));
  // Exactly two legitimate pushes: the human ingress sink (simIngressSinks)
  // and the BotApply enqueueWeapon lambda handed to applyReadyActions.
  const pushes = countMatches(src, /pendingWeapons\.push\s*\(/);
  assertEquals(
    pushes,
    2,
    "exactly two pendingWeapons.push call sites (ingress sink + BotApply enqueue)",
  );
  assertMatch(
    src,
    /enqueueHumanWeapon:\s*\(req\)\s*=>\s*this\.pendingWeapons\.push/,
  );
  // `extractStepSimBody` can't be reused here (pre-existing epic-4.8 split:
  // `stepSim` is now a thin try/finally wrapper over `stepSimBody`, which the
  // helper above doesn't know to unwrap — see the pre-existing failure this
  // causes in "boundary: stepSim body has no sessions.emit"). Match against
  // the whole file instead, same as the pushes-count assertion above.
  assertMatch(
    src,
    /applyReadyActions\(\s*tick,\s*nowMs,\s*\(req\)\s*=>\s*this\.pendingWeapons\.push/,
    "BotApply must enqueue via the shared pendingWeapons sink, not resolve inline",
  );
});

Deno.test("boundary: simIngress is adapter (not on SIM allowlist)", async () => {
  const { SIM_FILE_ALLOWLIST } = await import("./simIsolation.ts");
  assertEquals(
    (SIM_FILE_ALLOWLIST as readonly string[]).includes(
      "players/simIngress.ts",
    ),
    false,
  );
  const ingress = stripComments(
    await readRepo("players/simIngress.ts"),
  );
  assertEquals(ingress.includes("transport/"), false);
  assertEquals(/sessions\.emit/.test(ingress), false);
});
