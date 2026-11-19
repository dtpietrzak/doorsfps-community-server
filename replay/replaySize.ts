/**
 * Epic 19.3 — replay size.
 *
 * Summarizes one finalized file against the match it records: duration,
 * player count, bot count, tick rate, and event frequency. The caller
 * supplies the byte length. The summarizer does not encode, does not
 * walk a file, and does not change what is stored.
 *
 * Duration is the recorded span `lastTick - firstTick + 1`, the same
 * span the container header stores. The session sampler takes that
 * span the way the container does: the first input row's tick, or the
 * init capture tick when the input stream is empty, through the latest
 * input, event, or checkpoint tick.
 *
 * Bot count is the roster flags the file stores: `isBot` (raid role),
 * `isAgent`, or `isBalanceBot`. Arena fill bots are recorded as humans.
 * Fill-bot identity is not a replay fact, so this count does not infer
 * it from names or ids. `bytesPerBot` is 0 when that count is 0.
 *
 * The meter keeps the latest file, the largest file (later note wins a
 * tie), the file count, and the sum of file bytes. It does not keep one
 * row per match.
 *
 * Section compression is 19.6. Storage capacity is 19.7. Seek latency is
 * 19.5. Playback CPU is 19.4. The status page is 23.4.
 * `ReplayRecorder` notes a file after it serializes one.
 */
import type { ReplayContainer } from "./replayContainer.ts";
import type { ReplayBufferedSessionView } from "./replaySessionBuffer.ts";

export const REPLAY_SIZE_INVALID = "replay-size-invalid" as const;

export type ReplaySizeErrorCode = typeof REPLAY_SIZE_INVALID;

export class ReplaySizeError extends Error {
  readonly code: ReplaySizeErrorCode;
  readonly detail: string | null;

  constructor(message: string, detail?: string | null) {
    super(message);
    this.name = "ReplaySizeError";
    this.code = REPLAY_SIZE_INVALID;
    this.detail = detail ?? null;
  }
}

export type ReplaySizeSample = {
  readonly fileBytes: number;
  readonly firstTick: number;
  readonly lastTick: number;
  readonly tickRate: number;
  readonly playerCount: number;
  readonly botCount: number;
  readonly eventCount: number;
  readonly inputRows: number;
  readonly checkpointCount: number;
};

export type ReplaySizeLevel = {
  readonly fileBytes: number;
  /** lastTick - firstTick + 1. */
  readonly durationTicks: number;
  /** durationTicks * 1000 / tickRate. */
  readonly durationMs: number;
  readonly tickRate: number;
  readonly playerCount: number;
  /** Roster entries with isBot, isAgent, or isBalanceBot. */
  readonly botCount: number;
  /** playerCount - botCount. */
  readonly humanCount: number;
  readonly eventCount: number;
  readonly inputRows: number;
  readonly checkpointCount: number;
  readonly bytesPerTick: number;
  readonly bytesPerSecond: number;
  /** 0 when the roster is empty. */
  readonly bytesPerPlayer: number;
  /** 0 when no recorded bot flag is set. */
  readonly bytesPerBot: number;
  /** Event records per recorded tick. */
  readonly eventsPerTick: number;
  /** Event records per second at tickRate. */
  readonly eventsPerSecond: number;
};

export type ReplaySizeReport = {
  readonly files: number;
  readonly totalBytes: number;
  /** Latest noted file. Null until the first note. */
  readonly current: ReplaySizeLevel | null;
  /** Greatest fileBytes. A later note wins a tie. */
  readonly largest: ReplaySizeLevel | null;
};

type ReplaySizeRosterEntry = {
  readonly isBot: boolean;
  readonly isAgent: boolean;
  readonly isBalanceBot: boolean;
};

function fail(message: string, detail?: string): never {
  throw new ReplaySizeError(message, detail ?? null);
}

function assertCount(name: string, value: number): void {
  if (
    !Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)
  ) {
    fail(`${name} must be an integer >= 0`, String(value));
  }
}

function assertSample(sample: ReplaySizeSample): void {
  assertCount("fileBytes", sample.fileBytes);
  assertCount("firstTick", sample.firstTick);
  assertCount("lastTick", sample.lastTick);
  assertCount("playerCount", sample.playerCount);
  assertCount("botCount", sample.botCount);
  assertCount("eventCount", sample.eventCount);
  assertCount("inputRows", sample.inputRows);
  assertCount("checkpointCount", sample.checkpointCount);
  if (!Number.isSafeInteger(sample.tickRate) || sample.tickRate < 1) {
    fail("tickRate must be an integer >= 1", String(sample.tickRate));
  }
  if (sample.lastTick < sample.firstTick) {
    fail(
      "lastTick must be >= firstTick",
      `${sample.lastTick} < ${sample.firstTick}`,
    );
  }
  if (sample.botCount > sample.playerCount) {
    fail(
      "botCount must be <= playerCount",
      `${sample.botCount} > ${sample.playerCount}`,
    );
  }
}

function copySample(sample: ReplaySizeSample): ReplaySizeSample {
  return {
    fileBytes: sample.fileBytes,
    firstTick: sample.firstTick,
    lastTick: sample.lastTick,
    tickRate: sample.tickRate,
    playerCount: sample.playerCount,
    botCount: sample.botCount,
    eventCount: sample.eventCount,
    inputRows: sample.inputRows,
    checkpointCount: sample.checkpointCount,
  };
}

function recordedBot(player: ReplaySizeRosterEntry): boolean {
  return player.isBot || player.isAgent || player.isBalanceBot;
}

function countBots(roster: readonly ReplaySizeRosterEntry[]): number {
  let bots = 0;
  for (const player of roster) {
    if (recordedBot(player)) bots += 1;
  }
  return bots;
}

/**
 * Span used by the container when the caller does not override ticks.
 * The first input row wins. Later rows, events, and checkpoints only
 * extend the end.
 */
function sessionSpan(session: ReplayBufferedSessionView): {
  firstTick: number;
  lastTick: number;
} {
  const init = session.init;
  if (!init) fail("replay size session is missing init");
  let firstTick = init.captureTick;
  if (session.inputs.length > 0) firstTick = session.inputs[0]!.tick;
  assertCount("firstTick", firstTick);
  let lastTick = firstTick;
  for (const row of session.inputs) {
    assertCount("inputTick", row.tick);
    if (row.tick > lastTick) lastTick = row.tick;
  }
  for (const row of session.events) {
    assertCount("eventTick", row.tick);
    if (row.tick > lastTick) lastTick = row.tick;
  }
  for (const frame of session.checkpoints) {
    assertCount("checkpointTick", frame.tick);
    if (frame.tick > lastTick) lastTick = frame.tick;
  }
  return { firstTick, lastTick };
}

/** Read size facts off a buffered session and a file length. */
export function sampleReplaySessionSize(
  session: ReplayBufferedSessionView,
  fileBytes: number,
): ReplaySizeSample {
  assertCount("fileBytes", fileBytes);
  const init = session.init;
  if (!init) fail("replay size session is missing init");
  const tickRate = init.metadata.tickRate;
  if (!Number.isSafeInteger(tickRate) || tickRate < 1) {
    fail("tickRate must be an integer >= 1", String(tickRate));
  }
  const { firstTick, lastTick } = sessionSpan(session);
  let eventCount = 0;
  for (const row of session.events) eventCount += row.events.length;
  const sample: ReplaySizeSample = {
    fileBytes,
    firstTick,
    lastTick,
    tickRate,
    playerCount: init.metadata.roster.length,
    botCount: countBots(init.metadata.roster),
    eventCount,
    inputRows: session.inputs.length,
    checkpointCount: session.checkpoints.length,
  };
  assertSample(sample);
  return sample;
}

/** Read the same facts off a container the encoder already built. */
export function sampleReplayContainerSize(
  container: ReplayContainer,
  fileBytes: number,
): ReplaySizeSample {
  assertCount("fileBytes", fileBytes);
  let eventCount = 0;
  for (const row of container.eventStream) eventCount += row.events.length;
  const sample: ReplaySizeSample = {
    fileBytes,
    firstTick: container.header.firstTick,
    lastTick: container.header.lastTick,
    tickRate: container.header.tickRate,
    playerCount: container.initialState.metadata.roster.length,
    botCount: countBots(container.initialState.metadata.roster),
    eventCount,
    inputRows: container.inputStream.length,
    checkpointCount: container.checkpoints.length,
  };
  assertSample(sample);
  return sample;
}

/** Rates for one file. Does not read a clock. */
export function summarizeReplaySize(sample: ReplaySizeSample): ReplaySizeLevel {
  assertSample(sample);
  const durationTicks = sample.lastTick - sample.firstTick + 1;
  const { fileBytes, tickRate, playerCount, botCount, eventCount } = sample;
  return {
    fileBytes,
    durationTicks,
    durationMs: durationTicks * 1000 / tickRate,
    tickRate,
    playerCount,
    botCount,
    humanCount: playerCount - botCount,
    eventCount,
    inputRows: sample.inputRows,
    checkpointCount: sample.checkpointCount,
    bytesPerTick: fileBytes / durationTicks,
    bytesPerSecond: fileBytes * tickRate / durationTicks,
    bytesPerPlayer: playerCount > 0 ? fileBytes / playerCount : 0,
    bytesPerBot: botCount > 0 ? fileBytes / botCount : 0,
    eventsPerTick: eventCount / durationTicks,
    eventsPerSecond: eventCount * tickRate / durationTicks,
  };
}

/**
 * One note per finalized file. `report` does not add a note.
 */
export class ReplaySizeMeter {
  private files = 0;
  private totalBytes = 0;
  private currentSample: ReplaySizeSample | null = null;
  private largestSample: ReplaySizeSample | null = null;

  note(sample: ReplaySizeSample): void {
    assertSample(sample);
    const nextTotal = this.totalBytes + sample.fileBytes;
    if (!Number.isSafeInteger(nextTotal)) {
      fail("replay size total exceeds a safe integer", String(nextTotal));
    }
    this.totalBytes = nextTotal;
    this.files += 1;
    const copy = copySample(sample);
    this.currentSample = copy;
    if (
      this.largestSample == null ||
      sample.fileBytes >= this.largestSample.fileBytes
    ) {
      this.largestSample = copySample(sample);
    }
  }

  report(): ReplaySizeReport {
    return {
      files: this.files,
      totalBytes: this.totalBytes,
      current: this.currentSample ? summarizeReplaySize(this.currentSample) : null,
      largest: this.largestSample
        ? summarizeReplaySize(this.largestSample)
        : null,
    };
  }
}
