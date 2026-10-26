import type {
  BotDefinition,
  BotMapDefinition,
  ThinkBatchInput,
  ThinkBatchOutput,
} from "@doors/bot-engine";
import {
  BOT_THINK_PIPELINE_MAX_FRAME_BYTES,
  BOT_THINK_PIPELINE_PROTOCOL_VERSION,
  type BotThinkPipelineRequest,
  type BotThinkPipelineResponse,
  decodeBotThinkPipelineRequestFrame,
  decodeBotThinkPipelineResponseFrame,
  encodeBotThinkPipelineRequestFrame,
  encodeBotThinkPipelineResponseFrame,
  type PipelineBenchmarkNativeTimings,
  pipelineFramePayloadLength,
} from "@doors/bot-engine/protocol";

const SHUTDOWN_GRACE_MS = 1_000;
const RESTART_MIN_DELAY_MS = 250;
const RESTART_MAX_DELAY_MS = 5_000;
const UNAVAILABLE_LOG_INTERVAL_MS = 5_000;
/** Keep the native FIFO short enough that a result can still beat the apply deadline. */
const MAX_IN_FLIGHT_THINKS = 6;

export type CompiledPipelineSpawnOptions = Readonly<{
  args?: readonly string[];
  cwd?: string;
  /**
   * Restart backoff. Defaults are the official compiled worker (250 ms,
   * doubling, cap 5 s). The `bots.brain` command slot passes 1 s–30 s.
   */
  restartMinDelayMs?: number;
  restartMaxDelayMs?: number;
}>;

function hostCwd(binaryPath: string): string | undefined {
  const slash = Math.max(
    binaryPath.lastIndexOf("/"),
    binaryPath.lastIndexOf("\\"),
  );
  return slash >= 0 ? binaryPath.slice(0, slash) : undefined;
}

function spawnHost(
  binaryPath: string,
  options: CompiledPipelineSpawnOptions = {},
): Deno.ChildProcess {
  return new Deno.Command(binaryPath, {
    args: options.args ? [...options.args] : undefined,
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
    cwd: options.cwd ?? (options.args ? undefined : hostCwd(binaryPath)),
  }).spawn();
}

export type CompiledPipelineResult = Readonly<{
  output: ThinkBatchOutput;
  roundTripMs: number;
  requestBytes: number;
}>;

export type CompiledPipelineTransportMetrics = Readonly<{
  status: "starting" | "ready" | "error" | "stopped";
  engineVersion: string | null;
  inFlight: number;
  batches: number;
  errors: number;
  meanRoundTripMs: number;
  meanRequestBytes: number;
}>;

export interface CompiledBotThinkPipeline {
  loadMap(map: BotMapDefinition): void;
  synchronizeBots(bots: readonly BotDefinition[]): void;
  thinkBatch(input: ThinkBatchInput): Promise<CompiledPipelineResult>;
  /** Benchmark/test barrier; production never waits on the worker. */
  idle(): Promise<void>;
  snapshot(): CompiledPipelineTransportMetrics;
  close(): Promise<void>;
}

type Logger = Readonly<{
  info(message: string): void;
  warn(message: string): void;
}>;

type PendingRequest = {
  startedAt: number;
  requestEncodeMs: number;
  requestBytes: number;
  resolve(value: ResponseEnvelope): void;
  reject(error: Error): void;
};

type ResponseEnvelope = Readonly<{
  response: BotThinkPipelineResponse;
  roundTripMs: number;
  requestEncodeMs: number;
  responseDecodeMs: number;
  requestBytes: number;
}>;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function rosterKey(bots: readonly BotDefinition[]): string {
  let output = "";
  for (const bot of bots) {
    output += `${bot.id}\u0000${bot.role}\u0000${bot.profile}\u0000${
      bot.randomSeed
    }\u0000${bot.profileData ?? ""}\u0001`;
  }
  return output;
}

/** Long-lived Deno transport for one complete compiled thought engine. */
export class DenoCompiledBotThinkPipeline implements CompiledBotThinkPipeline {
  private readonly binaryPath: string;
  private readonly spawnOptions: CompiledPipelineSpawnOptions;
  private child: Deno.ChildProcess;
  private writer!: WritableStreamDefaultWriter<Uint8Array>;
  private readonly logger: Logger;
  private readonly pending = new Map<number, PendingRequest>();
  private idleWaiters: Array<() => void> = [];
  private writeChain: Promise<void> = Promise.resolve();
  private nextRequestId = 1;
  private generation = 0;
  private closing = false;
  private exited = false;
  private restarting = false;
  private readonly restartMinDelayMs: number;
  private readonly restartMaxDelayMs: number;
  private restartDelayMs: number;
  private lastUnavailableLogAt = 0;
  private statusValue: CompiledPipelineTransportMetrics["status"] = "starting";
  private engineVersionValue: string | null = null;
  private mapRevisionSent: string | null = null;
  private mapRevisionAcked: string | null = null;
  private rosterRevisionSent = "";
  private rosterRevisionAcked = "";
  private lastMap: BotMapDefinition | null = null;
  private lastBots: readonly BotDefinition[] | null = null;
  private thinkInFlight = 0;
  private batches = 0;
  private errors = 0;
  private roundTripMsTotal = 0;
  private requestBytesTotal = 0;
  private requestEncodeMsTotal = 0;
  private responseDecodeMsTotal = 0;
  private lastThinkInput: ThinkBatchInput | null = null;
  private lastThinkOutput: ThinkBatchOutput | null = null;

  private constructor(
    binaryPath: string,
    child: Deno.ChildProcess,
    logger: Logger,
    spawnOptions: CompiledPipelineSpawnOptions,
  ) {
    this.binaryPath = binaryPath;
    this.spawnOptions = spawnOptions;
    this.logger = logger;
    this.child = child;
    this.restartMinDelayMs = spawnOptions.restartMinDelayMs ??
      RESTART_MIN_DELAY_MS;
    this.restartMaxDelayMs = spawnOptions.restartMaxDelayMs ??
      RESTART_MAX_DELAY_MS;
    this.restartDelayMs = this.restartMinDelayMs;
    this.attachChild(child);
  }

  static start(
    binaryPath: string,
    logger: Logger = {
      info: (message) => console.log(message),
      warn: (message) => console.warn(message),
    },
    spawnOptions: CompiledPipelineSpawnOptions = {},
  ): DenoCompiledBotThinkPipeline {
    const child = spawnHost(binaryPath, spawnOptions);
    logger.info(
      `[bot-brain pipeline-compiled] starting ${binaryPath}` +
        (child.pid != null ? ` pid=${child.pid}` : ""),
    );
    return new DenoCompiledBotThinkPipeline(
      binaryPath,
      child,
      logger,
      spawnOptions,
    );
  }

  private attachChild(child: Deno.ChildProcess): void {
    this.generation += 1;
    const generation = this.generation;
    this.child = child;
    this.writer = child.stdin.getWriter();
    this.exited = false;
    this.statusValue = "starting";
    this.writeChain = Promise.resolve();
    void this.readStdout(generation, child.stdout);
    void this.readStderr(generation, child.stderr);
    void this.watchExit(generation, child);
    void this.handshake(generation);
  }

  private async handshake(generation: number): Promise<void> {
    try {
      const { response } = await this.send({
        type: "pipeline-hello",
        requestId: this.allocateRequestId(),
        protocolVersion: BOT_THINK_PIPELINE_PROTOCOL_VERSION,
        clientName: "doors-community",
      });
      if (generation !== this.generation || this.closing) return;
      if (
        response.type !== "pipeline-hello" ||
        response.protocolVersion !== BOT_THINK_PIPELINE_PROTOCOL_VERSION
      ) {
        throw new Error("compiled pipeline hello mismatch");
      }
      this.engineVersionValue = response.engineVersion;
      this.statusValue = "ready";
      this.restartDelayMs = this.restartMinDelayMs;
      this.logger.info(
        `[bot-brain pipeline-compiled] ready engine=${response.engineVersion}` +
          (this.child.pid != null ? ` pid=${this.child.pid}` : ""),
      );
      const map = this.lastMap;
      const bots = this.lastBots;
      this.mapRevisionSent = null;
      this.mapRevisionAcked = null;
      this.rosterRevisionSent = "";
      this.rosterRevisionAcked = "";
      if (map !== null) this.loadMap(map);
      if (bots !== null) this.synchronizeBots(bots);
    } catch (error) {
      if (generation !== this.generation || this.closing) return;
      this.noteError("hello", error);
    }
  }

  private async restart(reason: string): Promise<void> {
    if (this.closing || this.restarting) return;
    this.restarting = true;
    const delayMs = this.restartDelayMs;
    this.restartDelayMs = Math.min(
      this.restartDelayMs * 2,
      this.restartMaxDelayMs,
    );
    this.logger.warn(
      `[bot-brain pipeline-compiled] restarting in ${delayMs}ms (${reason})`,
    );
    await delay(delayMs);
    if (this.closing) {
      this.restarting = false;
      return;
    }
    try {
      const child = spawnHost(this.binaryPath, this.spawnOptions);
      this.logger.info(
        `[bot-brain pipeline-compiled] starting ${this.binaryPath}` +
          (child.pid != null ? ` pid=${child.pid}` : ""),
      );
      this.attachChild(child);
    } catch (error) {
      this.noteError("restart", error);
      this.restarting = false;
      void this.restart("spawn failed");
      return;
    }
    this.restarting = false;
  }

  private allocateRequestId(): number {
    const id = this.nextRequestId;
    this.nextRequestId = this.nextRequestId >= 0xffff_fffe
      ? 1
      : this.nextRequestId + 1;
    return id;
  }

  private noteError(context: string, error: unknown): void {
    this.errors += 1;
    if (this.statusValue !== "stopped") this.statusValue = "error";
    const message = error instanceof Error ? error.message : String(error);
    const unavailable = message.includes("compiled pipeline is unavailable");
    if (unavailable) {
      const now = Date.now();
      if (now - this.lastUnavailableLogAt < UNAVAILABLE_LOG_INTERVAL_MS) return;
      this.lastUnavailableLogAt = now;
    }
    this.logger.warn(`[bot-brain pipeline-compiled] ${context}: ${message}`);
  }

  private resolveIdleWaiters(): void {
    if (this.pending.size !== 0 || this.idleWaiters.length === 0) return;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const resolve of waiters) resolve();
  }

  private send(
    request: BotThinkPipelineRequest,
  ): Promise<ResponseEnvelope> {
    if (this.closing || this.exited) {
      if (!this.closing && !this.restarting) void this.restart("send while down");
      return Promise.reject(new Error("compiled pipeline is unavailable"));
    }
    let frame: Uint8Array;
    const encodeStartedAt = performance.now();
    try {
      frame = encodeBotThinkPipelineRequestFrame(request);
    } catch (error) {
      return Promise.reject(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
    const requestEncodeMs = performance.now() - encodeStartedAt;
    const promise = new Promise<ResponseEnvelope>((resolve, reject) => {
      this.pending.set(request.requestId, {
        startedAt: performance.now(),
        requestEncodeMs,
        requestBytes: frame.byteLength,
        resolve,
        reject,
      });
    });
    this.writeChain = this.writeChain
      .then(() => this.writer.write(frame))
      .catch((error: unknown) => {
        const pending = this.pending.get(request.requestId);
        if (pending !== undefined) {
          this.pending.delete(request.requestId);
          pending.reject(
            error instanceof Error ? error : new Error(String(error)),
          );
          this.resolveIdleWaiters();
        }
      });
    return promise;
  }

  private async readStdout(
    generation: number,
    stdout: ReadableStream<Uint8Array>,
  ): Promise<void> {
    let buffered = new Uint8Array(0);
    try {
      for await (const chunk of stdout) {
        if (generation !== this.generation) return;
        const next = new Uint8Array(buffered.byteLength + chunk.byteLength);
        next.set(buffered);
        next.set(chunk, buffered.byteLength);
        buffered = next;
        let start = 0;
        while (buffered.byteLength - start >= 4) {
          const length = pipelineFramePayloadLength(
            buffered.subarray(start, start + 4),
          );
          if (length < 8 || length > BOT_THINK_PIPELINE_MAX_FRAME_BYTES) {
            throw new Error("invalid compiled pipeline frame length");
          }
          const total = 4 + length;
          if (buffered.byteLength - start < total) break;
          this.acceptFrame(buffered.slice(start, start + total));
          start += total;
        }
        if (start > 0) buffered = buffered.slice(start);
      }
      if (buffered.byteLength > 0) {
        throw new Error("compiled stdout ended with a partial frame");
      }
    } catch (error) {
      if (!this.closing && generation === this.generation) {
        this.noteError("stdout failed", error);
      }
    }
  }

  private acceptFrame(frame: Uint8Array): void {
    const decodeStartedAt = performance.now();
    const response = decodeBotThinkPipelineResponseFrame(frame);
    const responseDecodeMs = performance.now() - decodeStartedAt;
    const pending = this.pending.get(response.requestId);
    if (pending === undefined) {
      if (response.type === "pipeline-error") {
        this.noteError(`${response.code} (uncorrelated)`, response.message);
      }
      return;
    }
    this.pending.delete(response.requestId);
    if (response.type === "pipeline-error") {
      pending.reject(new Error(`${response.code}: ${response.message}`));
      this.resolveIdleWaiters();
      return;
    }
    pending.resolve({
      response,
      roundTripMs: performance.now() - pending.startedAt,
      requestEncodeMs: pending.requestEncodeMs,
      responseDecodeMs,
      requestBytes: pending.requestBytes,
    });
    this.resolveIdleWaiters();
  }

  private async readStderr(
    generation: number,
    stderr: ReadableStream<Uint8Array>,
  ): Promise<void> {
    try {
      const decoder = new TextDecoder();
      let buf = "";
      for await (const chunk of stderr) {
        if (generation !== this.generation) return;
        buf += decoder.decode(chunk, { stream: true });
        let nl = buf.indexOf("\n");
        while (nl >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line.length > 0) {
            this.logger.warn(
              `[bot-brain pipeline-compiled] stderr: ${line}`,
            );
          }
          nl = buf.indexOf("\n");
        }
      }
      const tail = buf.trim();
      if (tail.length > 0 && generation === this.generation) {
        this.logger.warn(`[bot-brain pipeline-compiled] stderr: ${tail}`);
      }
    } catch (error) {
      if (!this.closing && generation === this.generation) {
        this.noteError("stderr failed", error);
      }
    }
  }

  private async watchExit(
    generation: number,
    child: Deno.ChildProcess,
  ): Promise<void> {
    try {
      const status = await child.status;
      if (generation !== this.generation) return;
      this.exited = true;
      this.statusValue = this.closing ? "stopped" : "error";
      const signal = status.signal != null ? ` signal=${status.signal}` : "";
      const error = new Error(
        `compiled pipeline exited code=${status.code}${signal}`,
      );
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
      this.resolveIdleWaiters();
      if (this.closing) return;
      this.noteError("worker exited", error);
      void this.restart(`exited code=${status.code}${signal}`);
    } catch (error) {
      if (generation !== this.generation) return;
      this.exited = true;
      this.statusValue = this.closing ? "stopped" : "error";
      for (const pending of this.pending.values()) {
        pending.reject(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
      this.pending.clear();
      this.resolveIdleWaiters();
      if (this.closing) return;
      this.noteError("worker status failed", error);
      void this.restart("status failed");
    }
  }

  loadMap(map: BotMapDefinition): void {
    this.lastMap = map;
    if (this.mapRevisionSent === map.revision) return;
    // Mark the revision sent immediately so a slow ack cannot refill the pipe
    // with duplicate maps. Think is queued on the same FIFO (see thinkBatch).
    this.mapRevisionSent = map.revision;
    void this.send({
      type: "pipeline-load-map",
      requestId: this.allocateRequestId(),
      map,
    }).then(({ response }) => {
      if (
        response.type !== "pipeline-acknowledgement" || !response.accepted
      ) {
        throw new Error("compiled map was not accepted");
      }
      if (this.lastMap?.revision === map.revision) {
        this.mapRevisionAcked = map.revision;
      }
    }).catch((error: unknown) => {
      if (this.lastMap?.revision === map.revision) {
        this.mapRevisionSent = null;
        this.mapRevisionAcked = null;
      }
      this.noteError("load-map", error);
    });
  }

  synchronizeBots(bots: readonly BotDefinition[]): void {
    this.lastBots = bots;
    const revision = rosterKey(bots);
    if (revision === this.rosterRevisionSent) return;
    this.rosterRevisionSent = revision;
    void this.send({
      type: "pipeline-synchronize-bots",
      requestId: this.allocateRequestId(),
      bots,
    }).then(({ response }) => {
      if (
        response.type !== "pipeline-acknowledgement" || !response.accepted
      ) {
        throw new Error("compiled roster was not accepted");
      }
      if (this.lastBots !== null && rosterKey(this.lastBots) === revision) {
        this.rosterRevisionAcked = revision;
      }
    }).catch((error: unknown) => {
      if (this.lastBots !== null && rosterKey(this.lastBots) === revision) {
        this.rosterRevisionSent = "";
        this.rosterRevisionAcked = "";
      }
      this.noteError("synchronize-bots", error);
    });
  }

  async thinkBatch(input: ThinkBatchInput): Promise<CompiledPipelineResult> {
    if (this.statusValue !== "ready" || this.closing || this.exited) {
      const error = new Error("compiled pipeline is unavailable");
      this.noteError("think-batch", error);
      throw error;
    }
    // Writes are FIFO. Map/roster already on writeChain (sent, maybe not
    // acked) still run before this think; waiting for the ack drops ticks
    // and desyncs shadow JS vs native.
    if (
      this.lastMap === null ||
      this.lastBots === null ||
      this.mapRevisionSent !== input.frame.mapRevision ||
      this.rosterRevisionSent !== rosterKey(this.lastBots)
    ) {
      throw new Error("compiled pipeline is unavailable");
    }
    if (this.thinkInFlight >= MAX_IN_FLIGHT_THINKS) {
      throw new Error("compiled pipeline is unavailable");
    }
    const requestId = this.allocateRequestId();
    this.thinkInFlight += 1;
    let envelope: ResponseEnvelope;
    try {
      envelope = await this.send({
        type: "pipeline-think-batch",
        requestId,
        input,
      });
    } catch (error) {
      this.noteError("think-batch", error);
      throw error;
    } finally {
      this.thinkInFlight -= 1;
    }
    const {
      response,
      roundTripMs,
      requestEncodeMs,
      responseDecodeMs,
      requestBytes,
    } = envelope;
    if (response.type !== "pipeline-think-batch-result") {
      throw new Error(`unexpected compiled response ${response.type}`);
    }
    this.batches += 1;
    this.roundTripMsTotal += roundTripMs;
    this.requestBytesTotal += requestBytes;
    this.requestEncodeMsTotal += requestEncodeMs;
    this.responseDecodeMsTotal += responseDecodeMs;
    this.lastThinkInput = input;
    this.lastThinkOutput = response.output;
    return { output: response.output, roundTripMs, requestBytes };
  }

  /** Clear and enable native phase timing for subsequent real think batches. */
  async benchmarkResetNativeTimings(): Promise<void> {
    const { response } = await this.send({
      type: "pipeline-benchmark-reset",
      requestId: this.allocateRequestId(),
    });
    if (
      response.type !== "pipeline-acknowledgement" || !response.accepted
    ) {
      throw new Error(`unexpected benchmark reset response ${response.type}`);
    }
  }

  /** Reset Deno-side production-message counters after benchmark warmup. */
  benchmarkResetTransportTimings(): void {
    this.batches = 0;
    this.roundTripMsTotal = 0;
    this.requestBytesTotal = 0;
    this.requestEncodeMsTotal = 0;
    this.responseDecodeMsTotal = 0;
  }

  /** Deno-side timings for the real production messages since reset. */
  benchmarkTransportTimings(): Readonly<{
    batches: number;
    meanEndToEndMs: number;
    meanRoundTripAfterRequestEncodeMs: number;
    meanRequestEncodeMs: number;
    meanResponseDecodeMs: number;
    meanRequestBytes: number;
  }> {
    const divisor = this.batches > 0 ? this.batches : 1;
    return {
      batches: this.batches,
      meanEndToEndMs: (
        this.requestEncodeMsTotal + this.roundTripMsTotal
      ) / divisor,
      meanRoundTripAfterRequestEncodeMs: this.roundTripMsTotal / divisor,
      meanRequestEncodeMs: this.requestEncodeMsTotal / divisor,
      meanResponseDecodeMs: this.responseDecodeMsTotal / divisor,
      meanRequestBytes: this.requestBytesTotal / divisor,
    };
  }

  /** Native decode/think/encode totals for production think messages. */
  async benchmarkNativeTimings(): Promise<PipelineBenchmarkNativeTimings> {
    const { response } = await this.send({
      type: "pipeline-benchmark-snapshot",
      requestId: this.allocateRequestId(),
    });
    if (response.type !== "pipeline-benchmark-snapshot") {
      throw new Error(
        `unexpected benchmark snapshot response ${response.type}`,
      );
    }
    return response.timings;
  }

  /** Empty persistent-process request/response latency with no payload or work. */
  async benchmarkEmptyRoundTrips(iterations: number): Promise<
    Readonly<{
      iterations: number;
      meanMs: number;
      medianMs: number;
      p95Ms: number;
    }>
  > {
    const samples: number[] = [];
    for (let index = 0; index < iterations; index += 1) {
      const envelope = await this.send({
        type: "pipeline-benchmark-ping",
        requestId: this.allocateRequestId(),
      });
      if (
        envelope.response.type !== "pipeline-acknowledgement" ||
        !envelope.response.accepted
      ) {
        throw new Error(
          `unexpected benchmark ping response ${envelope.response.type}`,
        );
      }
      samples.push(envelope.requestEncodeMs + envelope.roundTripMs);
    }
    const sorted = [...samples].sort((a, b) => a - b);
    let total = 0;
    for (const sample of samples) total += sample;
    return {
      iterations,
      meanMs: total / iterations,
      medianMs: sorted[Math.floor(sorted.length / 2)]!,
      p95Ms: sorted[
        Math.min(
          sorted.length - 1,
          Math.floor(sorted.length * 0.95),
        )
      ]!,
    };
  }

  /** Deno-side production-shape request and response codec costs, without IPC. */
  benchmarkLocalCodec(iterations: number): Readonly<{
    iterations: number;
    requestBytes: number;
    responseBytes: number;
    requestEncodeMsPerBatch: number;
    requestDecodeMsPerBatch: number;
    responseEncodeMsPerBatch: number;
    responseDecodeMsPerBatch: number;
    totalCodecMsPerBatch: number;
  }> {
    const input = this.lastThinkInput;
    const output = this.lastThinkOutput;
    if (input === null || output === null) {
      throw new Error("benchmark codec requires at least one completed batch");
    }
    const request: BotThinkPipelineRequest = {
      type: "pipeline-think-batch",
      requestId: 1,
      input,
    };
    const response: BotThinkPipelineResponse = {
      type: "pipeline-think-batch-result",
      requestId: 1,
      output,
    };
    const requestFrame = encodeBotThinkPipelineRequestFrame(request);
    const responseFrame = encodeBotThinkPipelineResponseFrame(response);

    let startedAt = performance.now();
    for (let index = 0; index < iterations; index += 1) {
      encodeBotThinkPipelineRequestFrame(request);
    }
    const requestEncodeMs = performance.now() - startedAt;

    startedAt = performance.now();
    for (let index = 0; index < iterations; index += 1) {
      decodeBotThinkPipelineRequestFrame(requestFrame);
    }
    const requestDecodeMs = performance.now() - startedAt;

    startedAt = performance.now();
    for (let index = 0; index < iterations; index += 1) {
      encodeBotThinkPipelineResponseFrame(response);
    }
    const responseEncodeMs = performance.now() - startedAt;

    startedAt = performance.now();
    for (let index = 0; index < iterations; index += 1) {
      decodeBotThinkPipelineResponseFrame(responseFrame);
    }
    const responseDecodeMs = performance.now() - startedAt;

    return {
      iterations,
      requestBytes: requestFrame.byteLength,
      responseBytes: responseFrame.byteLength,
      requestEncodeMsPerBatch: requestEncodeMs / iterations,
      requestDecodeMsPerBatch: requestDecodeMs / iterations,
      responseEncodeMsPerBatch: responseEncodeMs / iterations,
      responseDecodeMsPerBatch: responseDecodeMs / iterations,
      totalCodecMsPerBatch: (
        requestEncodeMs + requestDecodeMs + responseEncodeMs + responseDecodeMs
      ) / iterations,
    };
  }

  /** Native thinking only: decode once, run N times, encode only the last result. */
  async benchmarkRepeatedNativeThink(iterations: number): Promise<
    Readonly<{
      iterations: number;
      botsPerBatch: number;
      nativeThinkMs: number;
      nativeThinkMsPerBatch: number;
      nativeThinkMsPerBot: number;
    }>
  > {
    const input = this.lastThinkInput;
    if (input === null) {
      throw new Error("native think benchmark requires a completed batch");
    }
    const { response } = await this.send({
      type: "pipeline-benchmark-repeat",
      requestId: this.allocateRequestId(),
      input,
      iterations,
    });
    if (response.type !== "pipeline-benchmark-repeat-result") {
      throw new Error(`unexpected benchmark repeat response ${response.type}`);
    }
    const botsPerBatch = input.bots.length;
    return {
      iterations: response.iterations,
      botsPerBatch,
      nativeThinkMs: response.nativeThinkMs,
      nativeThinkMsPerBatch: response.nativeThinkMs / response.iterations,
      nativeThinkMsPerBot: response.nativeThinkMs /
        (response.iterations * botsPerBatch),
    };
  }

  /** OS pid of the current child, when the runtime exposed one. */
  pid(): number | undefined {
    return this.child.pid;
  }

  snapshot(): CompiledPipelineTransportMetrics {
    return {
      status: this.statusValue,
      engineVersion: this.engineVersionValue,
      inFlight: this.pending.size,
      batches: this.batches,
      errors: this.errors,
      meanRoundTripMs: this.batches > 0
        ? this.roundTripMsTotal / this.batches
        : 0,
      meanRequestBytes: this.batches > 0
        ? this.requestBytesTotal / this.batches
        : 0,
    };
  }

  async idle(): Promise<void> {
    await this.writeChain;
    if (this.exited || this.pending.size === 0) return;
    await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  async close(): Promise<void> {
    if (this.closing) return;
    const shutdown = this.send({
      type: "pipeline-shutdown",
      requestId: this.allocateRequestId(),
    });
    this.closing = true;
    try {
      await shutdown;
    } catch { /* the worker may already be gone */ }
    await this.writeChain;
    try {
      await this.writer.close();
    } catch { /* worker already closed */ }
    const exited = await Promise.race([
      this.child.status.then(() => true),
      delay(SHUTDOWN_GRACE_MS).then(() => false),
    ]);
    if (!exited && !this.exited) {
      try {
        this.child.kill("SIGTERM");
      } catch { /* exited between check and signal */ }
      await this.child.status;
    }
    this.statusValue = "stopped";
  }
}

/** Same `pipeline-host.ts` as ScriptC, compiled with `deno compile`. */
export const DEFAULT_DENO_COMPILED_BOT_THINK_HOST = new URL(
  "../../../bot-official/.deno/bot-official-host",
  import.meta.url,
).pathname;

/** Default path for Perry-produced bot-official host binary. */
export const DEFAULT_PERRY_COMPILED_BOT_THINK_HOST = new URL(
  "../../../bot-official/.perry/bot-official-host",
  import.meta.url,
).pathname;

export type CompiledPipelineStartFromEnvOptions = Readonly<{
  envName?: string;
  defaultPath?: string;
}>;

export function startCompiledBotThinkPipelineFromEnv(
  logger?: Logger,
  options: CompiledPipelineStartFromEnvOptions = {},
): DenoCompiledBotThinkPipeline | null {
  const envName = options.envName ?? "DOORS_BOT_THINK_BIN";
  const binaryPath = Deno.env.get(envName)?.trim() ||
    options.defaultPath?.trim();
  if (!binaryPath) return null;
  const warn = logger?.warn ?? ((message: string) => console.warn(message));
  try {
    const st = Deno.statSync(binaryPath);
    if (!st.isFile) {
      warn(
        `[bot-brain pipeline-compiled] start failed: ${binaryPath} is not a file`,
      );
      return null;
    }
  } catch {
    warn(
      `[bot-brain pipeline-compiled] start failed: ${binaryPath} not found`,
    );
    return null;
  }
  try {
    return DenoCompiledBotThinkPipeline.start(binaryPath, logger);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warn(`[bot-brain pipeline-compiled] start failed: ${message}`);
    return null;
  }
}
