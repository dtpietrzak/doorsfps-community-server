import type {
  BotDefinition,
  BotRole,
  BotInputIntent,
  BotLookSample,
  BotMapDefinition,
  BotMapSide,
  PlayerSnapshot,
  ReadyAction,
  SkillSnapshot,
  ThinkBatchInput,
  ThinkBatchOutput,
  ThinkFrame,
  WeaponInventorySnapshot,
  WeaponSnapshot,
} from "../model/index.ts";

/**
 * The public bot protocol (spec: `bots/spec/README.md`).
 * v3: actions with input carry per-sim-tick `lookSamples`.
 * v4: configs carried the aim-planner and trigger-discipline knobs.
 * v5: the public cut. A pawn carries `role` and optional `profileData`, and
 * no config. Frames carry no `humanHeatByPole`. The pool-profile frame is gone.
 * Not the `bot-official` state-host protocol, which has its own numbering.
 */
export const BOT_THINK_PIPELINE_PROTOCOL_VERSION = 5;
export const BOT_THINK_PIPELINE_WIRE_VERSION = 1;
export const BOT_THINK_PIPELINE_MAX_FRAME_BYTES = 16 * 1024 * 1024;

export type PipelineHelloRequest = Readonly<{
  type: "pipeline-hello";
  requestId: number;
  protocolVersion: number;
  clientName: string;
}>;

export type PipelineLoadMapRequest = Readonly<{
  type: "pipeline-load-map";
  requestId: number;
  map: BotMapDefinition;
}>;

export type PipelineSynchronizeBotsRequest = Readonly<{
  type: "pipeline-synchronize-bots";
  requestId: number;
  bots: readonly BotDefinition[];
}>;

export type PipelineThinkBatchRequest = Readonly<{
  type: "pipeline-think-batch";
  requestId: number;
  input: ThinkBatchInput;
}>;

/**
 * Benchmark frames (kinds 22–25, 85–86) are debug-only for our own workers.
 * A host never sends them to a `bots.brain` command, and a brain may answer
 * them with a recoverable `pipeline-error`.
 */

/** Diagnostic-only empty request used to isolate persistent-worker IPC cost. */
export type PipelineBenchmarkPingRequest = Readonly<{
  type: "pipeline-benchmark-ping";
  requestId: number;
}>;

/** Enable and clear native timings for subsequent production think batches. */
export type PipelineBenchmarkResetRequest = Readonly<{
  type: "pipeline-benchmark-reset";
  requestId: number;
}>;

/** Read native timings accumulated since the last benchmark reset. */
export type PipelineBenchmarkSnapshotRequest = Readonly<{
  type: "pipeline-benchmark-snapshot";
  requestId: number;
}>;

/** Run one decoded production input repeatedly entirely inside the worker. */
export type PipelineBenchmarkRepeatRequest = Readonly<{
  type: "pipeline-benchmark-repeat";
  requestId: number;
  input: ThinkBatchInput;
  iterations: number;
}>;

export type PipelineShutdownRequest = Readonly<{
  type: "pipeline-shutdown";
  requestId: number;
}>;

export type BotThinkPipelineRequest =
  | PipelineHelloRequest
  | PipelineLoadMapRequest
  | PipelineSynchronizeBotsRequest
  | PipelineThinkBatchRequest
  | PipelineBenchmarkPingRequest
  | PipelineBenchmarkResetRequest
  | PipelineBenchmarkSnapshotRequest
  | PipelineBenchmarkRepeatRequest
  | PipelineShutdownRequest;

export type PipelineHelloResponse = Readonly<{
  type: "pipeline-hello";
  requestId: number;
  protocolVersion: number;
  engineVersion: string;
}>;

export type PipelineAcknowledgementResponse = Readonly<{
  type: "pipeline-acknowledgement";
  requestId: number;
  accepted: boolean;
}>;

export type PipelineThinkBatchResponse = Readonly<{
  type: "pipeline-think-batch-result";
  requestId: number;
  output: ThinkBatchOutput;
}>;

export type PipelineBenchmarkNativeTimings = Readonly<{
  batches: number;
  requestDecodeMs: number;
  thinkMs: number;
  responseEncodeMs: number;
}>;

export type PipelineBenchmarkSnapshotResponse = Readonly<{
  type: "pipeline-benchmark-snapshot";
  requestId: number;
  timings: PipelineBenchmarkNativeTimings;
}>;

export type PipelineBenchmarkRepeatResponse = Readonly<{
  type: "pipeline-benchmark-repeat-result";
  requestId: number;
  iterations: number;
  nativeThinkMs: number;
  output: ThinkBatchOutput;
}>;

export type PipelineErrorResponse = Readonly<{
  type: "pipeline-error";
  requestId: number;
  code: string;
  message: string;
  recoverable: boolean;
}>;

export type BotThinkPipelineResponse =
  | PipelineHelloResponse
  | PipelineAcknowledgementResponse
  | PipelineThinkBatchResponse
  | PipelineBenchmarkSnapshotResponse
  | PipelineBenchmarkRepeatResponse
  | PipelineErrorResponse;

const MAGIC_0 = 0x42; // B
const MAGIC_1 = 0x50; // P
const PREFIX_BYTES = 4;
const HEADER_BYTES = 8;
const NULL_I32 = -2_147_483_648;

const REQUEST_HELLO = 17;
const REQUEST_LOAD_MAP = 18;
const REQUEST_SYNCHRONIZE_BOTS = 19;
const REQUEST_THINK_BATCH = 20;
const REQUEST_SHUTDOWN = 21;
const REQUEST_BENCHMARK_PING = 22;
const REQUEST_BENCHMARK_RESET = 23;
const REQUEST_BENCHMARK_SNAPSHOT = 24;
const REQUEST_BENCHMARK_REPEAT = 25;
const RESPONSE_HELLO = 81;
const RESPONSE_ACKNOWLEDGEMENT = 82;
const RESPONSE_THINK_BATCH = 83;
const RESPONSE_ERROR = 84;
const RESPONSE_BENCHMARK_SNAPSHOT = 85;
const RESPONSE_BENCHMARK_REPEAT = 86;

class Writer {
  private bytes = new Uint8Array(512);
  private view = new DataView(this.bytes.buffer);
  private offset = 0;

  private reserve(count: number): void {
    const needed = this.offset + count;
    if (needed <= this.bytes.byteLength) return;
    let capacity = this.bytes.byteLength;
    while (capacity < needed) capacity *= 2;
    const next = new Uint8Array(capacity);
    next.set(this.bytes);
    this.bytes = next;
    this.view = new DataView(next.buffer);
  }

  u8(value: number): void {
    this.reserve(1);
    this.bytes[this.offset] = value & 0xff;
    this.offset += 1;
  }

  u16(value: number): void {
    this.reserve(2);
    this.view.setUint16(this.offset, value, true);
    this.offset += 2;
  }

  u32(value: number): void {
    this.reserve(4);
    this.view.setUint32(this.offset, value >>> 0, true);
    this.offset += 4;
  }

  i32(value: number): void {
    this.reserve(4);
    this.view.setInt32(this.offset, value | 0, true);
    this.offset += 4;
  }

  f64(value: number): void {
    this.reserve(8);
    this.view.setFloat64(this.offset, value, true);
    this.offset += 8;
  }

  bool(value: boolean): void {
    this.u8(value ? 1 : 0);
  }

  string(value: string): void {
    const encoded = new TextEncoder().encode(value);
    if (encoded.byteLength > 65_535) {
      throw new Error("pipeline binary string exceeds 65535 bytes");
    }
    this.u16(encoded.byteLength);
    this.reserve(encoded.byteLength);
    this.bytes.set(encoded, this.offset);
    this.offset += encoded.byteLength;
  }

  finish(kind: number, requestId: number): Uint8Array {
    const payloadLength = HEADER_BYTES + this.offset;
    if (payloadLength > BOT_THINK_PIPELINE_MAX_FRAME_BYTES) {
      throw new Error("pipeline binary frame exceeds maximum size");
    }
    const frame = new Uint8Array(PREFIX_BYTES + payloadLength);
    const view = new DataView(frame.buffer);
    view.setUint32(0, payloadLength, true);
    frame[4] = MAGIC_0;
    frame[5] = MAGIC_1;
    frame[6] = BOT_THINK_PIPELINE_WIRE_VERSION;
    frame[7] = kind;
    view.setUint32(8, requestId >>> 0, true);
    frame.set(this.bytes.subarray(0, this.offset), 12);
    return frame;
  }
}

class Reader {
  private readonly bytes: Uint8Array;
  private readonly view: DataView;
  private offset = 12;

  constructor(frame: Uint8Array) {
    if (frame.byteLength < PREFIX_BYTES + HEADER_BYTES) {
      throw new Error("pipeline frame is shorter than its header");
    }
    this.bytes = frame;
    this.view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    const payloadLength = this.view.getUint32(0, true);
    if (payloadLength !== frame.byteLength - PREFIX_BYTES) {
      throw new Error("pipeline frame length mismatch");
    }
    if (payloadLength > BOT_THINK_PIPELINE_MAX_FRAME_BYTES) {
      throw new Error("pipeline frame exceeds maximum size");
    }
    if (frame[4] !== MAGIC_0 || frame[5] !== MAGIC_1) {
      throw new Error("pipeline frame magic mismatch");
    }
    if (frame[6] !== BOT_THINK_PIPELINE_WIRE_VERSION) {
      throw new Error("pipeline wire version mismatch");
    }
  }

  kind(): number {
    return this.bytes[7]!;
  }

  requestId(): number {
    return this.view.getUint32(8, true);
  }

  private require(count: number): void {
    if (count < 0 || this.offset + count > this.bytes.byteLength) {
      throw new Error("pipeline frame ended early");
    }
  }

  u8(): number {
    this.require(1);
    const value = this.bytes[this.offset]!;
    this.offset += 1;
    return value;
  }

  u16(): number {
    this.require(2);
    const value = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return value;
  }

  u32(): number {
    this.require(4);
    const value = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return value;
  }

  i32(): number {
    this.require(4);
    const value = this.view.getInt32(this.offset, true);
    this.offset += 4;
    return value;
  }

  f64(): number {
    this.require(8);
    const value = this.view.getFloat64(this.offset, true);
    this.offset += 8;
    return value;
  }

  bool(): boolean {
    return this.u8() !== 0;
  }

  string(): string {
    const length = this.u16();
    this.require(length);
    const value = new TextDecoder().decode(
      this.bytes.subarray(this.offset, this.offset + length),
    );
    this.offset += length;
    return value;
  }

  finish(): void {
    if (this.offset !== this.bytes.byteLength) {
      throw new Error("pipeline frame contains trailing bytes");
    }
  }
}

export function pipelineFramePayloadLength(prefix: Uint8Array): number {
  if (prefix.byteLength < PREFIX_BYTES) return -1;
  return new DataView(
    prefix.buffer,
    prefix.byteOffset,
    prefix.byteLength,
  ).getUint32(0, true);
}

function writePoint(writer: Writer, point: Readonly<{ x: number; z: number }>): void {
  writer.f64(point.x);
  writer.f64(point.z);
}

function readPoint(reader: Reader): { x: number; z: number } {
  return { x: reader.f64(), z: reader.f64() };
}

function writeSide(writer: Writer, side: BotMapSide): void {
  writer.u8(
    side.edge === "south" ? 0 : side.edge === "east" ? 1 :
      side.edge === "north" ? 2 : 3,
  );
  writer.f64(side.doorHalfWidth);
  writer.f64(side.spawnRadius);
}

function readSide(reader: Reader): BotMapSide {
  const edge = reader.u8();
  return {
    edge: edge === 0 ? "south" : edge === 1 ? "east" :
      edge === 2 ? "north" : "west",
    doorHalfWidth: reader.f64(),
    spawnRadius: reader.f64(),
  };
}

function writeMap(writer: Writer, map: BotMapDefinition): void {
  writer.string(map.id);
  writer.string(map.revision);
  writer.u16(map.formatVersion);
  writer.f64(map.bounds.minX);
  writer.f64(map.bounds.maxX);
  writer.f64(map.bounds.minZ);
  writer.f64(map.bounds.maxZ);
  writeSide(writer, map.teamA);
  writeSide(writer, map.teamB);
  writer.u32(map.walls.length);
  for (const wall of map.walls) {
    writer.string(wall.id);
    writer.f64(wall.ax);
    writer.f64(wall.az);
    writer.f64(wall.bx);
    writer.f64(wall.bz);
    writer.u8(wall.kind === "full" ? 0 : wall.kind === "half" ? 1 : 2);
  }
  writer.u32(map.wallCorners.length);
  for (const point of map.wallCorners) writePoint(writer, point);

  writer.u32(map.hints.nudges.length);
  for (const hint of map.hints.nudges) {
    writer.string(hint.id);
    writer.u8(hint.team === "A" ? 0 : 1);
    writer.u32(hint.points.length);
    for (const point of hint.points) writePoint(writer, point);
  }
  writer.u32(map.hints.camps.length);
  for (const hint of map.hints.camps) {
    writer.string(hint.id);
    writer.u8(hint.team === "A" ? 0 : 1);
    writePoint(writer, hint.point);
  }
  writer.u32(map.hints.sprints.length);
  for (const hint of map.hints.sprints) {
    writer.string(hint.id);
    writer.u8(hint.team === "A" ? 0 : 1);
    writer.u32(hint.polygon.length);
    for (const point of hint.polygon) writePoint(writer, point);
  }
  writer.u32(map.hints.spawns.length);
  for (const hint of map.hints.spawns) {
    writer.string(hint.id);
    writer.u8(hint.team === "A" ? 0 : 1);
    writePoint(writer, hint.start);
    writePoint(writer, hint.end);
  }
  writer.u32(map.hints.stuck.length);
  for (const hint of map.hints.stuck) {
    writer.string(hint.id);
    writer.u8(hint.team === "A" ? 0 : 1);
    writePoint(writer, hint.center);
    writer.f64(hint.radius);
    writer.f64(hint.yaw);
  }
}

function readMap(reader: Reader): BotMapDefinition {
  const id = reader.string();
  const revision = reader.string();
  const formatVersion = reader.u16();
  const bounds = {
    minX: reader.f64(),
    maxX: reader.f64(),
    minZ: reader.f64(),
    maxZ: reader.f64(),
  };
  const teamA = readSide(reader);
  const teamB = readSide(reader);
  const walls: Array<{
    id: string; ax: number; az: number; bx: number; bz: number;
    kind: "full" | "half" | "float";
  }> = [];
  const wallCount = reader.u32();
  for (let index = 0; index < wallCount; index += 1) {
    const wallId = reader.string();
    const ax = reader.f64();
    const az = reader.f64();
    const bx = reader.f64();
    const bz = reader.f64();
    const kind = reader.u8();
    walls.push({
      id: wallId,
      ax,
      az,
      bx,
      bz,
      kind: kind === 0 ? "full" : kind === 1 ? "half" : "float",
    });
  }
  const wallCorners: Array<{ x: number; z: number }> = [];
  const cornerCount = reader.u32();
  for (let index = 0; index < cornerCount; index += 1) {
    wallCorners.push(readPoint(reader));
  }

  const nudges: Array<{
    id: string; team: "A" | "B"; points: Array<{ x: number; z: number }>;
  }> = [];
  const nudgeCount = reader.u32();
  for (let index = 0; index < nudgeCount; index += 1) {
    const hintId = reader.string();
    const team: "A" | "B" = reader.u8() === 0 ? "A" : "B";
    const pointCount = reader.u32();
    const points: Array<{ x: number; z: number }> = [];
    for (let pointIndex = 0; pointIndex < pointCount; pointIndex += 1) {
      points.push(readPoint(reader));
    }
    nudges.push({ id: hintId, team, points });
  }
  const camps: Array<{
    id: string; team: "A" | "B"; point: { x: number; z: number };
  }> = [];
  const campCount = reader.u32();
  for (let index = 0; index < campCount; index += 1) {
    camps.push({
      id: reader.string(),
      team: reader.u8() === 0 ? "A" : "B",
      point: readPoint(reader),
    });
  }
  const sprints: Array<{
    id: string; team: "A" | "B"; polygon: Array<{ x: number; z: number }>;
  }> = [];
  const sprintCount = reader.u32();
  for (let index = 0; index < sprintCount; index += 1) {
    const hintId = reader.string();
    const team: "A" | "B" = reader.u8() === 0 ? "A" : "B";
    const pointCount = reader.u32();
    const polygon: Array<{ x: number; z: number }> = [];
    for (let pointIndex = 0; pointIndex < pointCount; pointIndex += 1) {
      polygon.push(readPoint(reader));
    }
    sprints.push({ id: hintId, team, polygon });
  }
  const spawns: Array<{
    id: string; team: "A" | "B"; start: { x: number; z: number };
    end: { x: number; z: number };
  }> = [];
  const spawnCount = reader.u32();
  for (let index = 0; index < spawnCount; index += 1) {
    spawns.push({
      id: reader.string(),
      team: reader.u8() === 0 ? "A" : "B",
      start: readPoint(reader),
      end: readPoint(reader),
    });
  }
  const stuck: Array<{
    id: string; team: "A" | "B"; center: { x: number; z: number };
    radius: number; yaw: number;
  }> = [];
  const stuckCount = reader.u32();
  for (let index = 0; index < stuckCount; index += 1) {
    stuck.push({
      id: reader.string(),
      team: reader.u8() === 0 ? "A" : "B",
      center: readPoint(reader),
      radius: reader.f64(),
      yaw: reader.f64(),
    });
  }
  return {
    id,
    revision,
    formatVersion,
    bounds,
    teamA,
    teamB,
    walls,
    wallCorners,
    hints: { nudges, camps, sprints, spawns, stuck },
  };
}

const ROLES: readonly BotRole[] = ["fill", "balance", "pool", "agent", "raid"];

function writeDefinition(writer: Writer, bot: BotDefinition): void {
  writer.string(bot.id);
  const role = ROLES.indexOf(bot.role);
  if (role < 0) throw new Error("pipeline bot role is not known");
  writer.u8(role);
  writer.string(bot.profile);
  writer.u32(bot.randomSeed);
  writer.bool(bot.profileData !== undefined);
  if (bot.profileData !== undefined) writer.string(bot.profileData);
}

function readDefinition(reader: Reader): BotDefinition {
  const id = reader.string();
  const role = ROLES[reader.u8()];
  if (role === undefined) throw new Error("pipeline bot role is not known");
  const profile = reader.string();
  const randomSeed = reader.u32();
  const profileData = reader.bool() ? reader.string() : undefined;
  return {
    id,
    role,
    profile,
    randomSeed,
    ...(profileData === undefined ? {} : { profileData }),
  };
}

function writeWeapon(writer: Writer, weapon: WeaponSnapshot): void {
  writer.u16(weapon.id);
  writer.i32(weapon.ammoInMagazine);
  writer.i32(weapon.spareClips);
  writer.bool(weapon.reloading);
  writer.f64(weapon.lastShotTick);
}

function readWeapon(reader: Reader): WeaponSnapshot {
  return {
    id: reader.u16(),
    ammoInMagazine: reader.i32(),
    spareClips: reader.i32(),
    reloading: reader.bool(),
    lastShotTick: reader.f64(),
  };
}

function writeInventory(writer: Writer, weapon: WeaponInventorySnapshot): void {
  writer.u16(weapon.id);
  writer.i32(weapon.ammoInMagazine);
  writer.i32(weapon.spareClips);
}

function readInventory(reader: Reader): WeaponInventorySnapshot {
  return {
    id: reader.u16(),
    ammoInMagazine: reader.i32(),
    spareClips: reader.i32(),
  };
}

function writeSkill(writer: Writer, skill: SkillSnapshot): void {
  writer.string(skill.id);
  writer.bool(skill.equipped);
  writer.f64(skill.charge);
  writer.i32(skill.activeUntilTick ?? NULL_I32);
  writer.u8(skill.canActivate === undefined ? 0 : skill.canActivate ? 2 : 1);
}

function readSkill(reader: Reader): SkillSnapshot {
  const id = reader.string();
  const equipped = reader.bool();
  const charge = reader.f64();
  const activeUntilTick = reader.i32();
  const activation = reader.u8();
  return {
    id,
    equipped,
    charge,
    activeUntilTick: activeUntilTick === NULL_I32 ? null : activeUntilTick,
    ...(activation === 0 ? {} : { canActivate: activation === 2 }),
  };
}

function writePlayer(writer: Writer, player: PlayerSnapshot): void {
  writer.string(player.id);
  writer.u8(player.kind === "human" ? 0 : player.kind === "bot" ? 1 : 2);
  writer.u8(player.team === "A" ? 0 : 1);
  let flags = 0;
  if (player.alive) flags |= 1;
  if (player.crouch) flags |= 2;
  if (player.onGround) flags |= 4;
  if (player.sprintStamina !== undefined) flags |= 8;
  if (player.moveYaw !== undefined) flags |= 16;
  if (player.matchPlayer !== undefined) flags |= 32;
  if (player.unlimitedAmmo !== undefined) flags |= 64;
  if (player.weapons !== undefined) flags |= 128;
  writer.u8(flags);
  let flags2 = 0;
  if (player.glitchState !== undefined) flags2 |= 1;
  if (player.moveYaw === null) flags2 |= 2;
  if (player.matchPlayer === true) flags2 |= 4;
  if (player.unlimitedAmmo === true) flags2 |= 8;
  writer.u8(flags2);
  writer.f64(player.health);
  writer.i32(player.score);
  writer.u32(player.spawnedAtTick);
  writer.f64(player.x);
  writer.f64(player.y);
  writer.f64(player.z);
  writer.f64(player.velocityX);
  writer.f64(player.velocityY);
  writer.f64(player.velocityZ);
  writer.f64(player.yaw);
  writer.f64(player.pitch);
  if (player.sprintStamina !== undefined) writer.f64(player.sprintStamina);
  if (player.moveYaw !== undefined && player.moveYaw !== null) {
    writer.f64(player.moveYaw);
  }
  if (player.weapons !== undefined) {
    writer.u16(player.weapons.length);
    for (const weapon of player.weapons) writeInventory(writer, weapon);
  }
  if (player.glitchState !== undefined) {
    writer.u8(
      player.glitchState === "hidden" ? 0 :
        player.glitchState === "revealed" ? 1 : 2,
    );
  }
  writeWeapon(writer, player.weapon);
  writer.u16(player.skills.length);
  for (const skill of player.skills) writeSkill(writer, skill);
}

function readPlayer(reader: Reader): PlayerSnapshot {
  const id = reader.string();
  const kind = reader.u8();
  const team = reader.u8();
  const flags = reader.u8();
  const flags2 = reader.u8();
  const health = reader.f64();
  const score = reader.i32();
  const spawnedAtTick = reader.u32();
  const x = reader.f64();
  const y = reader.f64();
  const z = reader.f64();
  const velocityX = reader.f64();
  const velocityY = reader.f64();
  const velocityZ = reader.f64();
  const yaw = reader.f64();
  const pitch = reader.f64();
  const sprintStamina = (flags & 8) !== 0 ? reader.f64() : undefined;
  const moveYaw = (flags & 16) === 0 ? undefined :
    (flags2 & 2) !== 0 ? null : reader.f64();
  const weapons: WeaponInventorySnapshot[] | undefined = (flags & 128) !== 0
    ? []
    : undefined;
  if (weapons !== undefined) {
    const count = reader.u16();
    for (let index = 0; index < count; index += 1) {
      weapons.push(readInventory(reader));
    }
  }
  let glitchState: "hidden" | "revealed" | "inactive" | undefined;
  if ((flags2 & 1) !== 0) {
    const tag = reader.u8();
    glitchState = tag === 0 ? "hidden" : tag === 1 ? "revealed" : "inactive";
  }
  const weapon = readWeapon(reader);
  const skillCount = reader.u16();
  const skills: SkillSnapshot[] = [];
  for (let index = 0; index < skillCount; index += 1) {
    skills.push(readSkill(reader));
  }
  return {
    id,
    kind: kind === 0 ? "human" : kind === 1 ? "bot" : "agent",
    team: team === 0 ? "A" : "B",
    alive: (flags & 1) !== 0,
    health,
    score,
    spawnedAtTick,
    x,
    y,
    z,
    velocityX,
    velocityY,
    velocityZ,
    yaw,
    pitch,
    crouch: (flags & 2) !== 0,
    onGround: (flags & 4) !== 0,
    ...(sprintStamina === undefined ? {} : { sprintStamina }),
    ...(moveYaw === undefined ? {} : { moveYaw }),
    ...((flags & 32) === 0 ? {} : { matchPlayer: (flags2 & 4) !== 0 }),
    ...((flags & 64) === 0 ? {} : { unlimitedAmmo: (flags2 & 8) !== 0 }),
    ...(weapons === undefined ? {} : { weapons }),
    ...(glitchState === undefined ? {} : { glitchState }),
    weapon,
    skills,
  };
}

function writeFrame(writer: Writer, frame: ThinkFrame): void {
  writer.u32(frame.tick);
  writer.f64(frame.simDelta);
  writer.string(frame.mapRevision);
  writer.bool(frame.doorsOpen);
  writer.i32(frame.doorChangeTick ?? NULL_I32);
  writer.i32(frame.teamScoreA);
  writer.i32(frame.teamScoreB);
  writer.u32(frame.players.length);
  for (const player of frame.players) writePlayer(writer, player);
  writer.bool(frame.matchOver === true);
}

function readFrame(reader: Reader): ThinkFrame {
  const tick = reader.u32();
  const simDelta = reader.f64();
  const mapRevision = reader.string();
  const doorsOpen = reader.bool();
  const doorChangeTick = reader.i32();
  const teamScoreA = reader.i32();
  const teamScoreB = reader.i32();
  const playerCount = reader.u32();
  const players: PlayerSnapshot[] = [];
  for (let index = 0; index < playerCount; index += 1) {
    players.push(readPlayer(reader));
  }
  const matchOver = reader.bool();
  return {
    tick,
    simDelta,
    mapRevision,
    doorsOpen,
    doorChangeTick: doorChangeTick === NULL_I32 ? null : doorChangeTick,
    teamScoreA,
    teamScoreB,
    players,
    ...(matchOver ? { matchOver: true } : {}),
  };
}

function writeThinkInput(writer: Writer, input: ThinkBatchInput): void {
  writeFrame(writer, input.frame);
  writer.u32(input.applyTick);
  writer.u32(input.bots.length);
  for (const bot of input.bots) {
    writer.string(bot.botId);
    writer.u32(bot.spawnedAtTick);
  }
}

function readThinkInput(reader: Reader): ThinkBatchInput {
  const frame = readFrame(reader);
  const applyTick = reader.u32();
  const count = reader.u32();
  const bots: Array<{ botId: string; spawnedAtTick: number }> = [];
  for (let index = 0; index < count; index += 1) {
    bots.push({ botId: reader.string(), spawnedAtTick: reader.u32() });
  }
  return { frame, applyTick, bots };
}

function writeInput(writer: Writer, input: BotInputIntent): void {
  let flags = 0;
  if (input.forward) flags |= 1;
  if (input.backward) flags |= 2;
  if (input.left) flags |= 4;
  if (input.right) flags |= 8;
  if (input.jump) flags |= 16;
  if (input.sprint) flags |= 32;
  if (input.crouch) flags |= 64;
  writer.u8(flags);
  writer.f64(input.yaw);
  writer.f64(input.pitch);
}

function readInput(reader: Reader): BotInputIntent {
  const flags = reader.u8();
  return {
    forward: (flags & 1) !== 0,
    backward: (flags & 2) !== 0,
    left: (flags & 4) !== 0,
    right: (flags & 8) !== 0,
    jump: (flags & 16) !== 0,
    sprint: (flags & 32) !== 0,
    crouch: (flags & 64) !== 0,
    yaw: reader.f64(),
    pitch: reader.f64(),
  };
}

/** Max look samples per action on the wire (one per sim tick of a bot period). */
const MAX_LOOK_SAMPLES = 255;

function writeLookSamples(
  writer: Writer,
  samples: readonly BotLookSample[] | undefined,
): void {
  const count = samples === undefined
    ? 0
    : samples.length > MAX_LOOK_SAMPLES
    ? MAX_LOOK_SAMPLES
    : samples.length;
  writer.u8(count);
  for (let index = 0; index < count; index += 1) {
    const sample = samples![index]!;
    writer.f64(sample.yaw);
    writer.f64(sample.pitch);
  }
}

function readLookSamples(reader: Reader): BotLookSample[] {
  const count = reader.u8();
  const samples: BotLookSample[] = [];
  for (let index = 0; index < count; index += 1) {
    const yaw = reader.f64();
    const pitch = reader.f64();
    samples.push({ yaw, pitch });
  }
  return samples;
}

function writeAction(writer: Writer, action: ReadyAction | null): void {
  if (action === null) {
    writer.u8(0);
    return;
  }
  let flags = 1;
  if (action.input !== null) flags |= 2;
  if (action.shoot !== undefined) flags |= 4;
  if (action.shoot === true) flags |= 8;
  if (action.reload !== undefined) flags |= 16;
  if (action.reload === true) flags |= 32;
  if (action.weapon !== undefined) flags |= 64;
  if (action.ability !== undefined) flags |= 128;
  writer.u8(flags);
  if (action.input !== null) {
    writeInput(writer, action.input);
    writeLookSamples(writer, action.lookSamples);
  }
  if (action.weapon !== undefined) writer.u16(action.weapon);
  if (action.ability !== undefined) writer.string(action.ability);
}

function readAction(reader: Reader): ReadyAction | null {
  const flags = reader.u8();
  if ((flags & 1) === 0) return null;
  const input = (flags & 2) !== 0 ? readInput(reader) : null;
  const lookSamples = input !== null ? readLookSamples(reader) : null;
  const weapon = (flags & 64) !== 0 ? reader.u16() : undefined;
  const ability = (flags & 128) !== 0 ? reader.string() : undefined;
  return {
    input,
    ...(lookSamples === null || lookSamples.length === 0
      ? {}
      : { lookSamples }),
    ...((flags & 4) === 0 ? {} : { shoot: (flags & 8) !== 0 }),
    ...((flags & 16) === 0 ? {} : { reload: (flags & 32) !== 0 }),
    ...(weapon === undefined ? {} : { weapon }),
    ...(ability === undefined ? {} : { ability }),
  };
}

function writeOutput(writer: Writer, output: ThinkBatchOutput): void {
  writer.u32(output.tick);
  writer.u32(output.applyTick);
  writer.string(output.mapRevision);
  writer.u32(output.decisions.length);
  for (const decision of output.decisions) {
    writer.string(decision.botId);
    writer.u32(decision.spawnedAtTick);
    writeAction(writer, decision.action);
  }
}

function readOutput(reader: Reader): ThinkBatchOutput {
  const tick = reader.u32();
  const applyTick = reader.u32();
  const mapRevision = reader.string();
  const count = reader.u32();
  const decisions: Array<{
    botId: string; spawnedAtTick: number; action: ReadyAction | null;
  }> = [];
  for (let index = 0; index < count; index += 1) {
    decisions.push({
      botId: reader.string(),
      spawnedAtTick: reader.u32(),
      action: readAction(reader),
    });
  }
  return { tick, applyTick, mapRevision, decisions };
}

function requestKind(request: BotThinkPipelineRequest): number {
  switch (request.type) {
    case "pipeline-hello":
      return REQUEST_HELLO;
    case "pipeline-load-map":
      return REQUEST_LOAD_MAP;
    case "pipeline-synchronize-bots":
      return REQUEST_SYNCHRONIZE_BOTS;
    case "pipeline-think-batch":
      return REQUEST_THINK_BATCH;
    case "pipeline-benchmark-ping":
      return REQUEST_BENCHMARK_PING;
    case "pipeline-benchmark-reset":
      return REQUEST_BENCHMARK_RESET;
    case "pipeline-benchmark-snapshot":
      return REQUEST_BENCHMARK_SNAPSHOT;
    case "pipeline-benchmark-repeat":
      return REQUEST_BENCHMARK_REPEAT;
    case "pipeline-shutdown":
      return REQUEST_SHUTDOWN;
  }
}

export function encodeBotThinkPipelineRequestFrame(
  request: BotThinkPipelineRequest,
): Uint8Array {
  const writer = new Writer();
  switch (request.type) {
    case "pipeline-hello":
      writer.u16(request.protocolVersion);
      writer.string(request.clientName);
      break;
    case "pipeline-load-map":
      writeMap(writer, request.map);
      break;
    case "pipeline-synchronize-bots":
      writer.u32(request.bots.length);
      for (const bot of request.bots) writeDefinition(writer, bot);
      break;
    case "pipeline-think-batch":
      writeThinkInput(writer, request.input);
      break;
    case "pipeline-benchmark-repeat":
      writeThinkInput(writer, request.input);
      writer.u32(request.iterations);
      break;
    case "pipeline-benchmark-ping":
    case "pipeline-benchmark-reset":
    case "pipeline-benchmark-snapshot":
    case "pipeline-shutdown":
      break;
  }
  return writer.finish(requestKind(request), request.requestId);
}

export function decodeBotThinkPipelineRequestFrame(
  frame: Uint8Array,
): BotThinkPipelineRequest {
  const reader = new Reader(frame);
  const requestId = reader.requestId();
  let request: BotThinkPipelineRequest;
  switch (reader.kind()) {
    case REQUEST_HELLO:
      request = {
        type: "pipeline-hello",
        requestId,
        protocolVersion: reader.u16(),
        clientName: reader.string(),
      };
      break;
    case REQUEST_LOAD_MAP:
      request = { type: "pipeline-load-map", requestId, map: readMap(reader) };
      break;
    case REQUEST_SYNCHRONIZE_BOTS: {
      const count = reader.u32();
      const bots: BotDefinition[] = [];
      for (let index = 0; index < count; index += 1) {
        bots.push(readDefinition(reader));
      }
      request = { type: "pipeline-synchronize-bots", requestId, bots };
      break;
    }
    case REQUEST_THINK_BATCH:
      request = {
        type: "pipeline-think-batch",
        requestId,
        input: readThinkInput(reader),
      };
      break;
    case REQUEST_BENCHMARK_PING:
      request = { type: "pipeline-benchmark-ping", requestId };
      break;
    case REQUEST_BENCHMARK_RESET:
      request = { type: "pipeline-benchmark-reset", requestId };
      break;
    case REQUEST_BENCHMARK_SNAPSHOT:
      request = { type: "pipeline-benchmark-snapshot", requestId };
      break;
    case REQUEST_BENCHMARK_REPEAT:
      request = {
        type: "pipeline-benchmark-repeat",
        requestId,
        input: readThinkInput(reader),
        iterations: reader.u32(),
      };
      break;
    case REQUEST_SHUTDOWN:
      request = { type: "pipeline-shutdown", requestId };
      break;
    default:
      throw new Error("unknown pipeline request kind");
  }
  reader.finish();
  return request;
}

function responseKind(response: BotThinkPipelineResponse): number {
  switch (response.type) {
    case "pipeline-hello":
      return RESPONSE_HELLO;
    case "pipeline-acknowledgement":
      return RESPONSE_ACKNOWLEDGEMENT;
    case "pipeline-think-batch-result":
      return RESPONSE_THINK_BATCH;
    case "pipeline-benchmark-snapshot":
      return RESPONSE_BENCHMARK_SNAPSHOT;
    case "pipeline-benchmark-repeat-result":
      return RESPONSE_BENCHMARK_REPEAT;
    case "pipeline-error":
      return RESPONSE_ERROR;
  }
}

export function encodeBotThinkPipelineResponseFrame(
  response: BotThinkPipelineResponse,
): Uint8Array {
  const writer = new Writer();
  switch (response.type) {
    case "pipeline-hello":
      writer.u16(response.protocolVersion);
      writer.string(response.engineVersion);
      break;
    case "pipeline-acknowledgement":
      writer.bool(response.accepted);
      break;
    case "pipeline-think-batch-result":
      writeOutput(writer, response.output);
      break;
    case "pipeline-benchmark-snapshot":
      writer.u32(response.timings.batches);
      writer.f64(response.timings.requestDecodeMs);
      writer.f64(response.timings.thinkMs);
      writer.f64(response.timings.responseEncodeMs);
      break;
    case "pipeline-benchmark-repeat-result":
      writer.u32(response.iterations);
      writer.f64(response.nativeThinkMs);
      writeOutput(writer, response.output);
      break;
    case "pipeline-error":
      writer.string(response.code);
      writer.string(response.message);
      writer.bool(response.recoverable);
      break;
  }
  return writer.finish(responseKind(response), response.requestId);
}

export function decodeBotThinkPipelineResponseFrame(
  frame: Uint8Array,
): BotThinkPipelineResponse {
  const reader = new Reader(frame);
  const requestId = reader.requestId();
  let response: BotThinkPipelineResponse;
  switch (reader.kind()) {
    case RESPONSE_HELLO:
      response = {
        type: "pipeline-hello",
        requestId,
        protocolVersion: reader.u16(),
        engineVersion: reader.string(),
      };
      break;
    case RESPONSE_ACKNOWLEDGEMENT:
      response = {
        type: "pipeline-acknowledgement",
        requestId,
        accepted: reader.bool(),
      };
      break;
    case RESPONSE_THINK_BATCH:
      response = {
        type: "pipeline-think-batch-result",
        requestId,
        output: readOutput(reader),
      };
      break;
    case RESPONSE_BENCHMARK_SNAPSHOT:
      response = {
        type: "pipeline-benchmark-snapshot",
        requestId,
        timings: {
          batches: reader.u32(),
          requestDecodeMs: reader.f64(),
          thinkMs: reader.f64(),
          responseEncodeMs: reader.f64(),
        },
      };
      break;
    case RESPONSE_BENCHMARK_REPEAT:
      response = {
        type: "pipeline-benchmark-repeat-result",
        requestId,
        iterations: reader.u32(),
        nativeThinkMs: reader.f64(),
        output: readOutput(reader),
      };
      break;
    case RESPONSE_ERROR:
      response = {
        type: "pipeline-error",
        requestId,
        code: reader.string(),
        message: reader.string(),
        recoverable: reader.bool(),
      };
      break;
    default:
      throw new Error("unknown pipeline response kind");
  }
  reader.finish();
  return response;
}

export function roundTripBotThinkPipelineRequest(
  request: BotThinkPipelineRequest,
): BotThinkPipelineRequest {
  return decodeBotThinkPipelineRequestFrame(
    encodeBotThinkPipelineRequestFrame(request),
  );
}

export function roundTripBotThinkPipelineResponse(
  response: BotThinkPipelineResponse,
): BotThinkPipelineResponse {
  return decodeBotThinkPipelineResponseFrame(
    encodeBotThinkPipelineResponseFrame(response),
  );
}

/** Decode then re-encode one frame. Isolates the codec from think. */
export function echoBotThinkPipelineFrame(frame: Uint8Array): Uint8Array {
  if (frame.byteLength < PREFIX_BYTES + HEADER_BYTES) {
    throw new Error("pipeline frame is shorter than its header");
  }
  const kind = frame[7]!;
  if (kind >= REQUEST_HELLO && kind <= REQUEST_BENCHMARK_REPEAT) {
    return encodeBotThinkPipelineRequestFrame(
      decodeBotThinkPipelineRequestFrame(frame),
    );
  }
  if (kind >= RESPONSE_HELLO && kind <= RESPONSE_BENCHMARK_REPEAT) {
    return encodeBotThinkPipelineResponseFrame(
      decodeBotThinkPipelineResponseFrame(frame),
    );
  }
  throw new Error("unknown pipeline frame kind");
}

export type PipelineCodecValue =
  | null
  | undefined
  | boolean
  | number
  | string
  | PipelineCodecValue[]
  | { readonly [key: string]: PipelineCodecValue };

function codecKeyPresent(keys: readonly string[], key: string): boolean {
  for (let index = 0; index < keys.length; index += 1) {
    if (keys[index] === key) return true;
  }
  return false;
}

/** First path where encode→decode did not preserve the value; null if lossless. */
export function findPipelineCodecDiff(
  left: PipelineCodecValue,
  right: PipelineCodecValue,
  path = "$",
): string | null {
  if (left === right) return null;
  if (typeof left === "number" && typeof right === "number") {
    if (left !== left && right !== right) return null;
    return path;
  }
  if (
    left === null || right === null ||
    left === undefined || right === undefined ||
    typeof left !== "object" || typeof right !== "object"
  ) {
    return path;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return path;
    if (left.length !== right.length) return path;
    for (let index = 0; index < left.length; index += 1) {
      const diff = findPipelineCodecDiff(
        left[index],
        right[index],
        `${path}[${index}]`,
      );
      if (diff !== null) return diff;
    }
    return null;
  }
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  for (let index = 0; index < leftKeys.length; index += 1) {
    const key = leftKeys[index]!;
    const diff = findPipelineCodecDiff(
      left[key],
      right[key],
      `${path}.${key}`,
    );
    if (diff !== null) return diff;
  }
  for (let index = 0; index < rightKeys.length; index += 1) {
    const key = rightKeys[index]!;
    if (codecKeyPresent(leftKeys, key)) continue;
    const diff = findPipelineCodecDiff(
      left[key],
      right[key],
      `${path}.${key}`,
    );
    if (diff !== null) return diff;
  }
  return null;
}
