/**
 * Conformance check for a fill/balance brain. Plays the host's side of one
 * session on Courtyard and reports every reply the real host would drop.
 *
 *   deno run -A bots/conformance/check.ts -- python3 my_brain.py
 *
 * What it checks (spec: bots/spec/README.md):
 * - hello answers protocol 5; load map and synchronize are acknowledged;
 * - every think result echoes tick, applyTick, and mapRevision, and has one
 *   decision per requested pawn, in request order, with the batch's
 *   spawnedAtTick (a respawn mid-run changes it), and nothing for the agent
 *   or human that are only in the world;
 * - actions are legal: finite yaw/pitch, at most one look sample per sim tick
 *   of the bot period, the last sample equal to the input look;
 * - replies arrive inside the 150 ms think buffer (late ones are reported;
 *   more than a tenth late fails, since the host would drop them);
 * - shutdown is acknowledged or the process exits.
 * Benchmark frames are never sent.
 */
import {
  BOT_THINK_PIPELINE_PROTOCOL_VERSION,
  type BotThinkPipelineRequest,
  type BotThinkPipelineResponse,
  decodeBotThinkPipelineResponseFrame,
  encodeBotThinkPipelineRequestFrame,
  pipelineFramePayloadLength,
} from "../spec/src/protocol/index.ts";
import type {
  BotDefinition,
  PlayerSnapshot,
  ReadyAction,
  ThinkBatchInput,
} from "../spec/src/model/index.ts";
import {
  botTickPhase,
  botTickToSimTick,
  SIM_TICK_HZ,
  SIM_TICKS_PER_BOT_TICK,
  simToBotTick,
  THINK_BUFFER_BOT_TICKS,
  THINK_BUFFER_SIM_TICKS,
} from "../spec/src/schedule.ts";
import { courtyardProbeMapDefinition } from "../engine/world/courtyardProbeMap.ts";
import { botWorkSlot } from "../engine/helpers/combat.ts";

export type ConformanceReport = Readonly<{
  ok: boolean;
  failures: readonly string[];
  notes: readonly string[];
  batches: number;
  lateBatches: number;
  maxRoundTripMs: number;
}>;

export type ConformanceOptions = Readonly<{
  /** Bot periods to run. Each pawn is due once per period. */
  periods?: number;
  /** Wait this long for a reply before calling the brain hung. */
  replyTimeoutMs?: number;
}>;

const BUDGET_MS = (THINK_BUFFER_SIM_TICKS / SIM_TICK_HZ) * 1000;

const PAWNS: readonly { id: string; role: "fill" | "balance"; team: "A" | "B" }[] = [
  { id: "bot1", role: "fill", team: "A" },
  { id: "bot2", role: "fill", team: "B" },
  { id: "bot3", role: "fill", team: "B" },
  { id: "bot", role: "balance", team: "A" },
];

function body(
  id: string,
  kind: PlayerSnapshot["kind"],
  team: "A" | "B",
  x: number,
  z: number,
  spawnedAtTick: number,
): PlayerSnapshot {
  return {
    id,
    kind,
    team,
    alive: true,
    health: 100,
    score: 0,
    spawnedAtTick,
    x,
    y: 0,
    z,
    velocityX: 0,
    velocityY: 0,
    velocityZ: 0,
    yaw: 0,
    pitch: 0,
    crouch: false,
    onGround: true,
    sprintStamina: 1,
    moveYaw: null,
    matchPlayer: kind === "human",
    weapon: {
      id: 0,
      ammoInMagazine: 12,
      spareClips: 3,
      reloading: false,
      lastShotTick: -1,
    },
    skills: [],
  };
}

class FrameReader {
  #buffer = new Uint8Array(0);
  #reader: ReadableStreamDefaultReader<Uint8Array>;

  constructor(stream: ReadableStream<Uint8Array>) {
    this.#reader = stream.getReader();
  }

  async next(timeoutMs: number): Promise<BotThinkPipelineResponse | "eof" | "timeout"> {
    const deadline = performance.now() + timeoutMs;
    while (true) {
      const length = pipelineFramePayloadLength(this.#buffer);
      if (length >= 0 && this.#buffer.byteLength >= 4 + length) {
        const frame = this.#buffer.slice(0, 4 + length);
        this.#buffer = this.#buffer.slice(4 + length);
        return decodeBotThinkPipelineResponseFrame(frame);
      }
      const left = deadline - performance.now();
      if (left <= 0) return "timeout";
      let timer: ReturnType<typeof setTimeout> | undefined;
      const chunk = await Promise.race([
        this.#reader.read(),
        new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), left);
        }),
      ]);
      clearTimeout(timer);
      if (chunk === "timeout") return "timeout";
      if (chunk.done) return "eof";
      const next = new Uint8Array(this.#buffer.byteLength + chunk.value.byteLength);
      next.set(this.#buffer);
      next.set(chunk.value, this.#buffer.byteLength);
      this.#buffer = next;
    }
  }

  release(): void {
    this.#reader.releaseLock();
  }
}

function actionProblem(action: ReadyAction | null): string | null {
  if (action === null || action.input === null) return null;
  const { yaw, pitch } = action.input;
  if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) {
    return "input yaw/pitch is not finite";
  }
  const samples = action.lookSamples ?? [];
  if (samples.length > SIM_TICKS_PER_BOT_TICK) {
    return `${samples.length} look samples (at most ${SIM_TICKS_PER_BOT_TICK})`;
  }
  const last = samples[samples.length - 1];
  if (last && (last.yaw !== yaw || last.pitch !== pitch)) {
    return "last look sample differs from the input look";
  }
  if (action.weapon !== undefined && !Number.isInteger(action.weapon)) {
    return "weapon slot is not an integer";
  }
  return null;
}

export async function runConformance(
  command: readonly string[],
  options: ConformanceOptions = {},
): Promise<ConformanceReport> {
  const periods = options.periods ?? 40;
  const replyTimeoutMs = options.replyTimeoutMs ?? 5_000;
  const failures: string[] = [];
  const notes: string[] = [];
  let batches = 0;
  let lateBatches = 0;
  let maxRoundTripMs = 0;

  const child = new Deno.Command(command[0]!, {
    args: command.slice(1),
    stdin: "piped",
    stdout: "piped",
    stderr: "inherit",
  }).spawn();
  const writer = child.stdin.getWriter();
  const reader = new FrameReader(child.stdout);
  let requestId = 0;

  const ask = async (
    request: BotThinkPipelineRequest,
  ): Promise<{ response: BotThinkPipelineResponse | null; ms: number }> => {
    const started = performance.now();
    await writer.write(encodeBotThinkPipelineRequestFrame(request));
    const response = await reader.next(replyTimeoutMs);
    const ms = performance.now() - started;
    if (response === "eof") {
      failures.push(`${request.type}: brain exited`);
      return { response: null, ms };
    }
    if (response === "timeout") {
      failures.push(`${request.type}: no reply in ${replyTimeoutMs} ms`);
      return { response: null, ms };
    }
    if (response.requestId !== request.requestId) {
      failures.push(
        `${request.type}: reply requestId ${response.requestId}, sent ${request.requestId}`,
      );
    }
    return { response, ms };
  };
  const expectAck = async (request: BotThinkPipelineRequest): Promise<boolean> => {
    const { response } = await ask(request);
    if (!response) return false;
    if (response.type !== "pipeline-acknowledgement" || !response.accepted) {
      failures.push(`${request.type}: expected an accepted acknowledgement, got ${response.type}`);
      return false;
    }
    return true;
  };

  try {
    const hello = await ask({
      type: "pipeline-hello",
      requestId: ++requestId,
      protocolVersion: BOT_THINK_PIPELINE_PROTOCOL_VERSION,
      clientName: "doors-conformance",
    });
    if (!hello.response) return finish();
    if (hello.response.type !== "pipeline-hello") {
      failures.push(`hello: got ${hello.response.type}`);
      return finish();
    }
    if (hello.response.protocolVersion !== BOT_THINK_PIPELINE_PROTOCOL_VERSION) {
      failures.push(
        `hello: brain speaks ${hello.response.protocolVersion}, host ${BOT_THINK_PIPELINE_PROTOCOL_VERSION}`,
      );
      return finish();
    }
    notes.push(`brain: ${hello.response.engineVersion}`);

    const map = courtyardProbeMapDefinition();
    if (!await expectAck({ type: "pipeline-load-map", requestId: ++requestId, map })) {
      return finish();
    }

    const spawned = new Map(PAWNS.map((pawn) => [pawn.id, 10]));
    const definitions = (): BotDefinition[] =>
      PAWNS.map((pawn, index) => ({
        id: pawn.id,
        role: pawn.role,
        profile: pawn.role === "balance" ? "balance-bot" : "community",
        randomSeed: 1_000 + index * 7 + spawned.get(pawn.id)!,
      }));
    const synchronize = () =>
      expectAck({
        type: "pipeline-synchronize-bots",
        requestId: ++requestId,
        bots: definitions(),
      });
    if (!await synchronize()) return finish();

    const respawnTick = botTickToSimTick(30 + Math.floor(periods / 2));
    const firstTick = botTickToSimTick(30);
    const lastTick = firstTick + periods * SIM_TICKS_PER_BOT_TICK;
    for (let tick = firstTick; tick < lastTick; tick++) {
      if (tick === respawnTick) {
        // bot2 died and came back: new life, new spawnedAtTick.
        spawned.set("bot2", tick);
        if (!await synchronize()) return finish();
      }
      const due = PAWNS.filter((pawn) =>
        botWorkSlot(pawn.id, SIM_TICKS_PER_BOT_TICK) === botTickPhase(tick)
      );
      if (due.length === 0) continue;
      const step = (tick - firstTick) / 30;
      const players = [
        ...PAWNS.map((pawn, index) =>
          body(
            pawn.id,
            "bot",
            pawn.team,
            (index - 1.5) * 3,
            (pawn.team === "A" ? -8 : 8) + (pawn.team === "A" ? step : -step),
            spawned.get(pawn.id)!,
          )
        ),
        body("human", "human", "B", 2, 4, 5),
        body("agent1", "agent", "A", -2, 0, 5),
      ];
      const input: ThinkBatchInput = {
        frame: {
          tick,
          simDelta: 1,
          mapRevision: map.revision,
          doorsOpen: Math.floor(tick / 120) % 2 === 0,
          doorChangeTick: Math.floor(tick / 120) * 120,
          teamScoreA: 0,
          teamScoreB: 1,
          players,
        },
        applyTick: botTickToSimTick(simToBotTick(tick) + THINK_BUFFER_BOT_TICKS),
        bots: due.map((pawn) => ({
          botId: pawn.id,
          spawnedAtTick: spawned.get(pawn.id)!,
        })),
      };
      const { response, ms } = await ask({
        type: "pipeline-think-batch",
        requestId: ++requestId,
        input,
      });
      if (!response) return finish();
      batches += 1;
      maxRoundTripMs = Math.max(maxRoundTripMs, ms);
      if (ms >= BUDGET_MS) lateBatches += 1;
      const where = `think tick ${tick}`;
      if (response.type !== "pipeline-think-batch-result") {
        failures.push(`${where}: got ${response.type}`);
        continue;
      }
      const output = response.output;
      if (
        output.tick !== input.frame.tick ||
        output.applyTick !== input.applyTick ||
        output.mapRevision !== input.frame.mapRevision
      ) {
        failures.push(`${where}: result does not echo tick / applyTick / mapRevision`);
        continue;
      }
      if (output.decisions.length !== input.bots.length) {
        failures.push(
          `${where}: ${output.decisions.length} decisions for ${input.bots.length} requested pawns`,
        );
        continue;
      }
      input.bots.forEach((requested, index) => {
        const decision = output.decisions[index]!;
        if (decision.botId !== requested.botId) {
          failures.push(`${where}: decision ${index} is ${decision.botId}, expected ${requested.botId}`);
          return;
        }
        if (decision.spawnedAtTick !== requested.spawnedAtTick) {
          failures.push(
            `${where}: ${decision.botId} spawnedAtTick ${decision.spawnedAtTick}, batch says ${requested.spawnedAtTick}`,
          );
        }
        const problem = actionProblem(decision.action);
        if (problem) failures.push(`${where}: ${decision.botId}: ${problem}`);
      });
    }
    if (batches > 0 && lateBatches > batches / 10) {
      failures.push(
        `${lateBatches} of ${batches} replies took ${BUDGET_MS} ms or more (the host drops those)`,
      );
    } else if (lateBatches > 0) {
      notes.push(`${lateBatches} of ${batches} replies were late (allowed: a tenth)`);
    }

    await writer.write(
      encodeBotThinkPipelineRequestFrame({
        type: "pipeline-shutdown",
        requestId: ++requestId,
      }),
    );
    const bye = await reader.next(2_000);
    if (bye === "timeout") failures.push("shutdown: no acknowledgement and no exit");
    return finish();
  } finally {
    reader.release();
    try {
      await writer.close();
    } catch {
      // already closed
    }
    try {
      child.kill();
    } catch {
      // already exited
    }
    await child.status;
  }

  function finish(): ConformanceReport {
    return {
      ok: failures.length === 0,
      failures,
      notes,
      batches,
      lateBatches,
      maxRoundTripMs,
    };
  }
}

if (import.meta.main) {
  const command = Deno.args[0] === "--" ? Deno.args.slice(1) : Deno.args;
  if (command.length === 0) {
    console.error("usage: deno run -A bots/conformance/check.ts -- <brain command…>");
    Deno.exit(2);
  }
  const report = await runConformance(command);
  for (const note of report.notes) console.log(`note: ${note}`);
  for (const failure of report.failures) console.log(`FAIL: ${failure}`);
  console.log(
    `${report.ok ? "PASS" : "FAIL"}: ${report.batches} think batches, ` +
      `slowest ${report.maxRoundTripMs.toFixed(1)} ms (budget ${BUDGET_MS} ms)`,
  );
  Deno.exit(report.ok ? 0 : 1);
}
