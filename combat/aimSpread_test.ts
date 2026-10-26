import {
  assertAlmostEquals,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  aimSpreadDegForWeapon,
  WEAPON_PISTOL,
  WEAPON_RIFLE,
} from "../shared/sim/weapons.ts";
import {
  aimSpreadRad,
  aimSpreadStance,
  applyAimSpread,
  crosshairSpreadMult,
  spreadDirectionFromYawPitch,
} from "./aimSpread.ts";
import { normalize } from "./hitscan.ts";

const still = {
  onGround: true,
  crouch: false,
  moving: false,
  sprint: false,
  sliding: false,
} as const;

const walk = {
  onGround: true,
  crouch: false,
  moving: true,
  sprint: false,
  sliding: false,
} as const;

const sprint = {
  onGround: true,
  crouch: false,
  moving: true,
  sprint: true,
  sliding: false,
} as const;

const air = {
  onGround: false,
  crouch: false,
  moving: false,
  sprint: false,
  sliding: false,
} as const;

function degToRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

Deno.test("stance: crouch and still use baseline", () => {
  assertEquals(
    aimSpreadStance({
      onGround: true,
      crouch: true,
      moving: true,
      sprint: true,
      sliding: false,
    }),
    "still",
  );
  assertEquals(
    aimSpreadStance({
      onGround: true,
      crouch: false,
      moving: false,
      sprint: false,
    }),
    "still",
  );
  assertEquals(aimSpreadRad(still, WEAPON_RIFLE), 0);
  assertEquals(
    crosshairSpreadMult({
      onGround: true,
      crouch: true,
      moving: true,
      sprint: false,
      sliding: false,
    }, WEAPON_RIFLE),
    1,
  );
});

Deno.test("stance: sliding uses air bloom even while crouching on ground", () => {
  assertEquals(
    aimSpreadStance({
      onGround: true,
      crouch: true,
      moving: true,
      sprint: false,
      sliding: true,
    }),
    "air",
  );
  assertAlmostEquals(
    crosshairSpreadMult({
      onGround: true,
      crouch: true,
      moving: true,
      sprint: false,
      sliding: true,
    }, WEAPON_RIFLE),
    1 + 3.2 / 1.15,
    1e-9,
  );
});

Deno.test("stance: walk / sprint / air escalate for rifle", () => {
  assertEquals(aimSpreadStance(walk), "walk");
  assertEquals(crosshairSpreadMult(walk, WEAPON_RIFLE), 2);
  assertEquals(aimSpreadStance(sprint), "sprint");
  assertAlmostEquals(
    crosshairSpreadMult(sprint, WEAPON_RIFLE),
    1 + 2.0 / 1.15,
    1e-9,
  );
  assertEquals(aimSpreadStance(air), "air");
  assertAlmostEquals(
    crosshairSpreadMult(air, WEAPON_RIFLE),
    1 + 3.2 / 1.15,
    1e-9,
  );
  // Air beats crouch (you're in the air).
  assertEquals(
    aimSpreadStance({
      onGround: false,
      crouch: true,
      moving: false,
      sprint: false,
    }),
    "air",
  );
});

Deno.test("pistol: looser still, flatter sprint/air than rifle", () => {
  const pistolStill = aimSpreadDegForWeapon(WEAPON_PISTOL, "still");
  const rifleStill = aimSpreadDegForWeapon(WEAPON_RIFLE, "still");
  const pistolSprint = aimSpreadDegForWeapon(WEAPON_PISTOL, "sprint");
  const rifleSprint = aimSpreadDegForWeapon(WEAPON_RIFLE, "sprint");
  const pistolAir = aimSpreadDegForWeapon(WEAPON_PISTOL, "air");
  const rifleAir = aimSpreadDegForWeapon(WEAPON_RIFLE, "air");

  assertEquals(pistolStill > rifleStill, true);
  assertEquals(pistolSprint < rifleSprint, true);
  assertEquals(pistolAir < rifleAir, true);

  assertAlmostEquals(
    aimSpreadRad(still, WEAPON_PISTOL),
    degToRad(pistolStill),
    1e-12,
  );
  assertAlmostEquals(
    aimSpreadRad(sprint, WEAPON_PISTOL),
    degToRad(pistolSprint),
    1e-12,
  );
  assertAlmostEquals(
    aimSpreadRad(air, WEAPON_PISTOL),
    degToRad(pistolAir),
    1e-12,
  );

  // Crosshair grows only above still cone — pistol still stays 1× base ring.
  assertEquals(crosshairSpreadMult(still, WEAPON_PISTOL), 1);
  assertAlmostEquals(
    crosshairSpreadMult(air, WEAPON_PISTOL),
    1 + (pistolAir - pistolStill) / 1.15,
    1e-9,
  );
  assertEquals(
    crosshairSpreadMult(air, WEAPON_PISTOL) <
      crosshairSpreadMult(air, WEAPON_RIFLE),
    true,
  );
});

Deno.test("rifle aim rad matches legacy table", () => {
  assertEquals(aimSpreadRad(still, WEAPON_RIFLE), 0);
  assertAlmostEquals(aimSpreadRad(walk, WEAPON_RIFLE), degToRad(1.15), 1e-12);
  assertAlmostEquals(aimSpreadRad(sprint, WEAPON_RIFLE), degToRad(2.0), 1e-12);
  assertAlmostEquals(aimSpreadRad(air, WEAPON_RIFLE), degToRad(3.2), 1e-12);
});

Deno.test("applyAimSpread zero angle is identity", () => {
  const d = normalize({ x: 0, y: 0, z: -1 });
  const out = applyAimSpread(d, 0, () => 0.5);
  assertAlmostEquals(out.x, 0, 1e-9);
  assertAlmostEquals(out.y, 0, 1e-9);
  assertAlmostEquals(out.z, -1, 1e-9);
});

Deno.test("perfectAccuracy: 0 cone and still-size crosshair mult", () => {
  // Without flag: air bloom is non-zero and crosshair grows.
  assertEquals(aimSpreadRad(air, WEAPON_RIFLE) > 0, true);
  assertEquals(crosshairSpreadMult(air, WEAPON_RIFLE) > 1, true);

  // Hawkeyes: laser accuracy + minimum ring regardless of stance.
  assertEquals(aimSpreadRad(air, WEAPON_RIFLE, { perfectAccuracy: true }), 0);
  assertEquals(
    aimSpreadRad(sprint, WEAPON_RIFLE, { perfectAccuracy: true }),
    0,
  );
  assertEquals(aimSpreadRad(walk, WEAPON_PISTOL, { perfectAccuracy: true }), 0);
  assertEquals(
    crosshairSpreadMult(air, WEAPON_RIFLE, { perfectAccuracy: true }),
    1,
  );
  assertEquals(
    crosshairSpreadMult(sprint, WEAPON_PISTOL, { perfectAccuracy: true }),
    1,
  );
});

Deno.test("applyAimSpread stays near aim and unit length", () => {
  const d = normalize({ x: 0, y: 0, z: -1 });
  const max = (2 * Math.PI) / 180;
  let i = 0;
  const seq = [0.1, 0.3, 0.7, 0.9, 0.2, 0.5];
  const rng = () => seq[i++ % seq.length]!;
  for (let n = 0; n < 3; n++) {
    const out = applyAimSpread(d, max, rng);
    const len = Math.hypot(out.x, out.y, out.z);
    assertAlmostEquals(len, 1, 1e-6);
    const dot = out.x * d.x + out.y * d.y + out.z * d.z;
    // angle = acos(dot) ≤ max
    assertEquals(dot >= Math.cos(max) - 1e-6, true);
  }
});

/** Mulberry32 — tiny deterministic PRNG for same-seed reproducibility proofs. */
function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

Deno.test("spreadDirectionFromYawPitch: same seed → bit-identical directions", () => {
  const cases: Array<{
    label: string;
    yaw: number;
    pitch: number;
    weaponId: number;
    state: typeof still | typeof walk | typeof sprint | typeof air;
    perfectAccuracy?: boolean;
  }> = [
    { label: "pistol-still", yaw: 0.2, pitch: -0.1, weaponId: WEAPON_PISTOL, state: still },
    { label: "pistol-walk", yaw: -0.4, pitch: 0.05, weaponId: WEAPON_PISTOL, state: walk },
    { label: "pistol-sprint", yaw: 1.1, pitch: 0.2, weaponId: WEAPON_PISTOL, state: sprint },
    { label: "pistol-air", yaw: -1.2, pitch: -0.3, weaponId: WEAPON_PISTOL, state: air },
    { label: "rifle-still-zero", yaw: 0, pitch: 0, weaponId: WEAPON_RIFLE, state: still },
    { label: "rifle-walk", yaw: 0.5, pitch: 0.1, weaponId: WEAPON_RIFLE, state: walk },
    { label: "rifle-sprint", yaw: -0.7, pitch: -0.15, weaponId: WEAPON_RIFLE, state: sprint },
    { label: "rifle-air", yaw: 0.9, pitch: 0.25, weaponId: WEAPON_RIFLE, state: air },
    {
      label: "hawkeyes-air",
      yaw: 0.3,
      pitch: -0.2,
      weaponId: WEAPON_PISTOL,
      state: air,
      perfectAccuracy: true,
    },
    // Straight up / down exercise the degenerate horizontal basis.
    { label: "look-up", yaw: 0.4, pitch: Math.PI / 2 - 0.02, weaponId: WEAPON_PISTOL, state: walk },
    { label: "look-down", yaw: -0.4, pitch: -Math.PI / 2 + 0.02, weaponId: WEAPON_RIFLE, state: sprint },
  ];

  for (const c of cases) {
    const cone = aimSpreadRad(c.state, c.weaponId, {
      perfectAccuracy: c.perfectAccuracy,
    });
    const run = () => {
      const rng = mulberry32(0xC0FFEE ^ c.label.length * 97);
      return spreadDirectionFromYawPitch(c.yaw, c.pitch, cone, rng);
    };
    const a = run();
    const b = run();
    assertEquals(a.x, b.x, c.label);
    assertEquals(a.y, b.y, c.label);
    assertEquals(a.z, b.z, c.label);
    assertAlmostEquals(Math.hypot(a.x, a.y, a.z), 1, 1e-9);
  }
});

Deno.test("applyAimSpread: open cone consumes exactly two rng samples", () => {
  let calls = 0;
  const rng = () => {
    calls += 1;
    return 0.5;
  };
  applyAimSpread(normalize({ x: 0, y: 0, z: -1 }), (2 * Math.PI) / 180, rng);
  assertEquals(calls, 2);
});

Deno.test("applyAimSpread: zero cone consumes no rng samples", () => {
  let calls = 0;
  applyAimSpread(normalize({ x: 0, y: 0, z: -1 }), 0, () => {
    calls += 1;
    return 0.5;
  });
  assertEquals(calls, 0);
});
