/**
 * Encode / decode gameplay packets.
 * In-memory shapes match existing NetEvents payloads.
 */

import {
  ByteReader,
  ByteWriter,
  clampInt,
  fromCenti,
  fromMilli,
  toCenti,
  toMilli,
} from "./bytes.ts";
import {
  indexToProduct,
  indexToRank,
  indexToSkill,
  productToIndex,
  rankToIndex,
  skillToIndex,
} from "./catalog.ts";
import { readMap, writeMap, type WireDoorsMap } from "./mapBin.ts";
import {
  GAME_PROTO,
  NetOpcode,
  opcodeToEvent,
  eventToOpcode,
} from "./opcodes.ts";

export {
  GAME_PACKET_EVENT,
  GAME_PROTO,
  isEmptyGameEvent,
  isGameEvent,
  eventToOpcode,
  opcodeToEvent,
} from "./opcodes.ts";

export const SNAP_KEY_FORWARD = 1;
export const SNAP_KEY_BACKWARD = 2;
export const SNAP_KEY_LEFT = 4;
export const SNAP_KEY_RIGHT = 8;
export const SNAP_KEY_JUMP = 16;
export const SNAP_KEY_SPRINT = 32;
export const SNAP_KEY_CROUCH = 64;
/** One-shot standing melee lunge (same stamina gates as crouch-slide). */
export const SNAP_KEY_MELEE_LUNGE = 128;

export function encodeSnapKeys(input: {
  forward?: boolean;
  backward?: boolean;
  left?: boolean;
  right?: boolean;
  jump?: boolean;
  sprint?: boolean;
  crouch?: boolean;
  meleeLunge?: boolean;
} | null | undefined): number {
  if (!input) return 0;
  let keys = 0;
  if (input.forward) keys |= SNAP_KEY_FORWARD;
  if (input.backward) keys |= SNAP_KEY_BACKWARD;
  if (input.left) keys |= SNAP_KEY_LEFT;
  if (input.right) keys |= SNAP_KEY_RIGHT;
  if (input.jump) keys |= SNAP_KEY_JUMP;
  if (input.sprint) keys |= SNAP_KEY_SPRINT;
  if (input.crouch) keys |= SNAP_KEY_CROUCH;
  if (input.meleeLunge) keys |= SNAP_KEY_MELEE_LUNGE;
  return keys;
}

export type DecodedGamePacket = {
  event: string;
  opcode: NetOpcode;
  payload?: unknown;
};

// ── player flags ──────────────────────────────────────────────────────────

const PF_ALIVE = 1 << 0;
const PF_TEAM_B = 1 << 1;
const PF_AGENT = 1 << 2;
const PF_INVULN = 1 << 3;
const PF_CROUCH = 1 << 4;
const PF_SLIDE = 1 << 5;
const PF_RELOAD = 1 << 6;
const PF_SWITCH = 1 << 7;
const PF_CONN = 1 << 8;
const PF_AFK = 1 << 9;
const PF_HIT_SLOW = 1 << 10;
const PF_SLIDE_VEC = 1 << 11;
/** Version 3 encodes authoritative horizontal + vertical velocity together. */
const PF_VEL_XYZ = 1 << 12;
const PF_WEAPON = 1 << 13;
const PF_AMMO = 1 << 14;
const PF_STAMINA = 1 << 15;
const PF_ABILITIES = 1 << 16;
const PF_GLITCH = 1 << 17;
const PF_GLITCH_REVEALED = 1 << 18;
const PF_SEQ = 1 << 19;
const PF_HOLD = 1 << 20;
const PF_KEYS = 1 << 21;
const PF_BOT_DEC = 1 << 22;
const PF_PING = 1 << 23;
const PF_NAME = 1 << 24;
const PF_SCOREBOARD = 1 << 25;
const PF_COSMETICS = 1 << 26;
const PF_XP = 1 << 27;
const PF_RANK = 1 << 28;
const PF_FOUNDER = 1 << 29;
const PF_AFK_KICK = 1 << 30;
const PF_ABILITY_META = 1 << 31;

// Weapon byte (under PF_WEAPON): low 7 bits = weapon id, bit 7 = pumping.
const WEAPON_BYTE_ID_MASK = 0x7f;
const WEAPON_BYTE_PUMPING = 0x80;

type AbilityEntry = {
  id: string;
  endsAtTick: number;
  cooldownEndsAtTick?: number;
  fromX?: number;
  fromY?: number;
  fromZ?: number;
};

export type WireSnapshotPlayer = {
  id: string;
  name?: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  health: number;
  scale?: number;
  alive: boolean;
  team: "A" | "B";
  isAgent?: boolean;
  invulnerable?: boolean;
  crouch?: boolean;
  slide?: boolean;
  hitSlowStacks?: number;
  hitSlowEndsAtTick?: number;
  slideRemaining?: number;
  slideDirX?: number;
  slideDirZ?: number;
  velocityX?: number;
  velocityY?: number;
  velocityZ?: number;
  weapon?: number;
  ammoInMag?: number;
  spareClips?: number;
  reloading?: boolean;
  /** Shell guns: cocking. Rides bit 7 of the weapon byte (flag word is full). */
  pumping?: boolean;
  switching?: boolean;
  sprintStamina?: number;
  abilities?: AbilityEntry[];
  abilitySpent?: string[];
  abilityLockEndsAtTick?: number;
  abilityRegenEndsAtTick?: number;
  glitch?: "hidden" | "revealed";
  lastProcessedInputSeq?: number;
  inputHoldTicks?: number;
  keys?: number;
  botDec?: number;
  score?: number;
  kills?: number;
  deaths?: number;
  xp?: number;
  mmsRankId?: string;
  founderBadge?: boolean;
  connectionIssue?: boolean;
  afk?: boolean;
  afkKickIn?: number;
  ping?: number;
  head?: number;
  visor?: number;
  shoulder?: number;
  body?: number;
  leg?: number;
  hue?: number;
  gunHue?: number;
  pistol?: number;
  rifle?: number;
  shotgun?: number;
  crosshair?: number;
  /** Rifle optic 0…4. Omitted means Standard. */
  scope?: number;
  /** Bullet tracer hue step -2…2. */
  bulletHue?: number;
  /** Packed crosshair color (shared/sim/game.ts); -1 = default. */
  crosshairColor?: number;
  /** Own name tag hue shift -2…2 off team color. */
  nameHue?: number;
};

function writePlayer(w: ByteWriter, p: WireSnapshotPlayer): void {
  const full = p.name != null;
  let flags = 0;
  if (p.alive) flags |= PF_ALIVE;
  if (p.team === "B") flags |= PF_TEAM_B;
  if (p.isAgent) flags |= PF_AGENT;
  if (p.invulnerable) flags |= PF_INVULN;
  if (p.crouch) flags |= PF_CROUCH;
  if (p.slide) flags |= PF_SLIDE;
  if (p.reloading) flags |= PF_RELOAD;
  if (p.switching) flags |= PF_SWITCH;
  if (p.connectionIssue) flags |= PF_CONN;
  if (p.afk) flags |= PF_AFK;
  if (p.hitSlowStacks) flags |= PF_HIT_SLOW;
  if (p.slide && p.slideRemaining != null) flags |= PF_SLIDE_VEC;
  if (p.velocityX != null || p.velocityY != null || p.velocityZ != null) {
    flags |= PF_VEL_XYZ;
  }
  if (p.weapon != null || p.pumping) flags |= PF_WEAPON;
  if (p.ammoInMag != null || p.spareClips != null) flags |= PF_AMMO;
  if (p.sprintStamina != null) flags |= PF_STAMINA;
  if (p.abilities && p.abilities.length > 0) flags |= PF_ABILITIES;
  if (p.glitch) {
    flags |= PF_GLITCH;
    if (p.glitch === "revealed") flags |= PF_GLITCH_REVEALED;
  }
  if (p.lastProcessedInputSeq != null) flags |= PF_SEQ;
  if (p.inputHoldTicks != null) flags |= PF_HOLD;
  if (p.keys != null) flags |= PF_KEYS;
  if (p.botDec != null) flags |= PF_BOT_DEC;
  if (p.ping != null) flags |= PF_PING;
  if (full) flags |= PF_NAME;
  if (p.score != null || p.kills != null || p.deaths != null) {
    flags |= PF_SCOREBOARD;
  }
  if (
    p.head != null || p.visor != null || p.shoulder != null || p.body != null ||
    p.leg != null || p.hue != null || p.gunHue != null || p.pistol != null ||
    p.rifle != null || p.shotgun != null || p.crosshair != null ||
    p.scope != null || p.bulletHue != null || p.crosshairColor != null ||
    p.nameHue != null
  ) {
    flags |= PF_COSMETICS;
  }
  if (p.xp != null) flags |= PF_XP;
  if (p.mmsRankId != null) flags |= PF_RANK;
  if (p.founderBadge) flags |= PF_FOUNDER;
  if (p.afkKickIn != null) flags |= PF_AFK_KICK;
  if (
    (p.abilitySpent && p.abilitySpent.length > 0) ||
    p.abilityLockEndsAtTick != null ||
    p.abilityRegenEndsAtTick != null
  ) {
    flags |= PF_ABILITY_META;
  }

  w.u32(flags >>> 0);
  w.str8(p.id);
  if (full) {
    w.f32(p.x);
    w.f32(p.y);
    w.f32(p.z);
    w.f32(p.yaw);
    w.f32(p.pitch);
  } else {
    w.i32(toMilli(p.x));
    w.i32(toMilli(p.y));
    w.i32(toMilli(p.z));
    w.i16(toMilli(p.yaw));
    w.i16(toMilli(p.pitch));
  }
  w.u8(Math.max(0, Math.min(255, Math.round(p.health))));
  w.u8(Math.max(10, Math.min(255, Math.round((p.scale ?? 1) * 100))));

  if (flags & PF_HIT_SLOW) {
    w.u8(p.hitSlowStacks ?? 0);
    w.u32(p.hitSlowEndsAtTick ?? 0);
  }
  if (flags & PF_SLIDE_VEC) {
    w.i16(toCenti(p.slideRemaining ?? 0));
    w.i16(toMilli(p.slideDirX ?? 0));
    w.i16(toMilli(p.slideDirZ ?? 0));
  }
  if (flags & PF_VEL_XYZ) {
    w.i16(toCenti(p.velocityX ?? 0));
    w.i16(toCenti(p.velocityY ?? 0));
    w.i16(toCenti(p.velocityZ ?? 0));
  }
  if (flags & PF_WEAPON) {
    w.u8(((p.weapon ?? 0) & WEAPON_BYTE_ID_MASK) |
      (p.pumping ? WEAPON_BYTE_PUMPING : 0));
  }
  if (flags & PF_AMMO) {
    w.u8(p.ammoInMag ?? 0);
    w.u8(p.spareClips ?? 0);
  }
  if (flags & PF_STAMINA) w.i16(toCenti(p.sprintStamina ?? 0));
  if (flags & PF_ABILITIES) {
    const abs = p.abilities ?? [];
    w.u8(Math.min(255, abs.length));
    for (const a of abs) {
      let af = 0;
      if (a.fromX != null) af |= 1;
      if (a.cooldownEndsAtTick != null) af |= 2;
      w.u8(af);
      w.u8(skillToIndex(a.id));
      w.u32(a.endsAtTick);
      if (af & 2) w.u32(a.cooldownEndsAtTick ?? 0);
      if (af & 1) {
        w.f32(a.fromX ?? 0);
        w.f32(a.fromY ?? 0);
        w.f32(a.fromZ ?? 0);
      }
    }
  }
  if (flags & PF_SEQ) w.u32(p.lastProcessedInputSeq ?? 0);
  if (flags & PF_HOLD) w.u8(p.inputHoldTicks ?? 0);
  if (flags & PF_KEYS) w.u8(p.keys ?? 0);
  if (flags & PF_BOT_DEC) w.u32(p.botDec ?? 0);
  if (flags & PF_PING) w.u16(Math.max(0, Math.min(65535, Math.round(p.ping ?? 0))));
  if (flags & PF_NAME) w.str8(p.name ?? "");
  if (flags & PF_SCOREBOARD) {
    // i16: teamkill penalty is −2 kills and must not wrap to ~65534 on TAB.
    w.i16(clampInt(p.score ?? 0, -32768, 32767));
    w.i16(clampInt(p.kills ?? 0, -32768, 32767));
    w.i16(clampInt(p.deaths ?? 0, -32768, 32767));
  }
  if (flags & PF_COSMETICS) {
    w.u8(p.head ?? 0);
    w.u8(p.visor ?? 0);
    w.u8(p.shoulder ?? 0);
    w.u8(p.body ?? 0);
    w.u8(p.leg ?? 0);
    w.i16(toMilli(p.hue ?? 0));
    w.i16(toMilli(p.gunHue ?? 0));
    w.u8(p.pistol ?? 0);
    w.u8(p.rifle ?? 0);
    w.u8(p.shotgun ?? 0);
    w.u8(p.crosshair ?? 0);
    // Append new cosmetics at the end; inserting earlier shifts every recording.
    w.u8(p.scope ?? 0);
    w.i16(toMilli(p.bulletHue ?? 0));
    w.i32(p.crosshairColor ?? -1);
    w.i16(toMilli(p.nameHue ?? 0));
  }
  if (flags & PF_XP) w.u32(p.xp ?? 0);
  if (flags & PF_RANK) w.u8(rankToIndex(p.mmsRankId));
  if (flags & PF_AFK_KICK) w.u8(p.afkKickIn ?? 0);
  if (flags & PF_ABILITY_META) {
    const spent = p.abilitySpent ?? [];
    w.u8(Math.min(255, spent.length));
    for (const id of spent) w.u8(skillToIndex(id));
    w.u32(p.abilityLockEndsAtTick ?? 0);
    w.u32(p.abilityRegenEndsAtTick ?? 0);
  }
}

function readPlayer(r: ByteReader): WireSnapshotPlayer {
  const flags = r.u32();
  const id = r.str8();
  const full = (flags & PF_NAME) !== 0;
  let x: number, y: number, z: number, yaw: number, pitch: number;
  if (full) {
    x = r.f32();
    y = r.f32();
    z = r.f32();
    yaw = r.f32();
    pitch = r.f32();
  } else {
    x = fromMilli(r.i32());
    y = fromMilli(r.i32());
    z = fromMilli(r.i32());
    yaw = fromMilli(r.i16());
    pitch = fromMilli(r.i16());
  }
  const health = r.u8();
  const scale = r.u8() / 100;
  const p: WireSnapshotPlayer = {
    id,
    x,
    y,
    z,
    yaw,
    pitch,
    health,
    alive: (flags & PF_ALIVE) !== 0,
    team: flags & PF_TEAM_B ? "B" : "A",
  };
  if (scale !== 1) p.scale = scale;
  if (flags & PF_AGENT) p.isAgent = true;
  if (flags & PF_INVULN) p.invulnerable = true;
  if (flags & PF_CROUCH) p.crouch = true;
  p.slide = (flags & PF_SLIDE) !== 0;
  if (flags & PF_RELOAD) p.reloading = true;
  if (flags & PF_SWITCH) p.switching = true;
  if (flags & PF_CONN) p.connectionIssue = true;
  if (flags & PF_AFK) p.afk = true;
  if (flags & PF_HIT_SLOW) {
    p.hitSlowStacks = r.u8();
    p.hitSlowEndsAtTick = r.u32();
  }
  if (flags & PF_SLIDE_VEC) {
    p.slideRemaining = fromCenti(r.i16());
    p.slideDirX = fromMilli(r.i16());
    p.slideDirZ = fromMilli(r.i16());
  }
  if (flags & PF_VEL_XYZ) {
    p.velocityX = fromCenti(r.i16());
    p.velocityY = fromCenti(r.i16());
    p.velocityZ = fromCenti(r.i16());
  }
  if (flags & PF_WEAPON) {
    const b = r.u8();
    p.weapon = b & WEAPON_BYTE_ID_MASK;
    if (b & WEAPON_BYTE_PUMPING) p.pumping = true;
  }
  if (flags & PF_AMMO) {
    p.ammoInMag = r.u8();
    p.spareClips = r.u8();
  }
  if (flags & PF_STAMINA) p.sprintStamina = fromCenti(r.i16());
  if (flags & PF_ABILITIES) {
    const n = r.u8();
    const abs: AbilityEntry[] = [];
    for (let i = 0; i < n; i++) {
      const af = r.u8();
      const skill = indexToSkill(r.u8());
      const endsAtTick = r.u32();
      const entry: AbilityEntry = { id: skill ?? "quick", endsAtTick };
      if (af & 2) entry.cooldownEndsAtTick = r.u32();
      if (af & 1) {
        entry.fromX = r.f32();
        entry.fromY = r.f32();
        entry.fromZ = r.f32();
      }
      if (skill) abs.push(entry);
    }
    if (abs.length) p.abilities = abs;
  }
  if (flags & PF_GLITCH) {
    p.glitch = flags & PF_GLITCH_REVEALED ? "revealed" : "hidden";
  }
  if (flags & PF_SEQ) p.lastProcessedInputSeq = r.u32();
  if (flags & PF_HOLD) p.inputHoldTicks = r.u8();
  if (flags & PF_KEYS) p.keys = r.u8();
  if (flags & PF_BOT_DEC) p.botDec = r.u32();
  if (flags & PF_PING) p.ping = r.u16();
  if (flags & PF_NAME) p.name = r.str8();
  if (flags & PF_SCOREBOARD) {
    p.score = r.i16();
    p.kills = r.i16();
    p.deaths = r.i16();
  }
  if (flags & PF_COSMETICS) {
    p.head = r.u8();
    p.visor = r.u8();
    p.shoulder = r.u8();
    p.body = r.u8();
    p.leg = r.u8();
    p.hue = fromMilli(r.i16());
    p.gunHue = fromMilli(r.i16());
    p.pistol = r.u8();
    p.rifle = r.u8();
    p.shotgun = r.u8();
    p.crosshair = r.u8();
    p.scope = r.u8();
    p.bulletHue = fromMilli(r.i16());
    p.crosshairColor = r.i32();
    p.nameHue = fromMilli(r.i16());
  }
  if (flags & PF_XP) p.xp = r.u32();
  if (flags & PF_RANK) {
    const rank = indexToRank(r.u8());
    if (rank) p.mmsRankId = rank;
  }
  if (flags & PF_FOUNDER) p.founderBadge = true;
  if (flags & PF_AFK_KICK) p.afkKickIn = r.u8();
  if (flags & PF_ABILITY_META) {
    const n = r.u8();
    const spent: string[] = [];
    for (let i = 0; i < n; i++) {
      const id = indexToSkill(r.u8());
      if (id) spent.push(id);
    }
    if (spent.length) p.abilitySpent = spent;
    const lock = r.u32();
    const regen = r.u32();
    if (lock) p.abilityLockEndsAtTick = lock;
    if (regen) p.abilityRegenEndsAtTick = regen;
  }
  return p;
}

function writeVec3(w: ByteWriter, v: [number, number, number]): void {
  w.f32(v[0]);
  w.f32(v[1]);
  w.f32(v[2]);
}

function readVec3(r: ByteReader): [number, number, number] {
  return [r.f32(), r.f32(), r.f32()];
}

function writeScores(w: ByteWriter, s: { A: number; B: number }): void {
  w.u16(s.A);
  w.u16(s.B);
}

function readScores(r: ByteReader): { A: number; B: number } {
  return { A: r.u16(), B: r.u16() };
}

function phaseToU8(p: unknown): number {
  if (p === "prematch") return 0;
  if (p === "intermission") return 2;
  return 1;
}

function u8ToPhase(n: number): "prematch" | "live" | "intermission" {
  if (n === 0) return "prematch";
  if (n === 2) return "intermission";
  return "live";
}

function writeHeader(w: ByteWriter, opcode: NetOpcode, flags = 0): void {
  w.u8(GAME_PROTO);
  w.u8(opcode);
  w.u16(flags);
}

function asRecord(payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== "object") return null;
  return payload as Record<string, unknown>;
}

function writeInput(w: ByteWriter, payload: unknown): boolean {
  const o = asRecord(payload);
  if (!o || typeof o.sequence !== "number" || typeof o.yaw !== "number" ||
    typeof o.pitch !== "number") {
    return false;
  }
  writeHeader(w, NetOpcode.Input);
  w.u32(o.sequence);
  w.u8(encodeSnapKeys(o as { forward?: boolean }));
  w.i16(toMilli(o.yaw as number));
  w.i16(toMilli(o.pitch as number));
  return true;
}

function readInput(r: ByteReader): unknown {
  const sequence = r.u32();
  const keys = r.u8();
  const yaw = fromMilli(r.i16());
  const pitch = fromMilli(r.i16());
  return {
    sequence,
    forward: (keys & SNAP_KEY_FORWARD) !== 0,
    backward: (keys & SNAP_KEY_BACKWARD) !== 0,
    left: (keys & SNAP_KEY_LEFT) !== 0,
    right: (keys & SNAP_KEY_RIGHT) !== 0,
    jump: (keys & SNAP_KEY_JUMP) !== 0,
    sprint: (keys & SNAP_KEY_SPRINT) !== 0,
    crouch: (keys & SNAP_KEY_CROUCH) !== 0,
    meleeLunge: (keys & SNAP_KEY_MELEE_LUNGE) !== 0,
    yaw,
    pitch,
  };
}

function writeAim(w: ByteWriter, opcode: NetOpcode, payload: unknown): boolean {
  const o = asRecord(payload);
  if (!o || typeof o.yaw !== "number" || typeof o.pitch !== "number") {
    return false;
  }
  let flags = 0;
  const origin = Array.isArray(o.origin) && o.origin.length === 3
    ? o.origin as [number, number, number]
    : null;
  if (origin) flags |= 1;
  if (typeof o.sequence === "number") flags |= 2;
  if (typeof o.clientTick === "number") flags |= 4;
  if (typeof o.lastAppliedSnapshotTick === "number") flags |= 8;
  writeHeader(w, opcode, flags);
  w.f32(o.yaw as number);
  w.f32(o.pitch as number);
  if (origin) writeVec3(w, origin);
  if (flags & 2) w.u32(o.sequence as number);
  if (flags & 4) w.u32(o.clientTick as number);
  if (flags & 8) w.u32(o.lastAppliedSnapshotTick as number);
  return true;
}

function writeShoot(w: ByteWriter, payload: unknown): boolean {
  return writeAim(w, NetOpcode.Shoot, payload);
}

/** Pistol-whip request — same wire shape as a shot (aim + origin + ticks). */
function writeMelee(w: ByteWriter, payload: unknown): boolean {
  return writeAim(w, NetOpcode.Melee, payload);
}

function readShoot(r: ByteReader, flags: number): unknown {
  const yaw = r.f32();
  const pitch = r.f32();
  const out: Record<string, unknown> = { yaw, pitch };
  if (flags & 1) out.origin = readVec3(r);
  if (flags & 2) out.sequence = r.u32();
  if (flags & 4) out.clientTick = r.u32();
  if (flags & 8) out.lastAppliedSnapshotTick = r.u32();
  return out;
}

function writeSnapshot(w: ByteWriter, payload: unknown): boolean {
  const o = asRecord(payload);
  if (!o || typeof o.tick !== "number" || !Array.isArray(o.players)) {
    return false;
  }
  const scores = o.scores as { A: number; B: number } | undefined;
  if (!scores) return false;
  const transport = o.transport as
    | { emitSeq: number; emitAtMs: number; kind: string }
    | undefined;
  let flags = 0;
  if (o.doorsOpen) flags |= 1;
  if (o.phase != null) flags |= 2;
  if (transport) {
    flags |= 4;
    if (transport.kind === "heartbeat") flags |= 8;
    else if (transport.kind === "catchup") flags |= 16;
  }
  writeHeader(w, NetOpcode.Snapshot, flags);
  w.u32(o.tick as number);
  w.u32((o.doorChangeTick as number) ?? 0);
  w.u32((o.matchEndTick as number) ?? 0);
  writeScores(w, scores);
  if (flags & 2) w.u8(phaseToU8(o.phase));
  if (transport) {
    w.u32(transport.emitSeq);
    w.f64(transport.emitAtMs);
  }
  const players = o.players as WireSnapshotPlayer[];
  w.u8(Math.min(255, players.length));
  for (const p of players) writePlayer(w, p);
  const projectiles = Array.isArray(o.projectiles)
    ? o.projectiles as Array<{ id: string; x: number; y: number; z: number }>
    : [];
  w.u8(Math.min(255, projectiles.length));
  for (const pr of projectiles) {
    w.str8(pr.id);
    w.f32(pr.x);
    w.f32(pr.y);
    w.f32(pr.z);
  }
  return true;
}

function readSnapshot(r: ByteReader, flags: number): unknown {
  const tick = r.u32();
  const doorChangeTick = r.u32();
  const matchEndTick = r.u32();
  const scores = readScores(r);
  const out: Record<string, unknown> = {
    tick,
    doorsOpen: (flags & 1) !== 0,
    doorChangeTick,
    matchEndTick,
    scores,
    players: [] as WireSnapshotPlayer[],
    projectiles: [] as Array<{ id: string; x: number; y: number; z: number }>,
  };
  if (flags & 2) out.phase = u8ToPhase(r.u8());
  if (flags & 4) {
    const emitSeq = r.u32();
    const emitAtMs = r.f64();
    let kind: "volatile" | "heartbeat" | "catchup" = "volatile";
    if (flags & 8) kind = "heartbeat";
    else if (flags & 16) kind = "catchup";
    out.transport = { emitSeq, emitAtMs, kind };
  }
  const n = r.u8();
  const players: WireSnapshotPlayer[] = [];
  for (let i = 0; i < n; i++) players.push(readPlayer(r));
  out.players = players;
  const pn = r.u8();
  const projectiles: Array<{ id: string; x: number; y: number; z: number }> = [];
  for (let i = 0; i < pn; i++) {
    projectiles.push({ id: r.str8(), x: r.f32(), y: r.f32(), z: r.f32() });
  }
  out.projectiles = projectiles;
  return out;
}

function writeShot(w: ByteWriter, s: Record<string, unknown>): void {
  w.str8(String(s.shooterId ?? ""));
  writeVec3(w, (s.origin as [number, number, number]) ?? [0, 0, 0]);
  writeVec3(w, (s.direction as [number, number, number]) ?? [0, 0, 0]);
  w.u8((s.weapon as number) ?? 0);
  const hitId = typeof s.hitId === "string" ? s.hitId : null;
  const hitZone = s.hitZone === "head" ? 1 : s.hitZone === "body" ? 2 : 0;
  const hitPoint = Array.isArray(s.hitPoint)
    ? s.hitPoint as [number, number, number]
    : null;
  let flags = 0;
  if (hitId) flags |= 1;
  if (hitZone) flags |= 2;
  if (hitPoint) flags |= 4;
  // Pistol-whip outcome (no tracer / gunshot on clients).
  if (s.melee === true) flags |= 8;
  // Multi-pellet block (shotgun): every pellet, index 0 = centre.
  const pellets = Array.isArray(s.pellets)
    ? s.pellets as Array<Record<string, unknown>>
    : null;
  if (pellets && pellets.length > 0) flags |= 16;
  w.u8(flags);
  if (hitId) w.str8(hitId);
  if (hitZone) w.u8(hitZone);
  if (hitPoint) writeVec3(w, hitPoint);
  if (flags & 16) {
    const n = Math.min(255, pellets!.length);
    w.u8(n);
    for (let i = 0; i < n; i++) writeShotPellet(w, pellets![i]!);
  }
}

function writeShotPellet(w: ByteWriter, p: Record<string, unknown>): void {
  writeVec3(w, (p.direction as [number, number, number]) ?? [0, 0, 0]);
  const hitId = typeof p.hitId === "string" ? p.hitId : null;
  const hitZone = p.hitZone === "head" ? 1 : p.hitZone === "body" ? 2 : 0;
  const hitPoint = Array.isArray(p.hitPoint)
    ? p.hitPoint as [number, number, number]
    : null;
  let flags = 0;
  if (hitId) flags |= 1;
  if (hitZone) flags |= 2;
  if (hitPoint) flags |= 4;
  w.u8(flags);
  if (hitId) w.str8(hitId);
  if (hitZone) w.u8(hitZone);
  if (hitPoint) writeVec3(w, hitPoint);
}

function readShotPellet(r: ByteReader): Record<string, unknown> {
  const direction = readVec3(r);
  const flags = r.u8();
  const pellet: Record<string, unknown> = {
    direction,
    hitId: null,
    hitZone: null,
    hitPoint: null,
  };
  if (flags & 1) pellet.hitId = r.str8();
  if (flags & 2) pellet.hitZone = r.u8() === 1 ? "head" : "body";
  if (flags & 4) pellet.hitPoint = readVec3(r);
  return pellet;
}

function readShot(r: ByteReader): Record<string, unknown> {
  const shooterId = r.str8();
  const origin = readVec3(r);
  const direction = readVec3(r);
  const weapon = r.u8();
  const flags = r.u8();
  const shot: Record<string, unknown> = {
    shooterId,
    origin,
    direction,
    weapon,
    hitId: null,
    hitZone: null,
    hitPoint: null,
  };
  if (flags & 1) shot.hitId = r.str8();
  if (flags & 2) shot.hitZone = r.u8() === 1 ? "head" : "body";
  if (flags & 4) shot.hitPoint = readVec3(r);
  if (flags & 8) shot.melee = true;
  if (flags & 16) {
    const n = r.u8();
    const pellets: Array<Record<string, unknown>> = [];
    for (let i = 0; i < n; i++) pellets.push(readShotPellet(r));
    shot.pellets = pellets;
  }
  return shot;
}

function writeDamage(w: ByteWriter, d: Record<string, unknown>): void {
  w.str8(String(d.targetId ?? ""));
  w.str8(String(d.shooterId ?? ""));
  w.u16((d.damage as number) ?? 0);
  w.u8((d.health as number) ?? 0);
  w.u8(d.zone === "head" ? 1 : 2);
  let flags = 0;
  if (d.alive) flags |= 1;
  if (d.critical) flags |= 2;
  if (d.hitSlowStacks != null) flags |= 4;
  w.u8(flags);
  if (flags & 4) {
    w.u8(d.hitSlowStacks as number);
    w.u32((d.hitSlowEndsAtTick as number) ?? 0);
  }
}

function readDamage(r: ByteReader): Record<string, unknown> {
  const targetId = r.str8();
  const shooterId = r.str8();
  const damage = r.u16();
  const health = r.u8();
  const zone = r.u8() === 1 ? "head" : "body";
  const flags = r.u8();
  const out: Record<string, unknown> = {
    targetId,
    shooterId,
    damage,
    health,
    zone,
    alive: (flags & 1) !== 0,
    critical: (flags & 2) !== 0,
  };
  if (flags & 4) {
    out.hitSlowStacks = r.u8();
    out.hitSlowEndsAtTick = r.u32();
  }
  return out;
}

function writeDeath(w: ByteWriter, d: Record<string, unknown>): void {
  w.str8(String(d.victimId ?? ""));
  w.str8(String(d.killerId ?? ""));
  w.u8(d.zone === "head" ? 1 : 2);
  w.u8((d.weapon as number) ?? 0);
  w.str8(String(d.killerName ?? ""));
  w.str8(String(d.victimName ?? ""));
  let flags = 0;
  if (d.killerTeam === "B") flags |= 1;
  if (d.victimTeam === "B") flags |= 2;
  if (d.killerIsAgent) flags |= 4;
  if (d.victimIsAgent) flags |= 8;
  w.u8(flags);
}

function readDeath(r: ByteReader): Record<string, unknown> {
  const victimId = r.str8();
  const killerId = r.str8();
  const zone = r.u8() === 1 ? "head" : "body";
  const weapon = r.u8();
  const killerName = r.str8();
  const victimName = r.str8();
  const flags = r.u8();
  const out: Record<string, unknown> = {
    victimId,
    killerId,
    zone,
    weapon,
    killerName,
    victimName,
    killerTeam: flags & 1 ? "B" : "A",
    victimTeam: flags & 2 ? "B" : "A",
  };
  if (flags & 4) out.killerIsAgent = true;
  if (flags & 8) out.victimIsAgent = true;
  return out;
}

function writeCombatBurst(w: ByteWriter, payload: unknown): boolean {
  const o = asRecord(payload);
  if (!o || !Array.isArray(o.outcomes)) return false;
  writeHeader(w, NetOpcode.CombatBurst);
  const outcomes = o.outcomes as Array<Record<string, unknown>>;
  w.u8(Math.min(255, outcomes.length));
  for (const oc of outcomes) {
    const shot = oc.shot as Record<string, unknown> | undefined;
    if (!shot) return false;
    writeShot(w, shot);
    const damages = Array.isArray(oc.damages)
      ? oc.damages as Array<Record<string, unknown>>
      : [];
    const deaths = Array.isArray(oc.deaths)
      ? oc.deaths as Array<Record<string, unknown>>
      : [];
    let of = 0;
    if (damages.length) of |= 1;
    if (deaths.length) of |= 2;
    if (oc.leech) of |= 4;
    w.u8(of);
    if (of & 1) {
      w.u8(Math.min(255, damages.length));
      for (const d of damages) writeDamage(w, d);
    }
    if (of & 2) {
      w.u8(Math.min(255, deaths.length));
      for (const d of deaths) writeDeath(w, d);
    }
  }
  return true;
}

function readCombatBurst(r: ByteReader): unknown {
  const n = r.u8();
  const outcomes: Array<Record<string, unknown>> = [];
  for (let i = 0; i < n; i++) {
    const shot = readShot(r);
    const of = r.u8();
    const oc: Record<string, unknown> = { shot };
    if (of & 1) {
      const dn = r.u8();
      const damages = [];
      for (let j = 0; j < dn; j++) damages.push(readDamage(r));
      oc.damages = damages;
    }
    if (of & 2) {
      const dn = r.u8();
      const deaths = [];
      for (let j = 0; j < dn; j++) deaths.push(readDeath(r));
      oc.deaths = deaths;
    }
    if (of & 4) oc.leech = true;
    outcomes.push(oc);
  }
  return { outcomes };
}

function writePingLike(
  w: ByteWriter,
  opcode: NetOpcode,
  payload: unknown,
): boolean {
  const o = asRecord(payload);
  if (!o || typeof o.t !== "number") return false;
  let flags = 0;
  const srv = o.srv as Record<string, number> | undefined;
  const net = o.net as Record<string, number> | undefined;
  if (srv) flags |= 1;
  if (net) flags |= 2;
  const hasRw = Boolean(
    net && (
      typeof net.rwClamp === "number" ||
      typeof net.rwFwd === "number" ||
      typeof net.rwBack === "number" ||
      typeof net.hRwClamp === "number"
    ),
  );
  if (hasRw) flags |= 4;
  writeHeader(w, opcode, flags);
  w.f64(o.t as number);
  if (srv) {
    w.u8(srv.hz ?? 60);
    w.f32(srv.avg ?? 0);
    w.f32(srv.peak ?? 0);
    w.f32(srv.budgetMs ?? 0);
  }
  if (net) {
    w.u32(net.vSent ?? 0);
    w.u32(net.vDrop ?? 0);
    w.u32(net.hb ?? 0);
    w.u32(net.peakWb ?? 0);
    w.u32(net.hSent ?? 0);
    w.u32(net.hDrop ?? 0);
    w.u32(net.hPeakWb ?? 0);
    w.u32(net.hDropClients ?? 0);
  }
  if (flags & 4) {
    w.u32(net?.rwClamp ?? 0);
    w.u32(net?.rwFwd ?? 0);
    w.u32(net?.rwBack ?? 0);
    w.u32(net?.hRwClamp ?? 0);
  }
  return true;
}

function readPingLike(r: ByteReader, flags: number): unknown {
  const t = r.f64();
  const out: Record<string, unknown> = { t };
  if (flags & 1) {
    out.srv = {
      hz: r.u8(),
      avg: r.f32(),
      peak: r.f32(),
      budgetMs: r.f32(),
    };
  }
  if (flags & 2) {
    out.net = {
      vSent: r.u32(),
      vDrop: r.u32(),
      hb: r.u32(),
      peakWb: r.u32(),
      hSent: r.u32(),
      hDrop: r.u32(),
      hPeakWb: r.u32(),
      hDropClients: r.u32(),
    };
  }
  if (flags & 4) {
    const net = (out.net as Record<string, number> | undefined) ?? {};
    net.rwClamp = r.u32();
    net.rwFwd = r.u32();
    net.rwBack = r.u32();
    net.hRwClamp = r.u32();
    out.net = net;
  }
  return out;
}

function writeGameOverStat(w: ByteWriter, p: Record<string, unknown>): void {
  w.str8(String(p.id ?? ""));
  w.str8(String(p.name ?? ""));
  w.u8(p.team === "B" ? 1 : 0);
  w.i16(clampInt((p.score as number) ?? 0, -32768, 32767));
  w.i16(clampInt((p.kills as number) ?? 0, -32768, 32767));
  w.i16(clampInt((p.deaths as number) ?? 0, -32768, 32767));
  w.u8(p.alive ? 1 : 0);
  w.u32((p.xp as number) ?? 0);
  w.u8(rankToIndex(p.mmsRankId as string | undefined));
  w.u8(p.founderBadge ? 1 : 0);
}

function readGameOverStat(r: ByteReader): Record<string, unknown> {
  const id = r.str8();
  const name = r.str8();
  const team = r.u8() === 1 ? "B" : "A";
  const score = r.i16();
  const kills = r.i16();
  const deaths = r.i16();
  const alive = r.u8() === 1;
  const xp = r.u32();
  const rank = indexToRank(r.u8());
  const founderBadge = r.u8() === 1;
  return {
    id,
    name,
    team,
    score,
    kills,
    deaths,
    alive,
    xp,
    mmsRankId: rank ?? "scrap",
    founderBadge,
  };
}

function writeMapVoteState(w: ByteWriter, s: Record<string, unknown>): void {
  const options = Array.isArray(s.options)
    ? s.options as Array<{ name: string; votes: number }>
    : [];
  w.u8(Math.min(255, options.length));
  for (const opt of options) {
    w.str8(opt.name);
    w.u8(opt.votes);
  }
  w.u8((s.voterCount as number) ?? 0);
}

function readMapVoteState(r: ByteReader): Record<string, unknown> {
  const n = r.u8();
  const options = [];
  for (let i = 0; i < n; i++) options.push({ name: r.str8(), votes: r.u8() });
  return { options, voterCount: r.u8() };
}

function writeGameOver(w: ByteWriter, payload: unknown, opcode: NetOpcode): boolean {
  const o = asRecord(payload);
  if (!o || !o.scores || !Array.isArray(o.players)) return false;
  let flags = 0;
  if (o.returnToMenu) flags |= 1;
  if (o.mapVote) flags |= 2;
  if (o.xpMode === "ranked") flags |= 4;
  else if (o.xpMode === "unranked") flags |= 8;
  if (o.matchKind === "raid") flags |= 16;
  if (o.raid) flags |= 32;
  const winner = o.winner;
  if (winner === "A") flags |= 64;
  else if (winner === "B") flags |= 128;
  // draw = neither
  writeHeader(w, opcode, flags);
  writeScores(w, o.scores as { A: number; B: number });
  const players = o.players as Array<Record<string, unknown>>;
  w.u8(Math.min(255, players.length));
  for (const p of players) writeGameOverStat(w, p);
  w.u8((o.restartInSeconds as number) ?? 0);
  if (flags & 2) writeMapVoteState(w, o.mapVote as Record<string, unknown>);
  if (flags & 32) {
    writeRaidHud(w, o.raid as Record<string, unknown>);
  }
  return true;
}

function writeRaidHud(w: ByteWriter, raid: Record<string, unknown>): void {
  w.u8((raid.door as number) ?? 0);
  w.u8((raid.goal as number) ?? 0);
  w.u32((raid.respawnMs as number) ?? 0);
  w.str8(String(raid.title ?? ""));
  const map = typeof raid.map === "string" && raid.map.trim()
    ? raid.map.trim()
    : "";
  const prevMap = typeof raid.prevMap === "string" && raid.prevMap.trim()
    ? raid.prevMap.trim()
    : "";
  const nextMap = typeof raid.nextMap === "string" && raid.nextMap.trim()
    ? raid.nextMap.trim()
    : "";
  let sub = 0;
  if (map) sub |= 1;
  if (prevMap) sub |= 2;
  if (nextMap) sub |= 4;
  w.u8(sub);
  if (sub & 1) w.str8(map);
  if (sub & 2) w.str8(prevMap);
  if (sub & 4) w.str8(nextMap);
}

function readRaidHud(r: ByteReader): Record<string, unknown> {
  const raid: Record<string, unknown> = {
    door: r.u8(),
    goal: r.u8(),
    respawnMs: r.u32(),
    title: r.str8(),
  };
  const sub = r.u8();
  if (sub & 1) raid.map = r.str8();
  if (sub & 2) raid.prevMap = r.str8();
  if (sub & 4) raid.nextMap = r.str8();
  return raid;
}

function readGameOver(r: ByteReader, flags: number): unknown {
  const scores = readScores(r);
  const n = r.u8();
  const players = [];
  for (let i = 0; i < n; i++) players.push(readGameOverStat(r));
  const restartInSeconds = r.u8();
  let winner: "A" | "B" | "draw" = "draw";
  if (flags & 64) winner = "A";
  else if (flags & 128) winner = "B";
  const out: Record<string, unknown> = {
    winner,
    scores,
    players,
    restartInSeconds,
  };
  if (flags & 1) out.returnToMenu = true;
  if (flags & 2) out.mapVote = readMapVoteState(r);
  if (flags & 4) out.xpMode = "ranked";
  else if (flags & 8) out.xpMode = "unranked";
  if (flags & 16) out.matchKind = "raid";
  if (flags & 32) {
    out.raid = readRaidHud(r);
  }
  return out;
}

function writePrematch(w: ByteWriter, o: Record<string, unknown>): void {
  w.u8(phaseToU8(o.phase));
  w.u8((o.humanCount as number) ?? 0);
  w.u8((o.humansReady as number) ?? 0);
  w.u8((o.minHumans as number) ?? 0);
  w.u8(o.canVote ? 1 : 0);
  const ids = Array.isArray(o.readyPlayerIds)
    ? o.readyPlayerIds as string[]
    : [];
  w.u8(Math.min(255, ids.length));
  for (const id of ids) w.str8(id);
  const th = (o.teamHumans as { A: number; B: number }) ?? { A: 0, B: 0 };
  w.u8(th.A);
  w.u8(th.B);
  w.u8(o.requireEvenTeams ? 1 : 0);
}

function readPrematch(r: ByteReader): Record<string, unknown> {
  const phase = u8ToPhase(r.u8());
  const humanCount = r.u8();
  const humansReady = r.u8();
  const minHumans = r.u8();
  const canVote = r.u8() === 1;
  const n = r.u8();
  const readyPlayerIds: string[] = [];
  for (let i = 0; i < n; i++) readyPlayerIds.push(r.str8());
  const A = r.u8();
  const B = r.u8();
  const requireEvenTeams = r.u8() === 1;
  return {
    phase,
    humanCount,
    humansReady,
    minHumans,
    canVote,
    readyPlayerIds,
    teamHumans: { A, B },
    requireEvenTeams,
  };
}

function writeRebalanceState(w: ByteWriter, o: Record<string, unknown>): void {
  w.u8((o.votes as number) ?? 0);
  w.u8((o.needed as number) ?? 0);
  w.u8((o.humans as number) ?? 0);
  w.u8(o.neededByBalance ? 1 : 0);
}

function readRebalanceState(r: ByteReader): Record<string, unknown> {
  return {
    votes: r.u8(),
    needed: r.u8(),
    humans: r.u8(),
    neededByBalance: r.u8() === 1,
  };
}

function writeWelcome(w: ByteWriter, payload: unknown): boolean {
  const o = asRecord(payload);
  if (!o || typeof o.id !== "string" || !o.spawn || !o.map || !o.scores) {
    return false;
  }
  let flags = 0;
  if (o.doorsOpen) flags |= 1;
  if (o.gameOver) flags |= 2;
  if (o.prematch) flags |= 4;
  if (o.ranked) flags |= 8;
  if (o.autofillBots != null) flags |= 16;
  if (o.rebalanceVote) flags |= 32;
  if (o.spectator) flags |= 64;
  if (Array.isArray(o.ownedAbilities)) flags |= 128;
  if (Array.isArray(o.skillLoadout)) flags |= 256;
  if (o.matchKind === "raid") flags |= 512;
  if (o.raid) flags |= 1024;
  writeHeader(w, NetOpcode.Welcome, flags);
  w.str8(o.id as string);
  w.str8(String(o.serverName ?? ""));
  w.u8((o.tickRate as number) ?? 60);
  w.u8((o.snapshotRate as number) ?? 20);
  w.u32((o.tick as number) ?? 0);
  w.u32((o.doorChangeTick as number) ?? 0);
  w.u32((o.matchEndTick as number) ?? 0);
  w.u8(o.team === "B" ? 1 : 0);
  writeScores(w, o.scores as { A: number; B: number });
  writePlayer(w, o.spawn as WireSnapshotPlayer);
  const players = Array.isArray(o.players)
    ? o.players as WireSnapshotPlayer[]
    : [];
  w.u8(Math.min(255, players.length));
  for (const p of players) writePlayer(w, p);
  writeMap(w, o.map as WireDoorsMap);
  if (flags & 2) {
    // nested gameOver uses its own header-less body — reuse flags via a subwriter
    const inner = new ByteWriter(256);
    if (!writeGameOver(inner, o.gameOver, NetOpcode.GameOver)) return false;
    const bytes = inner.toBytes();
    // skip proto+opcode (2) — keep flags+body
    w.bytes(bytes.subarray(2));
  }
  if (flags & 4) writePrematch(w, o.prematch as Record<string, unknown>);
  if (flags & 16) w.u8(o.autofillBots as number);
  if (flags & 32) {
    const rb = o.rebalanceVote as Record<string, unknown>;
    writeRebalanceState(w, rb);
    w.u8(rb.youVoted ? 1 : 0);
  }
  if (flags & 128) {
    const owned = o.ownedAbilities as string[];
    w.u8(Math.min(255, owned.length));
    for (const id of owned) w.u8(productToIndex(id));
  }
  if (flags & 256) {
    const slots = o.skillLoadout as Array<string | null>;
    w.u8(Math.min(255, slots.length));
    for (const id of slots) w.u8(skillToIndex(id));
  }
  if (flags & 1024) {
    writeRaidHud(w, o.raid as Record<string, unknown>);
  }
  return true;
}

function readWelcome(r: ByteReader, flags: number): unknown {
  const id = r.str8();
  const serverName = r.str8();
  const tickRate = r.u8();
  const snapshotRate = r.u8();
  const tick = r.u32();
  const doorChangeTick = r.u32();
  const matchEndTick = r.u32();
  const team = r.u8() === 1 ? "B" : "A";
  const scores = readScores(r);
  const spawn = readPlayer(r);
  const n = r.u8();
  const players: WireSnapshotPlayer[] = [];
  for (let i = 0; i < n; i++) players.push(readPlayer(r));
  const map = readMap(r);
  const out: Record<string, unknown> = {
    id,
    serverName,
    tickRate,
    snapshotRate,
    tick,
    doorsOpen: (flags & 1) !== 0,
    doorChangeTick,
    matchEndTick,
    team,
    scores,
    spawn,
    players,
    map,
  };
  if (flags & 2) {
    const goFlags = r.u16();
    out.gameOver = readGameOver(r, goFlags);
  }
  if (flags & 4) out.prematch = readPrematch(r);
  if (flags & 8) out.ranked = true;
  if (flags & 16) out.autofillBots = r.u8();
  if (flags & 32) {
    const rb = readRebalanceState(r);
    (rb as { youVoted: boolean }).youVoted = r.u8() === 1;
    out.rebalanceVote = rb;
  }
  if (flags & 64) out.spectator = true;
  if (flags & 128) {
    const on = r.u8();
    const owned: string[] = [];
    for (let i = 0; i < on; i++) {
      const idp = indexToProduct(r.u8());
      if (idp) owned.push(idp);
    }
    out.ownedAbilities = owned;
  }
  if (flags & 256) {
    const sn = r.u8();
    const slots: Array<string | null> = [];
    for (let i = 0; i < sn; i++) slots.push(indexToSkill(r.u8()));
    out.skillLoadout = slots;
  }
  if (flags & 512) out.matchKind = "raid";
  if (flags & 1024) {
    out.raid = readRaidHud(r);
  }
  return out;
}

function writeMatchStart(w: ByteWriter, payload: unknown): boolean {
  const o = asRecord(payload);
  if (!o || !o.scores || !Array.isArray(o.players)) return false;
  let flags = 0;
  if (o.doorsOpen) flags |= 1;
  if (o.phase != null) flags |= 2;
  writeHeader(w, NetOpcode.MatchStart, flags);
  w.u32((o.doorChangeTick as number) ?? 0);
  w.u32((o.matchEndTick as number) ?? 0);
  writeScores(w, o.scores as { A: number; B: number });
  if (flags & 2) w.u8(phaseToU8(o.phase));
  const players = o.players as WireSnapshotPlayer[];
  w.u8(Math.min(255, players.length));
  for (const p of players) writePlayer(w, p);
  return true;
}

function readMatchStart(r: ByteReader, flags: number): unknown {
  const doorChangeTick = r.u32();
  const matchEndTick = r.u32();
  const scores = readScores(r);
  const out: Record<string, unknown> = {
    doorsOpen: (flags & 1) !== 0,
    doorChangeTick,
    matchEndTick,
    scores,
    players: [] as WireSnapshotPlayer[],
  };
  if (flags & 2) out.phase = u8ToPhase(r.u8());
  const n = r.u8();
  const players: WireSnapshotPlayer[] = [];
  for (let i = 0; i < n; i++) players.push(readPlayer(r));
  out.players = players;
  return out;
}

function writeMapChange(w: ByteWriter, payload: unknown): boolean {
  const o = asRecord(payload);
  if (!o || !o.map || !o.scores || !Array.isArray(o.players)) return false;
  let flags = 0;
  if (o.doorsOpen) flags |= 1;
  if (o.endedAsDraw) flags |= 2;
  if (o.previousScores) flags |= 4;
  if (o.raidStage) flags |= 8;
  const prevMap = typeof o.prevMap === "string" && o.prevMap.trim()
    ? o.prevMap.trim()
    : "";
  const nextMap = typeof o.nextMap === "string" && o.nextMap.trim()
    ? o.nextMap.trim()
    : "";
  if (prevMap) flags |= 16;
  if (nextMap) flags |= 32;
  writeHeader(w, NetOpcode.MapChange, flags);
  w.u32((o.doorChangeTick as number) ?? 0);
  w.u32((o.matchEndTick as number) ?? 0);
  writeScores(w, o.scores as { A: number; B: number });
  writeMap(w, o.map as WireDoorsMap);
  const players = o.players as WireSnapshotPlayer[];
  w.u8(Math.min(255, players.length));
  for (const p of players) writePlayer(w, p);
  if (flags & 4) writeScores(w, o.previousScores as { A: number; B: number });
  if (flags & 16) w.str8(prevMap);
  if (flags & 32) w.str8(nextMap);
  return true;
}

function readMapChange(r: ByteReader, flags: number): unknown {
  const doorChangeTick = r.u32();
  const matchEndTick = r.u32();
  const scores = readScores(r);
  const map = readMap(r);
  const n = r.u8();
  const players: WireSnapshotPlayer[] = [];
  for (let i = 0; i < n; i++) players.push(readPlayer(r));
  const out: Record<string, unknown> = {
    doorsOpen: (flags & 1) !== 0,
    doorChangeTick,
    matchEndTick,
    scores,
    map,
    players,
    endedAsDraw: (flags & 2) !== 0,
  };
  if (flags & 4) out.previousScores = readScores(r);
  if (flags & 8) out.raidStage = true;
  if (flags & 16) out.prevMap = r.str8();
  if (flags & 32) out.nextMap = r.str8();
  return out;
}

function writeScore(w: ByteWriter, payload: unknown): boolean {
  const o = asRecord(payload);
  if (!o || !o.player || !o.scores) return false;
  let flags = 0;
  if (o.team === "B") flags |= 1;
  if (Array.isArray(o.resetPlayers) && o.resetPlayers.length) flags |= 2;
  writeHeader(w, NetOpcode.Score, flags);
  w.str8(String(o.scorerId ?? ""));
  writeScores(w, o.scores as { A: number; B: number });
  writePlayer(w, o.player as WireSnapshotPlayer);
  if (flags & 2) {
    const rp = o.resetPlayers as WireSnapshotPlayer[];
    w.u8(Math.min(255, rp.length));
    for (const p of rp) writePlayer(w, p);
  }
  return true;
}

function readScore(r: ByteReader, flags: number): unknown {
  const scorerId = r.str8();
  const scores = readScores(r);
  const player = readPlayer(r);
  const out: Record<string, unknown> = {
    scorerId,
    team: flags & 1 ? "B" : "A",
    scores,
    player,
  };
  if (flags & 2) {
    const n = r.u8();
    const resetPlayers: WireSnapshotPlayer[] = [];
    for (let i = 0; i < n; i++) resetPlayers.push(readPlayer(r));
    out.resetPlayers = resetPlayers;
  }
  return out;
}

function writeAdminResult(w: ByteWriter, payload: unknown): boolean {
  const o = asRecord(payload);
  if (!o) return false;
  let flags = 0;
  if (o.ok) flags |= 1;
  if (typeof o.command === "string") flags |= 2;
  if (typeof o.message === "string") flags |= 4;
  if (typeof o.error === "string") flags |= 8;
  if (typeof o.code === "string") flags |= 16;
  if (typeof o.jti === "string") flags |= 32;
  if (o.data != null) flags |= 64;
  writeHeader(w, NetOpcode.AdminCommandResult, flags);
  if (flags & 2) w.str8(o.command as string);
  if (flags & 4) w.str16(o.message as string);
  if (flags & 8) w.str16(o.error as string);
  if (flags & 16) w.str8(o.code as string);
  if (flags & 32) w.str8(o.jti as string);
  if (flags & 64) {
    try {
      w.str16(JSON.stringify(o.data));
    } catch {
      w.str16("{}");
    }
  }
  return true;
}

function readAdminResult(r: ByteReader, flags: number): unknown {
  const out: Record<string, unknown> = { ok: (flags & 1) !== 0 };
  if (flags & 2) out.command = r.str8();
  if (flags & 4) out.message = r.str16();
  if (flags & 8) out.error = r.str16();
  if (flags & 16) out.code = r.str8();
  if (flags & 32) out.jti = r.str8();
  if (flags & 64) {
    const raw = r.str16();
    try {
      out.data = JSON.parse(raw);
    } catch {
      out.data = {};
    }
  }
  return out;
}

function writeMatchProgression(w: ByteWriter, payload: unknown): boolean {
  const o = asRecord(payload);
  if (!o) return false;
  let flags = 0;
  if (typeof o.matchId === "number") flags |= 1;
  writeHeader(w, NetOpcode.MatchProgression, flags);
  if (flags & 1) w.u32(o.matchId as number);
  const nums = [
    "skillBefore",
    "skillDelta",
    "skillAfter",
    "mmrBefore",
    "mmrDelta",
    "mmrAfter",
    "xpBefore",
    "xpEarned",
    "xpAfter",
    "coinsBefore",
    "coinsEarned",
    "coinsAfter",
    "teamSkillPot",
    "teamShare",
    "doorBonus",
    "doors",
    "shareOfPot",
    "performanceRank",
    "teamSize",
  ];
  for (const k of nums) w.f64((o[k] as number) ?? 0);
  return true;
}

function readMatchProgression(r: ByteReader, flags: number): unknown {
  const out: Record<string, unknown> = {};
  if (flags & 1) out.matchId = r.u32();
  const nums = [
    "skillBefore",
    "skillDelta",
    "skillAfter",
    "mmrBefore",
    "mmrDelta",
    "mmrAfter",
    "xpBefore",
    "xpEarned",
    "xpAfter",
    "coinsBefore",
    "coinsEarned",
    "coinsAfter",
    "teamSkillPot",
    "teamShare",
    "doorBonus",
    "doors",
    "shareOfPot",
    "performanceRank",
    "teamSize",
  ];
  for (const k of nums) out[k] = r.f64();
  return out;
}

function encodeBody(w: ByteWriter, opcode: NetOpcode, payload: unknown): boolean {
  switch (opcode) {
    case NetOpcode.Input:
      return writeInput(w, payload);
    case NetOpcode.Shoot:
      return writeShoot(w, payload);
    case NetOpcode.Melee:
      return writeMelee(w, payload);
    case NetOpcode.Reload:
    case NetOpcode.Ready:
    case NetOpcode.Leave:
    case NetOpcode.RequestPoseHeartbeat:
    case NetOpcode.MapLoaded:
      writeHeader(w, opcode);
      return true;
    case NetOpcode.WeaponSwitch: {
      const o = asRecord(payload);
      if (!o || typeof o.weapon !== "number") return false;
      writeHeader(w, opcode);
      w.u8(o.weapon);
      return true;
    }
    case NetOpcode.Ability: {
      const o = asRecord(payload);
      if (!o || typeof o.ability !== "string") return false;
      writeHeader(w, opcode);
      w.u8(skillToIndex(o.ability));
      return true;
    }
    case NetOpcode.SkillLoadout: {
      const o = asRecord(payload);
      if (!o || !Array.isArray(o.slots)) return false;
      writeHeader(w, opcode);
      const slots = o.slots as Array<string | null>;
      w.u8(Math.min(255, slots.length));
      for (const id of slots) w.u8(skillToIndex(id));
      return true;
    }
    case NetOpcode.Pong:
    case NetOpcode.Ping:
      return writePingLike(w, opcode, payload);
    case NetOpcode.ChangeTeam: {
      const o = asRecord(payload) ?? {};
      let flags = 0;
      if (o.team === "A" || o.team === "B") flags |= o.team === "B" ? 2 : 1;
      writeHeader(w, opcode, flags);
      return true;
    }
    case NetOpcode.TeamRebalanceVote: {
      const o = asRecord(payload) ?? {};
      writeHeader(w, opcode, o.vote === false ? 0 : 1);
      return true;
    }
    case NetOpcode.MatchReady: {
      const o = asRecord(payload);
      if (!o) return false;
      writeHeader(w, opcode, o.ready ? 1 : 0);
      return true;
    }
    case NetOpcode.MapVote: {
      const o = asRecord(payload);
      if (!o || typeof o.mapName !== "string") return false;
      writeHeader(w, opcode);
      w.str8(o.mapName);
      return true;
    }
    case NetOpcode.AdminCommand: {
      const o = asRecord(payload);
      if (!o || typeof o.token !== "string") return false;
      writeHeader(w, opcode);
      w.str16(o.token);
      return true;
    }
    case NetOpcode.Snapshot:
      return writeSnapshot(w, payload);
    case NetOpcode.Welcome:
      return writeWelcome(w, payload);
    case NetOpcode.PlayerJoined:
      if (!asRecord(payload)) return false;
      writeHeader(w, opcode);
      writePlayer(w, payload as WireSnapshotPlayer);
      return true;
    case NetOpcode.PlayerLeft: {
      const o = asRecord(payload);
      if (!o || typeof o.id !== "string") return false;
      writeHeader(w, opcode);
      w.str8(o.id);
      return true;
    }
    case NetOpcode.PlayerConnectionIssue: {
      const o = asRecord(payload);
      if (!o || typeof o.id !== "string") return false;
      writeHeader(w, opcode);
      w.str8(o.id);
      w.u8((o.timeoutSeconds as number) ?? 0);
      return true;
    }
    case NetOpcode.PlayerConnectionRestored: {
      const o = asRecord(payload);
      if (!o || typeof o.id !== "string" || !o.player) return false;
      writeHeader(w, opcode);
      w.str8(o.id);
      writePlayer(w, o.player as WireSnapshotPlayer);
      return true;
    }
    case NetOpcode.SessionReplaced:
    case NetOpcode.Kicked: {
      const o = asRecord(payload);
      if (!o || typeof o.reason !== "string" || typeof o.message !== "string") {
        return false;
      }
      writeHeader(w, opcode);
      w.str8(o.reason);
      w.str16(o.message);
      return true;
    }
    case NetOpcode.CombatBurst:
      return writeCombatBurst(w, payload);
    case NetOpcode.PlayerRespawned: {
      const o = asRecord(payload);
      if (!o || !o.player) return false;
      writeHeader(w, opcode);
      writePlayer(w, o.player as WireSnapshotPlayer);
      return true;
    }
    case NetOpcode.TeamChanged: {
      const o = asRecord(payload);
      if (!o || typeof o.id !== "string" || !o.player) return false;
      let flags = 0;
      if (o.team === "B") flags |= 1;
      if (o.reason === "manual") flags |= 2;
      if (o.reason === "auto_rebalance") flags |= 4;
      writeHeader(w, opcode, flags);
      w.str8(o.id);
      writePlayer(w, o.player as WireSnapshotPlayer);
      return true;
    }
    case NetOpcode.ChangeTeamResult: {
      const o = asRecord(payload);
      if (!o) return false;
      let flags = 0;
      if (o.ok) flags |= 1;
      if (o.team === "A") flags |= 2;
      if (o.team === "B") flags |= 4;
      if (typeof o.error === "string") flags |= 8;
      writeHeader(w, opcode, flags);
      if (flags & 8) w.str8(o.error as string);
      return true;
    }
    case NetOpcode.AutoTeamRebalanceNotice: {
      const o = asRecord(payload);
      if (!o || typeof o.delayMs !== "number") return false;
      writeHeader(w, opcode, o.to === "B" ? 1 : 0);
      w.u32(o.delayMs);
      w.u8(o.from === "B" ? 1 : 0);
      w.str16(String(o.message ?? ""));
      return true;
    }
    case NetOpcode.AutoTeamRebalanceCancel: {
      const o = asRecord(payload) ?? {};
      const has = typeof o.reason === "string";
      writeHeader(w, opcode, has ? 1 : 0);
      if (has) w.str8(o.reason as string);
      return true;
    }
    case NetOpcode.TeamRebalanceVoteResult: {
      const o = asRecord(payload);
      if (!o) return false;
      let flags = 0;
      if (o.ok) flags |= 1;
      if (o.voted) flags |= 2;
      if (typeof o.error === "string") flags |= 4;
      writeHeader(w, opcode, flags);
      if (flags & 4) w.str8(o.error as string);
      return true;
    }
    case NetOpcode.TeamRebalanceVoteState: {
      const o = asRecord(payload);
      if (!o) return false;
      writeHeader(w, opcode);
      writeRebalanceState(w, o);
      return true;
    }
    case NetOpcode.Score:
      return writeScore(w, payload);
    case NetOpcode.GameOver:
      return writeGameOver(w, payload, opcode);
    case NetOpcode.MatchStart:
      return writeMatchStart(w, payload);
    case NetOpcode.MapChange:
      return writeMapChange(w, payload);
    case NetOpcode.MapVoteState: {
      const o = asRecord(payload);
      if (!o) return false;
      writeHeader(w, opcode);
      writeMapVoteState(w, o);
      return true;
    }
    case NetOpcode.PrematchState: {
      const o = asRecord(payload);
      if (!o) return false;
      writeHeader(w, opcode);
      writePrematch(w, o);
      return true;
    }
    case NetOpcode.MatchVoided: {
      const o = asRecord(payload);
      if (!o) return false;
      writeHeader(w, opcode);
      w.str8(String(o.abandonedById ?? ""));
      w.str8(String(o.abandonedByName ?? ""));
      w.str16(String(o.message ?? ""));
      return true;
    }
    case NetOpcode.MatchProgression:
      return writeMatchProgression(w, payload);
    case NetOpcode.AdminCommandResult:
      return writeAdminResult(w, payload);
    case NetOpcode.BotHeatmapTracking: {
      const o = asRecord(payload);
      if (!o) return false;
      writeHeader(w, opcode, o.engaged ? 1 : 0);
      return true;
    }
    default:
      return false;
  }
}

function decodeBody(
  r: ByteReader,
  opcode: NetOpcode,
  flags: number,
): unknown {
  switch (opcode) {
    case NetOpcode.Input:
      return readInput(r);
    case NetOpcode.Shoot:
      return readShoot(r, flags);
    case NetOpcode.Melee:
      return readShoot(r, flags);
    case NetOpcode.Reload:
    case NetOpcode.Ready:
    case NetOpcode.Leave:
    case NetOpcode.RequestPoseHeartbeat:
    case NetOpcode.MapLoaded:
      return undefined;
    case NetOpcode.WeaponSwitch:
      return { weapon: r.u8() };
    case NetOpcode.Ability: {
      const id = indexToSkill(r.u8());
      return id ? { ability: id } : null;
    }
    case NetOpcode.SkillLoadout: {
      const n = r.u8();
      const slots: Array<string | null> = [];
      for (let i = 0; i < n; i++) slots.push(indexToSkill(r.u8()));
      return { slots };
    }
    case NetOpcode.Pong:
    case NetOpcode.Ping:
      return readPingLike(r, flags);
    case NetOpcode.ChangeTeam: {
      if (flags & 2) return { team: "B" };
      if (flags & 1) return { team: "A" };
      return {};
    }
    case NetOpcode.TeamRebalanceVote:
      return { vote: flags !== 0 };
    case NetOpcode.MatchReady:
      return { ready: flags !== 0 };
    case NetOpcode.MapVote:
      return { mapName: r.str8() };
    case NetOpcode.AdminCommand:
      return { token: r.str16() };
    case NetOpcode.Snapshot:
      return readSnapshot(r, flags);
    case NetOpcode.Welcome:
      return readWelcome(r, flags);
    case NetOpcode.PlayerJoined:
      return readPlayer(r);
    case NetOpcode.PlayerLeft:
      return { id: r.str8() };
    case NetOpcode.PlayerConnectionIssue:
      return { id: r.str8(), timeoutSeconds: r.u8() };
    case NetOpcode.PlayerConnectionRestored:
      return { id: r.str8(), player: readPlayer(r) };
    case NetOpcode.SessionReplaced:
    case NetOpcode.Kicked:
      return { reason: r.str8(), message: r.str16() };
    case NetOpcode.CombatBurst:
      return readCombatBurst(r);
    case NetOpcode.PlayerRespawned:
      return { player: readPlayer(r) };
    case NetOpcode.TeamChanged: {
      const id = r.str8();
      const player = readPlayer(r);
      const out: Record<string, unknown> = {
        id,
        team: flags & 1 ? "B" : "A",
        player,
      };
      if (flags & 2) out.reason = "manual";
      if (flags & 4) out.reason = "auto_rebalance";
      return out;
    }
    case NetOpcode.ChangeTeamResult: {
      const out: Record<string, unknown> = { ok: (flags & 1) !== 0 };
      if (flags & 2) out.team = "A";
      if (flags & 4) out.team = "B";
      if (flags & 8) out.error = r.str8();
      return out;
    }
    case NetOpcode.AutoTeamRebalanceNotice:
      return {
        delayMs: r.u32(),
        from: r.u8() === 1 ? "B" : "A",
        to: flags & 1 ? "B" : "A",
        message: r.str16(),
      };
    case NetOpcode.AutoTeamRebalanceCancel:
      return flags & 1 ? { reason: r.str8() } : {};
    case NetOpcode.TeamRebalanceVoteResult: {
      const out: Record<string, unknown> = { ok: (flags & 1) !== 0 };
      if (flags & 2) out.voted = true;
      if (flags & 4) out.error = r.str8();
      return out;
    }
    case NetOpcode.TeamRebalanceVoteState:
      return readRebalanceState(r);
    case NetOpcode.Score:
      return readScore(r, flags);
    case NetOpcode.GameOver:
      return readGameOver(r, flags);
    case NetOpcode.MatchStart:
      return readMatchStart(r, flags);
    case NetOpcode.MapChange:
      return readMapChange(r, flags);
    case NetOpcode.MapVoteState:
      return readMapVoteState(r);
    case NetOpcode.PrematchState:
      return readPrematch(r);
    case NetOpcode.MatchVoided:
      return {
        abandonedById: r.str8(),
        abandonedByName: r.str8(),
        freeToLeave: true,
        message: r.str16(),
      };
    case NetOpcode.MatchProgression:
      return readMatchProgression(r, flags);
    case NetOpcode.AdminCommandResult:
      return readAdminResult(r, flags);
    case NetOpcode.BotHeatmapTracking:
      return { engaged: flags !== 0 };
    default:
      return null;
  }
}

/** Encode a named gameplay event. Returns null if the event/payload is not encodable. */
export function encodeGamePacket(
  event: string,
  payload?: unknown,
): Uint8Array | null {
  const opcode = eventToOpcode(event);
  if (opcode == null) return null;
  try {
    const w = new ByteWriter(
      event === "welcome" || event === "mapChange" ? 4096 : 256,
    );
    if (!encodeBody(w, opcode, payload)) return null;
    return w.toBytes();
  } catch {
    return null;
  }
}

/**
 * Decode a `"g"` payload. Returns null on any malformation (never throws).
 */
function asBinary(data: unknown): ArrayBuffer | ArrayBufferView | null {
  if (data instanceof ArrayBuffer) return data;
  if (ArrayBuffer.isView(data)) return data;
  return null;
}

export function decodeGamePacket(
  data: unknown,
): DecodedGamePacket | null {
  const bin = asBinary(data);
  if (!bin) return null;
  try {
    const r = new ByteReader(bin);
    const proto = r.u8();
    if (!r.ok || proto !== GAME_PROTO) return null;
    const opcode = r.u8() as NetOpcode;
    const flags = r.u16();
    const event = opcodeToEvent(opcode);
    if (!event || !r.ok) return null;
    const payload = decodeBody(r, opcode, flags);
    if (!r.ok || payload === null) return null;
    if (r.remaining !== 0) return null;
    return payload === undefined ? { event, opcode } : { event, opcode, payload };
  } catch {
    return null;
  }
}

export function encodeGamePayload(
  event: string,
  payload?: unknown,
): Uint8Array | null {
  return encodeGamePacket(event, payload);
}
