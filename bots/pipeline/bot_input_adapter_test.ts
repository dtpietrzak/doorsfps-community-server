/**
 * Characterization + equivalence for epic 5.4 bot input adapter.
 * Run: deno test -A --unstable-net --node-modules-dir=manual bots/pipeline/bot_input_adapter_test.ts
 */
import { assertEquals } from "@std/assert";
import {
  LAG_COMP_MAX_REWIND_TICKS,
  type PlayerInput,
  SNAPSHOT_EVERY_TICKS,
} from "../../protocol/network.ts";
import { resolveLagCompWindow } from "../../combat/lagComp.ts";
import type { SkillId } from "../../shared/sim/skills.ts";
import { SIM_TICKS_PER_BOT_TICK } from "../types.ts";
import type { BotApplyInterp } from "../types.ts";
import {
  beginApplyInterp,
  botInterpAlpha,
  buildInterpolatedReadyAction,
  lerpAngle,
  lerpPitch,
  lookFromAction,
} from "./botInterp.ts";
import {
  botLagCompStamps,
  buildAbilityIntent,
  buildReloadIntent,
  buildShootAimSnapshot,
  buildWeaponSwitchIntent,
  dropInterpOnSpawn,
  nextBotSequence,
  normalizeReadyAction,
  normalizeThinkInput,
  sampleTickAction,
  stampBotInput,
} from "./botInputAdapter.ts";
import type { ReadyAction } from "./types.ts";

function baseInput(overrides: Partial<PlayerInput> = {}): PlayerInput {
  return {
    sequence: 0,
    forward: false,
    backward: false,
    left: false,
    right: false,
    jump: false,
    sprint: false,
    crouch: false,
    yaw: 0,
    pitch: 0,
    ...overrides,
  };
}

function moveAction(
  yaw: number,
  keys: Partial<PlayerInput> = {},
  edges: Partial<ReadyAction> = {},
): ReadyAction {
  return {
    input: baseInput({ forward: true, yaw, ...keys }),
    ...edges,
  };
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

Deno.test("normalizeThinkInput strips placeholder sequence", () => {
  const n = normalizeThinkInput(baseInput({ sequence: 99, yaw: 1, pitch: 0.1 }));
  assertEquals(n.sequence, 0);
  assertEquals(n.yaw, 1);
  assertEquals(n.pitch, 0.1);
});

Deno.test("normalizeThinkInput: crouch suppresses sprint", () => {
  const n = normalizeThinkInput(
    baseInput({ sprint: true, crouch: true, yaw: 0.5 }),
  );
  assertEquals(n.crouch, true);
  assertEquals(n.sprint, false);
});

Deno.test("normalizeThinkInput: finite-number enforcement on look", () => {
  const n = normalizeThinkInput(
    baseInput({ yaw: Number.NaN, pitch: Number.POSITIVE_INFINITY }),
    { yaw: 1.5, pitch: -0.2 },
  );
  assertEquals(n.yaw, 1.5);
  assertEquals(n.pitch, -0.2);
});

Deno.test("normalizeThinkInput: meleeLunge passes through (default absent)", () => {
  const plain = normalizeThinkInput(baseInput({ yaw: 0 }));
  assertEquals(plain.meleeLunge, undefined);
  const armed = normalizeThinkInput(baseInput({ yaw: 0, meleeLunge: true }));
  assertEquals(armed.meleeLunge, true);
});

Deno.test("normalizeReadyAction normalizes input and keeps edges", () => {
  const n = normalizeReadyAction({
    input: baseInput({ sequence: 7, sprint: true, crouch: true, yaw: 2 }),
    shoot: true,
    reload: true,
    weapon: 2,
    ability: "quick" as SkillId,
  });
  assertEquals(n.input?.sequence, 0);
  assertEquals(n.input?.sprint, false);
  assertEquals(n.shoot, true);
  assertEquals(n.reload, true);
  assertEquals(n.weapon, 2);
  assertEquals(n.ability, "quick");
});

// ---------------------------------------------------------------------------
// Sequence ownership
// ---------------------------------------------------------------------------

Deno.test("monotonic sequence across stamped inputs", () => {
  const state = { sequence: 0 };
  assertEquals(nextBotSequence(state), 1);
  const stamped = stampBotInput(state, baseInput({ forward: true, yaw: 0.3 }));
  assertEquals(stamped.sequence, 2);
  assertEquals(stamped.forward, true);
  assertEquals(state.sequence, 2);
});

// ---------------------------------------------------------------------------
// Interp / edge-once / key hold (via sampleTickAction)
// ---------------------------------------------------------------------------

Deno.test("sampleTickAction: key hold from curr across a bot period", () => {
  const due = moveAction(1.0, { forward: true, left: true, sprint: true }, {
    shoot: true,
  });
  let interp: BotApplyInterp | null = null;
  const start = 9;

  const t0 = sampleTickAction({
    simTick: start,
    dueAction: due,
    applyInterp: interp,
    selfLook: { yaw: 0, pitch: 0 },
  });
  interp = t0.applyInterp;
  assertEquals(t0.action?.input?.forward, true);
  assertEquals(t0.action?.input?.left, true);
  assertEquals(t0.action?.shoot, true);
  assertEquals(t0.releasedCurr?.input?.forward, true);

  const t1 = sampleTickAction({
    simTick: start + 1,
    dueAction: null,
    applyInterp: interp,
    selfLook: { yaw: 0, pitch: 0 },
  });
  assertEquals(t1.action?.input?.forward, true);
  assertEquals(t1.action?.input?.left, true);
  assertEquals(t1.action?.shoot, false, "combat edge only once");
  assertEquals(t1.releasedCurr, null);
});

Deno.test("sampleTickAction: yaw shortest-path + pitch linear equal botInterp", () => {
  const curr: ReadyAction = moveAction(1.0, { pitch: 0.2 });
  const start = 9;
  const legacyInterp = beginApplyInterp({ yaw: 0, pitch: 0 }, curr, start);
  const legacy = buildInterpolatedReadyAction(legacyInterp, start);

  const adapted = sampleTickAction({
    simTick: start,
    dueAction: curr,
    applyInterp: null,
    selfLook: { yaw: 0, pitch: 0 },
  });

  assertEquals(adapted.action?.input?.yaw, legacy.input?.yaw);
  assertEquals(adapted.action?.input?.pitch, legacy.input?.pitch);
  assertEquals(
    Math.abs((adapted.action?.input?.yaw ?? 0) - lerpAngle(0, 1, botInterpAlpha(start, start))) <
      1e-12,
    true,
  );
  assertEquals(
    Math.abs(
      (adapted.action?.input?.pitch ?? 0) -
        lerpPitch(0, 0.2, botInterpAlpha(start, start)),
    ) < 1e-12,
    true,
  );
});

Deno.test("sampleTickAction: alpha equals (elapsed+1)/N; last tick reaches 1", () => {
  const due = moveAction(Math.PI);
  let interp: BotApplyInterp | null = null;
  const start = 6;
  let lastYaw = 0;

  for (let i = 0; i < SIM_TICKS_PER_BOT_TICK; i++) {
    const r = sampleTickAction({
      simTick: start + i,
      dueAction: i === 0 ? due : null,
      applyInterp: interp,
      selfLook: { yaw: 0, pitch: 0 },
    });
    interp = r.applyInterp;
    lastYaw = r.action?.input?.yaw ?? 0;
    assertEquals(
      botInterpAlpha(start + i, start),
      Math.min(1, (i + 1) / SIM_TICKS_PER_BOT_TICK),
    );
  }
  assertEquals(Math.abs(lastYaw - Math.PI) < 1e-9, true);
});

Deno.test("sampleTickAction: combat edges fire once per slot then hold", () => {
  const due: ReadyAction = {
    input: baseInput({ forward: true, yaw: 0.5 }),
    shoot: true,
    reload: true,
    weapon: 1,
    ability: "quick" as SkillId,
  };
  let interp: BotApplyInterp | null = null;
  const a0 = sampleTickAction({
    simTick: 3,
    dueAction: due,
    applyInterp: interp,
    selfLook: { yaw: 0, pitch: 0 },
  });
  interp = a0.applyInterp;
  assertEquals(a0.action?.shoot, true);
  assertEquals(a0.action?.reload, true);
  assertEquals(a0.action?.weapon, 1);
  assertEquals(a0.action?.ability, "quick");

  const a1 = sampleTickAction({
    simTick: 4,
    dueAction: null,
    applyInterp: interp,
    selfLook: { yaw: 0, pitch: 0 },
  });
  assertEquals(a1.action?.shoot, false);
  assertEquals(a1.action?.reload, false);
  assertEquals(a1.action?.weapon, undefined);
  assertEquals(a1.action?.ability, undefined);
  assertEquals(a1.action?.input?.forward, true);
});

Deno.test("sampleTickAction: empty buffer holds without inventing keys", () => {
  const r = sampleTickAction({
    simTick: 10,
    dueAction: null,
    applyInterp: null,
    selfLook: { yaw: 1, pitch: 0 },
  });
  assertEquals(r.action, null);
  assertEquals(r.applyInterp, null);
  assertEquals(r.releasedCurr, null);
});

Deno.test("dropInterpOnSpawn clears held WASD path", () => {
  assertEquals(dropInterpOnSpawn(), null);
  const afterSpawn = sampleTickAction({
    simTick: 20,
    dueAction: null,
    applyInterp: dropInterpOnSpawn(),
    selfLook: { yaw: 0, pitch: 0 },
  });
  assertEquals(afterSpawn.action, null);
});

// ---------------------------------------------------------------------------
// Shoot aim / discrete intents
// ---------------------------------------------------------------------------

Deno.test("sampleTickAction: plays per-tick look samples and holds the last", () => {
  const due: ReadyAction = {
    input: baseInput({ forward: true, yaw: 0.9, pitch: -0.3 }),
    lookSamples: [
      { yaw: 0.1, pitch: -0.05 },
      { yaw: 0.5, pitch: -0.2 },
      { yaw: 0.9, pitch: -0.3 },
    ],
    shoot: true,
  };
  const start = 30;
  let interp: BotApplyInterp | null = null;
  const looks: Array<{ yaw: number; pitch: number }> = [];
  const shots: boolean[] = [];
  for (let k = 0; k < SIM_TICKS_PER_BOT_TICK + 2; k++) {
    const sampled = sampleTickAction({
      simTick: start + k,
      dueAction: k === 0 ? due : null,
      applyInterp: interp,
      selfLook: { yaw: -2, pitch: 0.4 },
    });
    interp = sampled.applyInterp;
    looks.push({
      yaw: sampled.action!.input!.yaw,
      pitch: sampled.action!.input!.pitch,
    });
    shots.push(sampled.action!.shoot === true);
  }
  assertEquals(looks, [
    { yaw: 0.1, pitch: -0.05 },
    { yaw: 0.5, pitch: -0.2 },
    { yaw: 0.9, pitch: -0.3 },
    { yaw: 0.9, pitch: -0.3 },
    { yaw: 0.9, pitch: -0.3 },
  ]);
  // Shot fires on the release tick with that tick's look.
  assertEquals(shots, [true, false, false, false, false]);
  // Next slot without samples lerps from this slot's final look.
  const next = sampleTickAction({
    simTick: start + 6,
    dueAction: moveAction(1.2, { pitch: -0.3 }),
    applyInterp: interp,
    selfLook: { yaw: -2, pitch: 0.4 },
  });
  assertEquals(
    Math.abs(next.action!.input!.yaw - lerpAngle(0.9, 1.2, 1 / 3)) < 1e-12,
    true,
  );
});

Deno.test("normalizeReadyAction: look samples pin to the final look", () => {
  const normalized = normalizeReadyAction({
    input: baseInput({ yaw: 0.6, pitch: 0.1 }),
    lookSamples: [
      { yaw: Number.NaN, pitch: 0.02 },
      { yaw: 0.4, pitch: Number.POSITIVE_INFINITY },
      { yaw: 0.61, pitch: 0.11 },
    ],
  });
  assertEquals(normalized.lookSamples, [
    { yaw: 0.6, pitch: 0.02 },
    { yaw: 0.4, pitch: 0.1 },
    { yaw: 0.6, pitch: 0.1 },
  ]);

  const noInput = normalizeReadyAction({
    input: null,
    lookSamples: [{ yaw: 1, pitch: 0 }],
  });
  assertEquals("lookSamples" in noInput, false);
  assertEquals(
    "lookSamples" in normalizeReadyAction({ input: baseInput() }),
    false,
  );
});

Deno.test("shoot aim falls back to self yaw/pitch on null input", () => {
  const withInput = buildShootAimSnapshot(
    { input: baseInput({ yaw: 0.7, pitch: -0.1 }), shoot: true },
    { yaw: 9, pitch: 9 },
    42,
  );
  assertEquals(withInput, {
    yaw: 0.7,
    pitch: -0.1,
    ...botLagCompStamps(42),
  });

  const fallback = buildShootAimSnapshot(
    { input: null, shoot: true },
    { yaw: 1.2, pitch: 0.3 },
    7,
  );
  assertEquals(fallback, { yaw: 1.2, pitch: 0.3, ...botLagCompStamps(7) });
});

Deno.test("shoot aim stamps the think's observed tick, not the apply tick", () => {
  const aim = buildShootAimSnapshot(
    { input: null, shoot: true, observedTick: 100 },
    { yaw: 0, pitch: 0 },
    112,
  );
  assertEquals(aim.clientTick, 100);
  assertEquals(aim.lastAppliedSnapshotTick, botLagCompStamps(100).lastAppliedSnapshotTick);
});

Deno.test("botLagCompStamps resolve to the observed tick through the human RTT window", () => {
  // Bots have no pongs: unknown-RTT band. Apply lands 7–9 sim ticks after
  // think (3 bot-tick buffer, phase-aligned); allow a few skipped ticks more.
  // Beyond that the snapshot claim ages out and the window clamps (see below).
  for (let observed = 30; observed < 60; observed++) {
    for (let applyDelay = 7; applyDelay <= 12; applyDelay++) {
      const simTick = observed + applyDelay;
      const lastSnap = simTick - (simTick % SNAPSHOT_EVERY_TICKS);
      const stamps = botLagCompStamps(observed);
      const window = resolveLagCompWindow({
        simTick,
        clientTick: stamps.clientTick,
        lastSnapTick: lastSnap,
        lastAppliedSnapshotTick: stamps.lastAppliedSnapshotTick,
        pingReady: false,
      });
      assertEquals(
        [window.tick, window.clamped],
        [observed, false],
        `observed=${observed} simTick=${simTick}`,
      );
    }
  }
});

Deno.test("botLagCompStamps: stale think world is clamped like a human's", () => {
  const simTick = 200;
  const stamps = botLagCompStamps(simTick - 60);
  const window = resolveLagCompWindow({
    simTick,
    clientTick: stamps.clientTick,
    lastSnapTick: simTick - (simTick % SNAPSHOT_EVERY_TICKS),
    lastAppliedSnapshotTick: stamps.lastAppliedSnapshotTick,
    pingReady: false,
  });
  assertEquals(window.clamped, true);
  assertEquals(window.tick >= simTick - LAG_COMP_MAX_REWIND_TICKS, true);
});

Deno.test("sampleTickAction carries observedTick through normalize + interp", () => {
  const sampled = sampleTickAction({
    simTick: 30,
    dueAction: { input: baseInput({}), shoot: true, observedTick: 18 },
    applyInterp: null,
    selfLook: { yaw: 0, pitch: 0 },
  });
  assertEquals(sampled.action?.observedTick, 18);
  assertEquals(sampled.releasedCurr?.observedTick, 18);
});

Deno.test("discrete action intent constructors are pipe-shaped", () => {
  assertEquals(buildReloadIntent(), { kind: "reload" });
  assertEquals(buildWeaponSwitchIntent(2), { weapon: 2 });
  assertEquals(buildAbilityIntent("quick" as SkillId), { ability: "quick" });
});

// ---------------------------------------------------------------------------
// Equivalence: legacy inline applyReadyActions conversion vs adapter
// ---------------------------------------------------------------------------

type HandleCall =
  | { kind: "input"; sequence: number; input: PlayerInput }
  | { kind: "shoot"; yaw: number; pitch: number; clientTick: number }
  | { kind: "reload"; tick: number }
  | { kind: "weapon"; weapon: number; tick: number }
  | { kind: "ability"; ability: SkillId; tick: number };

/**
 * Legacy inline conversion (pre-adapter applyReadyActions body) for one bot
 * over scripted due-slot releases. Oracle for handle*-stream equivalence.
 */
function legacySampleStream(
  steps: Array<{
    simTick: number;
    dueAction: ReadyAction | null;
    spawnDrop?: boolean;
  }>,
  selfLook: { yaw: number; pitch: number },
): { calls: HandleCall[]; sequences: number[] } {
  const calls: HandleCall[] = [];
  let applyInterp: BotApplyInterp | null = null;
  let sequence = 0;
  const sequences: number[] = [];

  for (const step of steps) {
    if (step.spawnDrop) {
      applyInterp = null;
    }

    if (step.dueAction !== null) {
      const prevLook = applyInterp
        ? lookFromAction(applyInterp.curr, selfLook)
        : selfLook;
      const curr: ReadyAction = step.dueAction;
      applyInterp = beginApplyInterp(prevLook, curr, step.simTick);
    }

    let action: ReadyAction | null = null;
    if (applyInterp) {
      action = buildInterpolatedReadyAction(applyInterp, step.simTick);
      applyInterp.combatEdgeDone = true;
    }

    if (!action) continue;

    // stampAndInput
    if (action.input) {
      sequence += 1;
      const input = { ...action.input, sequence };
      calls.push({ kind: "input", sequence, input });
      sequences.push(sequence);
    }
    if (typeof action.weapon === "number") {
      calls.push({ kind: "weapon", weapon: action.weapon, tick: step.simTick });
    }
    if (action.reload) {
      calls.push({ kind: "reload", tick: step.simTick });
    }
    if (action.shoot) {
      const yaw = action.input?.yaw ?? selfLook.yaw;
      const pitch = action.input?.pitch ?? selfLook.pitch;
      calls.push({
        kind: "shoot",
        yaw,
        pitch,
        clientTick: step.simTick,
      });
    }
    if (action.ability != null) {
      calls.push({
        kind: "ability",
        ability: action.ability,
        tick: step.simTick,
      });
    }
  }

  return { calls, sequences };
}

function adaptedSampleStream(
  steps: Array<{
    simTick: number;
    dueAction: ReadyAction | null;
    spawnDrop?: boolean;
  }>,
  selfLook: { yaw: number; pitch: number },
): { calls: HandleCall[]; sequences: number[] } {
  const calls: HandleCall[] = [];
  let applyInterp: BotApplyInterp | null = null;
  const state = { sequence: 0 };
  const sequences: number[] = [];

  for (const step of steps) {
    if (step.spawnDrop) {
      applyInterp = dropInterpOnSpawn();
    }

    const sampled = sampleTickAction({
      simTick: step.simTick,
      dueAction: step.dueAction,
      applyInterp,
      selfLook,
    });
    applyInterp = sampled.applyInterp;

    const action = sampled.action;
    if (!action) continue;

    if (action.input) {
      const input = stampBotInput(state, action.input);
      calls.push({ kind: "input", sequence: input.sequence, input });
      sequences.push(input.sequence);
    }
    if (typeof action.weapon === "number") {
      calls.push({ kind: "weapon", weapon: action.weapon, tick: step.simTick });
    }
    if (action.reload) {
      calls.push({ kind: "reload", tick: step.simTick });
    }
    if (action.shoot) {
      const aim = buildShootAimSnapshot(action, selfLook, step.simTick);
      calls.push({
        kind: "shoot",
        yaw: aim.yaw,
        pitch: aim.pitch,
        clientTick: aim.clientTick,
      });
    }
    if (action.ability != null) {
      calls.push({
        kind: "ability",
        ability: action.ability,
        tick: step.simTick,
      });
    }
  }

  return { calls, sequences };
}

Deno.test("equivalence: scripted ReadyAction streams match legacy handle* calls", () => {
  const selfLook = { yaw: 0.1, pitch: -0.05 };
  const steps = [
    // Chord + combat edges on first slot
    {
      simTick: 9,
      dueAction: {
        input: baseInput({
          forward: true,
          left: true,
          sprint: true,
          yaw: 1.0,
          pitch: 0.2,
        }),
        shoot: true,
        reload: true,
        weapon: 1,
        ability: "quick" as SkillId,
      },
    },
    // Hold across remaining bot period
    { simTick: 10, dueAction: null },
    { simTick: 11, dueAction: null },
    // Null-idle gap (no interp left after we don't start new — still holding)
    {
      simTick: 12,
      dueAction: moveAction(0.5, { forward: true, jump: true }, { shoot: true }),
    },
    { simTick: 13, dueAction: null },
    // Spawn drop then new life slot
    {
      simTick: 15,
      dueAction: moveAction(-0.3, { right: true }),
      spawnDrop: true,
    },
    { simTick: 16, dueAction: null },
    { simTick: 17, dueAction: null },
    { simTick: 18, dueAction: null },
  ];

  const legacy = legacySampleStream(steps, selfLook);
  const adapted = adaptedSampleStream(steps, selfLook);
  assertEquals(adapted.calls, legacy.calls);
  assertEquals(adapted.sequences, legacy.sequences);
});

Deno.test("equivalence: multi-due skip uses latest released action only", () => {
  // Caller releases latest-due-wins already; adapter sees one dueAction.
  const selfLook = { yaw: 0, pitch: 0 };
  const steps = [
    {
      simTick: 30,
      dueAction: moveAction(2.0, { forward: true }, { shoot: true }),
    },
    { simTick: 31, dueAction: null },
    { simTick: 32, dueAction: null },
  ];
  const legacy = legacySampleStream(steps, selfLook);
  const adapted = adaptedSampleStream(steps, selfLook);
  assertEquals(adapted.calls, legacy.calls);
});
