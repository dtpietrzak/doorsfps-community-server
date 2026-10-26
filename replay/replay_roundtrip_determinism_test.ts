/**
 * Record → replay round trip: a live GameServer (fill bots + a scripted human
 * joining mid-match) is recorded through the real ReplayRecorder, loaded from
 * the finalized file, and resimulated by the replay runner. The full 9.1
 * checkpoint state must match live on every tick — from the initial state and
 * from every recorded checkpoint.
 *
 * Drives the sim-relevant body of `startGameLoop` by hand (no sockets, no wall
 * clock). Bot AI is not seeded, so each run plays a different match; the
 * assertion is match-independent.
 *
 * Run from server-community/:
 *   deno test -A --unstable-net --node-modules-dir=manual replay/replay_roundtrip_determinism_test.ts
 */

import { assert, assertEquals, assertExists } from "@std/assert";
import { GameServer } from "../runtime/GameServer.ts";
import { NoopAuthorityAdapter } from "../authority/adapter.ts";
import { drainTickAuthoritativeEvents } from "../players/authoritativeEventSource.ts";
import type { PlayerManager } from "../players/PlayerManager.ts";
import type { SimTickResult } from "../players/simTickResult.ts";
import type { SimIngressSinks } from "../players/simIngress.ts";
import type { PendingWeapon } from "../players/weaponsQueue.ts";
import type { AuthoritativeEvent } from "../shared/sim/authoritativeEvent.ts";
import type { ReplayIntegrationSink } from "./replayIntegration.ts";
import { loadMapBundle } from "../world/loadMap.ts";
import {
  type AuthoritativeCheckpoint,
  captureCheckpointState,
} from "./authoritativeCheckpoint.ts";
import type { ReplayRecorder } from "./ReplayRecorder.ts";
import { loadReplay } from "./replayLoader.ts";
import { createReplayRunner } from "./replaySimulationRunner.ts";
import { settleRecorder, wireReplayRecorder } from "./replayTestHarness.ts";

const MAP_PATH = new URL("../maps/competitive/ElijahMap.doors.json", import.meta.url)
  .pathname;
const HUMAN_ID = "human-sock";
const HUMAN_AT_TICK = 180;
const MATCH_SECONDS = 60;

type ServerInternals = {
  players: PlayerManager;
  sessions: unknown;
  runtimeMatchId: string;
  maxPlayers: number;
  lastSimNowMs: number;
  replayRecorder: ReplayRecorder | null;
  replaySink: ReplayIntegrationSink | null;
  pendingReplayMatchEnd: unknown;
  bots: {
    reconcile(maxPlayers: number): void;
    thinkAll(tick: number, collision: unknown): void;
  };
  stepSim(tick: number, nowMs: number): SimTickResult;
  deliverReplayIntegrationTick(
    tick: number,
    events: ReadonlyArray<AuthoritativeEvent>,
  ): void;
  flushPendingReplayMatchEnd(tick: number): void;
  emitSimTickEvents(tick: number, events: SimTickResult["events"]): void;
  noteReplayHumanPresence(tick?: number): void;
  simIngressSinks(): SimIngressSinks;
};

/** xorshift32 — scripted human only (bots stay unseeded). */
function makeRng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 0x1_0000_0000;
  };
}

function canon(value: unknown): string {
  return JSON.stringify(value, (_k, x) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]]))
      : x);
}

/** First differing field between two checkpoints, or null. */
function firstDiff(
  expected: AuthoritativeCheckpoint,
  actual: AuthoritativeCheckpoint,
  ignorePlayerKeys: ReadonlySet<string> = new Set(),
): string | null {
  const actualById = new Map(actual.players.map((p) => [p.id, p]));
  for (const e of expected.players) {
    const a = actualById.get(e.id);
    if (!a) return `${e.id}: missing in replay`;
    for (const key of Object.keys(e) as (keyof typeof e)[]) {
      if (ignorePlayerKeys.has(key)) continue;
      if (canon(e[key]) !== canon(a[key])) {
        return `${e.id}.${key}: live=${canon(e[key])} replay=${canon(a[key])}`;
      }
    }
  }
  if (actual.players.length !== expected.players.length) {
    return `roster size live=${expected.players.length} replay=${actual.players.length}`;
  }
  for (const key of Object.keys(expected.match) as (keyof typeof expected.match)[]) {
    if (canon(expected.match[key]) !== canon(actual.match[key])) {
      return `match.${key}: live=${canon(expected.match[key])} replay=${canon(actual.match[key])}`;
    }
  }
  // `agents` is the bot director's stream — never drawn by the sim or replay.
  const { agents: _la, ...liveRng } = expected.rng;
  const { agents: _ra, ...replayRng } = actual.rng;
  if (canon(liveRng) !== canon(replayRng)) {
    return `rng: live=${canon(liveRng)} replay=${canon(replayRng)}`;
  }
  return null;
}

async function recordLiveMatch(): Promise<{
  bytes: Uint8Array;
  truth: Map<number, AuthoritativeCheckpoint>;
  collision: Awaited<ReturnType<typeof loadMapBundle>>["collision"];
  blobDir: string;
}> {
  const bundle = await loadMapBundle(MAP_PATH);
  const server = new GameServer({
    name: "replay-roundtrip",
    port: 0,
    host: "127.0.0.1",
    map: bundle.map,
    collision: bundle.collision,
    autofillBots: 6,
    noBotsOnEmptyServer: false,
    joinMode: "open",
    rankedServerId: "open",
    authorityAdapter: new NoopAuthorityAdapter(),
    matchDurationSeconds: MATCH_SECONDS,
  });
  const i = server as unknown as ServerInternals;
  i.sessions = { emit: () => {}, sessions: () => [] };

  const { recorder, blobDir } = wireReplayRecorder(
    {
      attachSink: (sink) => server.attachReplaySink(sink),
      detachSink: () => server.detachReplaySink(),
    },
    {
      checkpointIntervalSeconds: 5,
      captureCheckpointState: (tick, id) =>
        captureCheckpointState(i.players, tick, id),
      captureStartState: (tick, id) =>
        captureCheckpointState(i.players, tick, id, undefined, {
          allowPendingEvents: true,
        }),
    },
  );
  i.replayRecorder = recorder;
  i.bots.reconcile(i.maxPlayers);

  const players = i.players;
  const rng = makeRng(0x5eed_1234);
  const abilities = ["quick", "teleport", "selfHeal", "hawkeyes"] as const;
  let seq = 0;
  let yaw = 0;
  let pitch = 0;
  let keys = {
    forward: true,
    backward: false,
    left: false,
    right: false,
    sprint: false,
    crouch: false,
  };

  // Transport-shaped arrivals between ticks: input packets (0–2), immediates
  // stamped with the last completed tick, deferred shots, RTT samples.
  const scriptHuman = (tick: number, nowMs: number) => {
    const me = players.get(HUMAN_ID);
    if (!me) return;
    const sinks = i.simIngressSinks();
    const arrivalTick = tick - 1;
    if (rng() < 0.05) me.observeRtt(60 + rng() * 80);
    if (rng() < 0.08) {
      keys = {
        forward: rng() < 0.7,
        backward: rng() < 0.1,
        left: rng() < 0.3,
        right: rng() < 0.3,
        sprint: rng() < 0.5,
        crouch: rng() < 0.1,
      };
    }
    yaw += (rng() - 0.5) * 0.3;
    pitch = Math.max(-0.4, Math.min(0.4, pitch + (rng() - 0.5) * 0.05));
    const send = () =>
      sinks.handleInput(HUMAN_ID, {
        sequence: ++seq,
        ...keys,
        jump: rng() < 0.03,
        yaw,
        pitch,
      }, nowMs);
    const r = rng();
    if (r < 0.85) send();
    if (rng() < 0.04) sinks.handleReload(HUMAN_ID, arrivalTick);
    if (rng() < 0.02) {
      sinks.handleWeaponSwitch(HUMAN_ID, rng() < 0.5 ? 0 : 1, arrivalTick);
    }
    if (rng() < 0.02) {
      sinks.handleAbility(
        HUMAN_ID,
        abilities[Math.floor(rng() * abilities.length)]!,
        arrivalTick,
      );
    }
    if (r < 0.15) send();
    if (rng() < 0.12) {
      const shot: PendingWeapon = {
        kind: rng() < 0.1 ? "melee" : "shoot",
        shooterId: HUMAN_ID,
        packet: {
          yaw,
          pitch,
          clientTick: tick - 4 - Math.floor(rng() * 6),
          lastAppliedSnapshotTick: tick - 6,
        },
        volDropPct: rng() < 0.3 ? Math.floor(rng() * 20) : undefined,
      };
      sinks.enqueueHumanWeapon(shot);
    }
  };

  const truth = new Map<number, AuthoritativeCheckpoint>();
  const baseMs = 1_700_000_000_000;
  const maxTicks = MATCH_SECONDS * 60 + 120;
  for (let tick = 1; tick <= maxTicks; tick++) {
    const nowMs = baseMs + tick * (1000 / 60);
    i.lastSimNowMs = nowMs;
    if (tick === HUMAN_AT_TICK) {
      players.add(HUMAN_ID, "human", "B", { ownedAbilities: [...abilities] });
      i.noteReplayHumanPresence(players.tick);
      players.handleSkillLoadout(HUMAN_ID, [...abilities]);
    } else if (tick > HUMAN_AT_TICK) {
      scriptHuman(tick, nowMs);
    }

    const result = i.stepSim(tick, nowMs);
    players.sampleParticipation(nowMs);
    const authEvents = drainTickAuthoritativeEvents(players, tick, result.events);
    i.deliverReplayIntegrationTick(tick, authEvents);
    if (i.replaySink && tick >= HUMAN_AT_TICK) {
      truth.set(
        tick,
        captureCheckpointState(players, tick, i.runtimeMatchId),
      );
    }
    const ending = i.pendingReplayMatchEnd != null;
    i.flushPendingReplayMatchEnd(tick);
    i.emitSimTickEvents(tick, result.events);
    if (tick % 3 === 0) players.createSnapshot(tick);
    i.bots.thinkAll(tick, players.getCollision());
    if (ending || players.isMatchOver()) break;
  }
  await settleRecorder(recorder);

  const file = [...Deno.readDirSync(blobDir!)].find((e) =>
    e.name.endsWith(".replay.json")
  );
  assertExists(file, "finalized replay file");
  return {
    bytes: Deno.readFileSync(`${blobDir}/${file.name}`),
    truth,
    collision: bundle.collision,
    blobDir: blobDir!,
  };
}

/**
 * Bot-think keys-only acceptance (the keys-only note): erase arena
 * bot identity from the recording — every non-agent roster/checkpoint row
 * becomes `isBot: false` and `botAdd` becomes `humanJoin`. Replay must still
 * match live, which only holds once the sim has no `isBot` branch.
 */
function stripArenaBotIdentity(bytes: Uint8Array): Uint8Array {
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const v of value) walk(v);
      return;
    }
    if (!value || typeof value !== "object") return;
    const o = value as Record<string, unknown>;
    if (o.kind === "botAdd") o.kind = "humanJoin";
    if (typeof o.isBot === "boolean" && o.isAgent !== true) o.isBot = false;
    for (const v of Object.values(o)) walk(v);
  };
  const json = JSON.parse(new TextDecoder().decode(bytes));
  walk(json);
  return new TextEncoder().encode(JSON.stringify(json));
}

async function assertRoundTrip(
  opts: { stripBotIdentity: boolean },
): Promise<void> {
  const { bytes, truth, collision, blobDir } = await recordLiveMatch();
  // Live truth still carries identity; only the sim outcome must match.
  const ignore = new Set(opts.stripBotIdentity ? ["isBot"] : []);
  try {
    const loaded = loadReplay(
      opts.stripBotIdentity ? stripArenaBotIdentity(bytes) : bytes,
    );
    // Recording armed when the human seated, mid-match.
    assertEquals(loaded.initialState.captureTick, HUMAN_AT_TICK - 1);
    assertExists(loaded.initialState.startCheckpoint);
    assert(loaded.lastTick - loaded.firstTick > 50 * 60, "match recorded");

    const runner = createReplayRunner(loaded, { collision });
    for (let t = loaded.firstTick; t <= loaded.lastTick; t++) {
      runner.step(t);
      const expected = truth.get(t);
      assertExists(expected, `live truth at ${t}`);
      const diff = firstDiff(
        expected,
        captureCheckpointState(runner.simulation, t, loaded.runtimeMatchId),
        ignore,
      );
      assertEquals(diff, null, `diverged at tick ${t}`);
    }

    // Seek path: every recorded checkpoint resumes to the next one exactly.
    const cps = loaded.container.checkpoints;
    assert(cps.length >= 10, "periodic checkpoints recorded");
    for (let k = 0; k + 1 < cps.length; k++) {
      runner.resetToCheckpoint(cps[k]!);
      for (let t = cps[k]!.tick + 1; t <= cps[k + 1]!.tick; t++) runner.step(t);
      const end = cps[k + 1]!.tick;
      const diff = firstDiff(
        truth.get(end)!,
        captureCheckpointState(runner.simulation, end, loaded.runtimeMatchId),
        ignore,
      );
      assertEquals(diff, null, `seek ${cps[k]!.tick}→${end} diverged`);
    }
  } finally {
    Deno.removeSync(blobDir, { recursive: true });
  }
}

Deno.test("replay round trip: bots + mid-match human resimulate bit-exact every tick", async () => {
  await assertRoundTrip({ stripBotIdentity: false });
});

Deno.test("replay round trip: bit-exact with arena bot identity stripped from the recording", async () => {
  await assertRoundTrip({ stripBotIdentity: true });
});
