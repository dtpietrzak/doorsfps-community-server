import {
  assertEquals,
  assertNotEquals,
} from "jsr:@std/assert@1";
import {
  CANONICAL_APPLY_ORDER,
  CANONICAL_EDGE_FIELDS,
  CANONICAL_HELD_FIELDS,
  CANONICAL_PITCH_LIMIT,
  canonicalFromWireParts,
  consumeCanonicalEdges,
  emptyCanonicalInput,
  normalizeCanonicalInput,
  projectCanonicalHandlerCalls,
  toFirePacket,
  toMoveInput,
  type CanonicalPlayerInput,
} from "./canonicalPlayerInput.ts";
import { PI, TWO_PI } from "../math/constants.ts";
import { WEAPON_PISTOL, WEAPON_RIFLE } from "./weapons.ts";

Deno.test("normalize: empty / null → neutral defaults", () => {
  assertEquals(normalizeCanonicalInput(null), emptyCanonicalInput());
  assertEquals(normalizeCanonicalInput(undefined), emptyCanonicalInput());
  assertEquals(normalizeCanonicalInput({}), emptyCanonicalInput());
});

Deno.test("normalize: booleans coerce strictly (truthy non-true → false)", () => {
  const n = normalizeCanonicalInput({
    forward: 1,
    backward: "yes",
    left: {},
    right: true,
    sprint: false,
    crouch: true,
    jump: 1,
    meleeLunge: true,
    reload: "1",
  });
  assertEquals(n.forward, false);
  assertEquals(n.backward, false);
  assertEquals(n.left, false);
  assertEquals(n.right, true);
  assertEquals(n.sprint, false);
  assertEquals(n.crouch, true);
  assertEquals(n.jump, false);
  assertEquals(n.meleeLunge, true);
  assertEquals(n.reload, false);
});

Deno.test("normalize: non-finite yaw/pitch → 0; yaw wraps; pitch clamps", () => {
  assertEquals(normalizeCanonicalInput({ yaw: NaN, pitch: Infinity }).yaw, 0);
  assertEquals(
    normalizeCanonicalInput({ yaw: NaN, pitch: Infinity }).pitch,
    0,
  );
  assertEquals(
    normalizeCanonicalInput({ yaw: PI + 0.5 }).yaw,
    normalizeCanonicalInput({ yaw: PI + 0.5 - TWO_PI }).yaw,
  );
  const hi = normalizeCanonicalInput({ pitch: PI });
  assertEquals(hi.pitch, CANONICAL_PITCH_LIMIT);
  const lo = normalizeCanonicalInput({ pitch: -PI });
  assertEquals(lo.pitch, -CANONICAL_PITCH_LIMIT);
  // Exact limit matches handleShoot: ±π/2 − 0.01
  assertEquals(CANONICAL_PITCH_LIMIT, Math.PI / 2 - 0.01);
});

Deno.test("normalize: unknown weapon → null (no-op); known weapons kept", () => {
  assertEquals(normalizeCanonicalInput({ weaponSelect: 99 }).weaponSelect, null);
  assertEquals(
    normalizeCanonicalInput({ weaponSelect: "rifle" }).weaponSelect,
    null,
  );
  assertEquals(
    normalizeCanonicalInput({ weaponSelect: WEAPON_RIFLE }).weaponSelect,
    WEAPON_RIFLE,
  );
  assertEquals(
    normalizeCanonicalInput({ weaponSelect: WEAPON_PISTOL }).weaponSelect,
    WEAPON_PISTOL,
  );
});

Deno.test("normalize: unknown / passive ability → null; activatable kept", () => {
  assertEquals(normalizeCanonicalInput({ ability: "nope" }).ability, null);
  assertEquals(normalizeCanonicalInput({ ability: 1 }).ability, null);
  // Passives rejected (matching canActivateAbility / isSkillActivatable).
  assertEquals(normalizeCanonicalInput({ ability: "leech" }).ability, null);
  assertEquals(normalizeCanonicalInput({ ability: "quick" }).ability, "quick");
  assertEquals(
    normalizeCanonicalInput({ ability: "selfHeal" }).ability,
    "selfHeal",
  );
});

Deno.test("normalize: fire edge requires kind; strips bad origin; keeps lag-comp", () => {
  assertEquals(normalizeCanonicalInput({ fire: { yaw: 1, pitch: 0 } }).fire, null);
  assertEquals(
    normalizeCanonicalInput({
      fire: { kind: "shoot", yaw: 1.25, pitch: 0.1, origin: [1, NaN, 3] },
    }).fire?.origin,
    undefined,
  );
  const fire = normalizeCanonicalInput({
    fire: {
      kind: "melee",
      yaw: 0.5,
      pitch: 0.25,
      origin: [1, 2, 3],
      clientTick: 40,
      lastAppliedSnapshotTick: 39,
    },
  }).fire;
  assertEquals(fire?.kind, "melee");
  assertEquals(fire?.origin, [1, 2, 3]);
  assertEquals(fire?.clientTick, 40);
  assertEquals(fire?.lastAppliedSnapshotTick, 39);
});

Deno.test("held vs edge field tables are disjoint and cover the struct", () => {
  const held = new Set<string>(CANONICAL_HELD_FIELDS);
  const edge = new Set<string>(CANONICAL_EDGE_FIELDS);
  for (const f of CANONICAL_HELD_FIELDS) {
    assertEquals(edge.has(f), false);
  }
  const sample = emptyCanonicalInput();
  const keys = Object.keys(sample);
  for (const k of keys) {
    assertEquals(
      held.has(k) || edge.has(k),
      true,
      `field ${k} missing from held/edge tables`,
    );
  }
  assertEquals(held.size + edge.size, keys.length);
});

Deno.test("consumeCanonicalEdges: edges clear exactly once; held preserved", () => {
  const before = normalizeCanonicalInput({
    forward: true,
    sprint: true,
    yaw: 1.1,
    pitch: 0.2,
    jump: true,
    meleeLunge: true,
    reload: true,
    weaponSelect: WEAPON_RIFLE,
    ability: "quick",
    fire: {
      kind: "shoot",
      yaw: 1.1,
      pitch: 0.2,
      clientTick: 10,
    },
  });
  const after = consumeCanonicalEdges(before);
  assertEquals(after.forward, true);
  assertEquals(after.sprint, true);
  assertEquals(after.yaw, before.yaw);
  assertEquals(after.pitch, before.pitch);
  assertEquals(after.jump, false);
  assertEquals(after.meleeLunge, false);
  assertEquals(after.reload, false);
  assertEquals(after.weaponSelect, null);
  assertEquals(after.ability, null);
  assertEquals(after.fire, null);
  // Second consume is idempotent on edges.
  assertEquals(consumeCanonicalEdges(after).jump, false);
  assertEquals(consumeCanonicalEdges(after).fire, null);
});

Deno.test("toMoveInput: projects move + jump/meleeLunge; omits pitch/fire", () => {
  const input = normalizeCanonicalInput({
    forward: true,
    left: true,
    jump: true,
    meleeLunge: true,
    yaw: 0.75,
    pitch: 0.3,
    fire: { kind: "shoot", yaw: 0.75, pitch: 0.3 },
  });
  assertEquals(toMoveInput(input), {
    forward: true,
    backward: false,
    left: true,
    right: false,
    jump: true,
    sprint: false,
    crouch: false,
    meleeLunge: true,
    yaw: 0.75,
  });
});

Deno.test("projectCanonicalHandlerCalls: apply order + representative table", () => {
  assertEquals([...CANONICAL_APPLY_ORDER], [
    "input",
    "weapon",
    "reload",
    "shoot",
    "ability",
  ]);

  const cases: Array<{
    name: string;
    input: CanonicalPlayerInput;
    kinds: string[];
  }> = [
    {
      name: "all-keys held",
      input: normalizeCanonicalInput({
        forward: true,
        backward: true,
        left: true,
        right: true,
        sprint: true,
        crouch: true,
        yaw: 0.1,
        pitch: -0.1,
      }),
      kinds: ["input"],
    },
    {
      name: "jump edge",
      input: normalizeCanonicalInput({ jump: true, yaw: 0 }),
      kinds: ["input"],
    },
    {
      name: "slide entry (crouch held)",
      input: normalizeCanonicalInput({ crouch: true, forward: true }),
      kinds: ["input"],
    },
    {
      name: "fire-with-aim",
      input: normalizeCanonicalInput({
        yaw: 1,
        pitch: 0.2,
        fire: {
          kind: "shoot",
          yaw: 1,
          pitch: 0.2,
          origin: [0, 1.6, 0],
          clientTick: 100,
          lastAppliedSnapshotTick: 99,
        },
      }),
      kinds: ["input", "shoot"],
    },
    {
      name: "reload-during-switch",
      input: normalizeCanonicalInput({
        reload: true,
        weaponSelect: WEAPON_RIFLE,
      }),
      kinds: ["input", "weapon", "reload"],
    },
    {
      name: "ability activate",
      input: normalizeCanonicalInput({ ability: "teleport" }),
      kinds: ["input", "ability"],
    },
    {
      name: "dead-player look (held only)",
      input: normalizeCanonicalInput({ yaw: 2.2, pitch: -0.4 }),
      kinds: ["input"],
    },
    {
      name: "full edge stack",
      input: normalizeCanonicalInput({
        forward: true,
        jump: true,
        weaponSelect: WEAPON_PISTOL,
        reload: true,
        fire: { kind: "melee", yaw: 0, pitch: 0 },
        ability: "quick",
      }),
      kinds: ["input", "weapon", "reload", "melee", "ability"],
    },
  ];

  for (const c of cases) {
    const calls = projectCanonicalHandlerCalls(c.input);
    assertEquals(
      calls.map((x) => x.kind),
      c.kinds,
      c.name,
    );
    // input step always carries MoveInput projection
    const inputCall = calls[0];
    assertEquals(inputCall?.kind, "input");
    if (inputCall?.kind === "input") {
      assertEquals(inputCall.move, toMoveInput(c.input));
      assertEquals(inputCall.yaw, c.input.yaw);
      assertEquals(inputCall.pitch, c.input.pitch);
    }
  }
});

Deno.test("JSON round-trip preserves normalized canonical input", () => {
  const input = normalizeCanonicalInput({
    forward: true,
    yaw: 3.5,
    pitch: 1.2,
    jump: true,
    fire: {
      kind: "shoot",
      yaw: 3.5,
      pitch: 1.2,
      origin: [1, 2, 3],
      clientTick: 7,
    },
    weaponSelect: WEAPON_RIFLE,
    ability: "glitch",
  });
  const roundTripped = normalizeCanonicalInput(
    JSON.parse(JSON.stringify(input)),
  );
  assertEquals(roundTripped, input);
});

Deno.test("equivalence: wire parts → canonical → handler calls match direct dispatch", () => {
  // Simulate today's split channels assembling one tick of intent.
  const wireMove = {
    sequence: 42, // ignored by canonical (5.2)
    forward: true,
    backward: false,
    left: false,
    right: true,
    jump: true,
    sprint: false,
    crouch: false,
    meleeLunge: false,
    yaw: 0.8,
    pitch: 0.15,
  };
  const wireShoot = {
    yaw: 0.8,
    pitch: 0.15,
    origin: [0.1, 1.5, -0.2] as [number, number, number],
    sequence: 42,
    clientTick: 200,
    lastAppliedSnapshotTick: 198,
  };
  const wireWeapon = 1; // rifle
  const wireReload = true;
  const wireAbility = "quick";

  const canonical = canonicalFromWireParts({
    input: wireMove,
    shoot: wireShoot,
    reload: wireReload,
    weapon: wireWeapon,
    ability: wireAbility,
  });
  const viaShim = projectCanonicalHandlerCalls(canonical);

  // Direct dispatch kinds (what live code would call today), in apply order.
  assertEquals(viaShim.map((c) => c.kind), [
    "input",
    "weapon",
    "reload",
    "shoot",
    "ability",
  ]);
  assertEquals(viaShim[1], { kind: "weapon", weapon: wireWeapon });
  assertEquals(viaShim[2], { kind: "reload" });
  assertEquals(viaShim[4], { kind: "ability", ability: wireAbility });
  const shoot = viaShim[3];
  assertEquals(shoot?.kind, "shoot");
  if (shoot?.kind === "shoot") {
    assertEquals(shoot.packet, toFirePacket(canonical.fire!));
    assertEquals(shoot.packet.yaw, wireShoot.yaw);
    assertEquals(shoot.packet.clientTick, wireShoot.clientTick);
  }
  // Sequence never appears on canonical / projections.
  assertEquals("sequence" in canonical, false);
  assertNotEquals(wireMove.sequence, undefined);
});

Deno.test("equivalence: melee wire maps to melee handler slot, not shoot", () => {
  const canonical = canonicalFromWireParts({
    input: { yaw: 0, pitch: 0 },
    melee: { yaw: 0.2, pitch: -0.1, clientTick: 5 },
  });
  const calls = projectCanonicalHandlerCalls(canonical);
  assertEquals(calls.map((c) => c.kind), ["input", "melee"]);
  assertEquals(canonical.fire?.kind, "melee");
});
