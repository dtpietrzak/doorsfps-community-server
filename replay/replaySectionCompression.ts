/**
 * Epic 19.6 — input, event, and checkpoint compression.
 *
 * The file stays one canonical UTF-8 JSON document (10.2). These three
 * sections are the bulk of a match, and most of that bulk is repeated
 * identity: false, positive zero, null, empty arrays, empty objects, and
 * a few named defaults (`alive` / `onGround` true, equipment
 * `crosshairColor` -1, roster `maxHealth` 100, `modelScale` 1,
 * `moveSpeedScale` 1, team `"A"`, door policy `"off"`). Encode drops a
 * value only when it equals that field's default. Decode writes the
 * default back before validation.
 *
 * A movement or action `tick` equal to its input-row tick is dropped and
 * restored from the row. The row's own `tick`, and a checkpoint's `tick`,
 * are never dropped, including tick 0, so the 16.5 byte map still finds
 * them. `-0` is not zero here. Optional fields whose absence already
 * means something else are left alone (`meleeLunge`, `queuedInput`,
 * `rewindStamp`, `chambered`, `shellReloadNextAtTick`, `pumpEndsAtTick`,
 * and optional event flags).
 *
 * Header, metadata, initial state, index, and integrity are not packed.
 * Format version, section order, and the 10.2 error names stay. A file
 * written before this epic still decodes: its keys are present, so the
 * fill does not change them. No gzip, deflate, or brotli frame, and no
 * float quantization. Storage capacity is 19.7.
 *
 * Pure: no filesystem, blob, store, hash, or `net/` imports. Never throws.
 * A value that is not the shape this module knows passes through.
 */

type Field =
  | { readonly kind: "false" }
  | { readonly kind: "true" }
  | { readonly kind: "zero" }
  | { readonly kind: "null" }
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "empty-array" }
  | { readonly kind: "empty-object" }
  | {
    readonly kind: "object";
    readonly schema: Schema;
    readonly omitWhenEmpty?: boolean;
  }
  | {
    readonly kind: "array";
    readonly schema: Schema;
    readonly omitWhenEmpty?: boolean;
  }
  | {
    readonly kind: "record";
    readonly schema: Schema;
    readonly omitWhenEmpty?: boolean;
  };

type Schema = { readonly fields: Readonly<Record<string, Field>> };

const F: Field = { kind: "false" };
const T: Field = { kind: "true" };
const Z: Field = { kind: "zero" };
const NIL: Field = { kind: "null" };
const EMPTY_ARR: Field = { kind: "empty-array" };
const EMPTY_OBJ: Field = { kind: "empty-object" };

function num(value: number): Field {
  return { kind: "number", value };
}

function str(value: string): Field {
  return { kind: "string", value };
}

function obj(schema: Schema, omitWhenEmpty = false): Field {
  return { kind: "object", schema, omitWhenEmpty };
}

function arr(schema: Schema, omitWhenEmpty = false): Field {
  return { kind: "array", schema, omitWhenEmpty };
}

function rec(schema: Schema, omitWhenEmpty = false): Field {
  return { kind: "record", schema, omitWhenEmpty };
}

function isPlain(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function isPosZero(value: unknown): boolean {
  return typeof value === "number" && value === 0 && !Object.is(value, -0);
}

function matches(value: unknown, field: Field): boolean {
  switch (field.kind) {
    case "false":
      return value === false;
    case "true":
      return value === true;
    case "zero":
      return isPosZero(value);
    case "null":
      return value === null;
    case "number":
      return typeof value === "number" && value === field.value &&
        !Object.is(value, -0);
    case "string":
      return value === field.value;
    case "empty-array":
      return Array.isArray(value) && value.length === 0;
    case "empty-object":
      return isPlain(value) && Object.keys(value).length === 0;
    default:
      return false;
  }
}

function cloneDefault(field: Field): unknown {
  switch (field.kind) {
    case "false":
      return false;
    case "true":
      return true;
    case "zero":
      return 0;
    case "null":
      return null;
    case "number":
      return field.value;
    case "string":
      return field.value;
    case "empty-array":
      return [];
    case "empty-object":
      return {};
    default:
      return undefined;
  }
}

function fillsWhenMissing(field: Field): boolean {
  switch (field.kind) {
    case "object":
    case "array":
    case "record":
      return field.omitWhenEmpty === true;
    default:
      return true;
  }
}

function packObject(value: unknown, schema: Schema): unknown {
  if (!isPlain(value)) return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    const current = value[key];
    const field = schema.fields[key];
    if (!field) {
      out[key] = current;
      continue;
    }
    if (field.kind === "object") {
      const packed = isPlain(current) ? packObject(current, field.schema) : current;
      if (
        field.omitWhenEmpty && isPlain(packed) &&
        Object.keys(packed).length === 0
      ) {
        continue;
      }
      out[key] = packed;
      continue;
    }
    if (field.kind === "array") {
      if (!Array.isArray(current)) {
        out[key] = current;
        continue;
      }
      if (field.omitWhenEmpty && current.length === 0) continue;
      out[key] = current.map((item) =>
        isPlain(item) ? packObject(item, field.schema) : item
      );
      continue;
    }
    if (field.kind === "record") {
      if (!isPlain(current)) {
        out[key] = current;
        continue;
      }
      if (field.omitWhenEmpty && Object.keys(current).length === 0) continue;
      const packed: Record<string, unknown> = {};
      for (const childKey of Object.keys(current)) {
        const child = current[childKey];
        packed[childKey] = isPlain(child)
          ? packObject(child, field.schema)
          : child;
      }
      out[key] = packed;
      continue;
    }
    if (matches(current, field)) continue;
    out[key] = current;
  }
  return out;
}

function unpackObject(value: unknown, schema: Schema): Record<string, unknown> {
  const src = isPlain(value) ? value : {};
  const out: Record<string, unknown> = {};
  const seen = new Set<string>();
  for (const key of Object.keys(schema.fields)) {
    seen.add(key);
    const field = schema.fields[key]!;
    if (key in src) {
      out[key] = unpackField(src[key], field);
      continue;
    }
    if (!fillsWhenMissing(field)) continue;
    if (field.kind === "object") {
      out[key] = unpackObject({}, field.schema);
      continue;
    }
    if (field.kind === "array") {
      out[key] = [];
      continue;
    }
    if (field.kind === "record") {
      out[key] = {};
      continue;
    }
    out[key] = cloneDefault(field);
  }
  for (const key of Object.keys(src)) {
    if (!seen.has(key)) out[key] = src[key];
  }
  return out;
}

function unpackField(value: unknown, field: Field): unknown {
  if (field.kind === "object") {
    if (!isPlain(value)) return value;
    return unpackObject(value, field.schema);
  }
  if (field.kind === "array") {
    if (!Array.isArray(value)) return value;
    return value.map((item) =>
      isPlain(item) ? unpackObject(item, field.schema) : item
    );
  }
  if (field.kind === "record") {
    if (!isPlain(value)) return value;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      const child = value[key];
      out[key] = isPlain(child) ? unpackObject(child, field.schema) : child;
    }
    return out;
  }
  return value;
}

function mapRows(value: unknown, mapRow: (row: unknown) => unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map(mapRow);
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

const playerInputSchema: Schema = {
  fields: {
    sequence: Z,
    forward: F,
    backward: F,
    left: F,
    right: F,
    jump: F,
    sprint: F,
    crouch: F,
    yaw: Z,
    pitch: Z,
  },
};

const movementDefaults: Schema = {
  fields: {
    appliedSequence: Z,
    inputHoldTicks: Z,
  },
};

const aimSchema: Schema = {
  fields: {
    yaw: Z,
    pitch: Z,
  },
};

function packMovement(row: unknown, parentTick: number): unknown {
  if (!isPlain(row)) return row;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(row)) {
    const current = row[key];
    if (key === "tick" && current === parentTick) continue;
    if (key === "selectedInput") {
      if (current === null) continue;
      out[key] = isPlain(current) ? packObject(current, playerInputSchema) : current;
      continue;
    }
    if (key === "queuedInput" && isPlain(current)) {
      out[key] = packObject(current, playerInputSchema);
      continue;
    }
    const field = movementDefaults.fields[key];
    if (field && matches(current, field)) continue;
    out[key] = current;
  }
  return out;
}

function unpackMovement(row: unknown, parentTick: number): unknown {
  if (!isPlain(row)) return row;
  const src: Record<string, unknown> = { ...row };
  if (!("tick" in src) && typeof parentTick === "number" && Number.isFinite(parentTick)) {
    src.tick = parentTick;
  }
  if (!("selectedInput" in src)) src.selectedInput = null;
  const out = unpackObject(src, movementDefaults);
  if (isPlain(out.selectedInput)) {
    out.selectedInput = unpackObject(out.selectedInput, playerInputSchema);
  }
  if (isPlain(out.queuedInput)) {
    out.queuedInput = unpackObject(out.queuedInput, playerInputSchema);
  }
  return out;
}

function packAction(row: unknown, parentTick: number): unknown {
  if (!isPlain(row)) return row;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(row)) {
    const current = row[key];
    if (key === "tick" && current === parentTick) continue;
    if (key === "ordinal" && isPosZero(current)) continue;
    if (key === "weapon" && row.kind === "weaponSelect" && isPosZero(current)) {
      continue;
    }
    if (key === "aim") {
      out[key] = isPlain(current) ? packObject(current, aimSchema) : current;
      continue;
    }
    out[key] = current;
  }
  return out;
}

function unpackAction(row: unknown, parentTick: number): unknown {
  if (!isPlain(row)) return row;
  const out: Record<string, unknown> = { ...row };
  if (!("tick" in out) && typeof parentTick === "number" && Number.isFinite(parentTick)) {
    out.tick = parentTick;
  }
  if (!("ordinal" in out)) out.ordinal = 0;
  if (!("weapon" in out) && out.kind === "weaponSelect") out.weapon = 0;
  if (isPlain(out.aim)) out.aim = unpackObject(out.aim, aimSchema);
  return out;
}

function packInputRow(row: unknown): unknown {
  if (!isPlain(row)) return row;
  const parentTick = row.tick;
  const tick = typeof parentTick === "number" ? parentTick : Number.NaN;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(row)) {
    const current = row[key];
    if (key === "movement" && Array.isArray(current)) {
      out[key] = current.map((item) => packMovement(item, tick));
      continue;
    }
    if (key === "actions") {
      if (Array.isArray(current) && current.length === 0) continue;
      out[key] = Array.isArray(current)
        ? current.map((item) => packAction(item, tick))
        : current;
      continue;
    }
    out[key] = current;
  }
  return out;
}

function unpackInputRow(row: unknown): unknown {
  if (!isPlain(row)) return row;
  const parentTick = row.tick;
  const tick = typeof parentTick === "number" ? parentTick : Number.NaN;
  const out: Record<string, unknown> = { ...row };
  out.movement = Array.isArray(row.movement)
    ? row.movement.map((item) => unpackMovement(item, tick))
    : row.movement;
  out.actions = Array.isArray(row.actions)
    ? row.actions.map((item) => unpackAction(item, tick))
    : [];
  return out;
}

export function packInputStream(value: unknown): unknown {
  return mapRows(value, packInputRow);
}

export function unpackInputStream(value: unknown): unknown {
  return mapRows(value, unpackInputRow);
}

// ---------------------------------------------------------------------------
// Events and checkpoints share pose, scores, equipment, and roster shapes.
// ---------------------------------------------------------------------------

const authoritativePoseSchema: Schema = {
  fields: { x: Z, y: Z, z: Z, yaw: Z, pitch: Z },
};

const checkpointPoseSchema: Schema = {
  fields: {
    tick: Z,
    x: Z,
    y: Z,
    z: Z,
    crouch: F,
    slide: F,
    yaw: Z,
    pitch: Z,
    velocityX: Z,
    velocityY: Z,
    velocityZ: Z,
    onGround: T,
    landingAmount: Z,
  },
};

const scoresSchema: Schema = { fields: { A: Z, B: Z } };

const equipmentSchema: Schema = {
  fields: {
    head: Z,
    visor: Z,
    shoulder: Z,
    body: Z,
    leg: Z,
    hue: Z,
    gunHue: Z,
    bulletHue: Z,
    crosshairColor: num(-1),
    nameHue: Z,
    pistol: Z,
    rifle: Z,
    shotgun: Z,
    scope: Z,
    crosshair: Z,
  },
};

const vec3Schema: Schema = { fields: { x: Z, y: Z, z: Z } };

const rosterSchema: Schema = {
  fields: {
    team: str("A"),
    isBot: F,
    isAgent: F,
    isBalanceBot: F,
    alive: T,
    connectionIssue: F,
    unlimitedAmmo: F,
    maxHealth: num(100),
    modelScale: num(1),
    moveSpeedScale: num(1),
    pose: obj(authoritativePoseSchema, true),
    equipment: obj(equipmentSchema, true),
    skillLoadout: NIL,
    ownedAbilities: NIL,
  },
};

const pelletSchema: Schema = {
  fields: { hitId: NIL, hitZone: NIL, hitPoint: NIL },
};

const shotSchema: Schema = {
  fields: {
    weapon: Z,
    hitId: NIL,
    hitZone: NIL,
    hitPoint: NIL,
    pellets: arr(pelletSchema),
  },
};

const damageSchema: Schema = {
  fields: {
    damage: Z,
    health: Z,
    alive: T,
    killed: F,
    critical: F,
  },
};

const outcomeSchema: Schema = {
  fields: {
    shot: obj(shotSchema),
    damages: arr(damageSchema),
  },
};

const poseField = obj(authoritativePoseSchema, true);
const scoresField = obj(scoresSchema, true);
const rosterField = obj(rosterSchema);
const rosterList = arr(rosterSchema);

const EVENT_SCHEMAS: Readonly<Record<string, Schema>> = {
  matchInit: {
    fields: {
      prematchEnabled: F,
      debugForceDoorsOpen: F,
      scores: scoresField,
      roster: rosterList,
    },
  },
  humanJoin: { fields: { player: rosterField } },
  botAdd: { fields: { player: rosterField } },
  agentAdd: { fields: { player: rosterField } },
  connectionStatus: {
    fields: {
      connectionIssue: F,
      socketId: NIL,
      respawned: F,
      player: rosterField,
    },
  },
  teamAssign: { fields: { player: rosterField } },
  loadoutCommit: { fields: { loadout: NIL } },
  readyVote: { fields: { ready: F } },
  matchStart: {
    fields: {
      scores: scoresField,
      roster: rosterList,
    },
  },
  matchEnd: {
    fields: {
      scheduleRestart: F,
      restartSeconds: Z,
      restartAtTick: NIL,
      scores: scoresField,
    },
  },
  matchDraw: {
    fields: {
      scheduleRestart: F,
      restartSeconds: Z,
      restartAtTick: NIL,
      scores: scoresField,
    },
  },
  combatBurst: { fields: { outcomes: arr(outcomeSchema) } },
  playerDied: { fields: { weapon: Z } },
  score: {
    fields: {
      scores: scoresField,
      playerPose: poseField,
      playerAlive: T,
      resetPlayerPoses: arr({
        fields: { pose: poseField },
      }),
    },
  },
  gameOver: {
    fields: {
      restartInSeconds: Z,
      scores: scoresField,
    },
  },
  playerRespawned: { fields: { player: rosterField } },
};

function packEvent(row: unknown): unknown {
  if (!isPlain(row)) return row;
  const kind = row.kind;
  if (typeof kind !== "string") return row;
  const schema = EVENT_SCHEMAS[kind];
  if (!schema) return row;
  return packObject(row, schema);
}

function unpackEvent(row: unknown): unknown {
  if (!isPlain(row)) return row;
  const kind = row.kind;
  if (typeof kind !== "string") return row;
  const schema = EVENT_SCHEMAS[kind];
  if (!schema) return row;
  return unpackObject(row, schema);
}

function packEventRow(row: unknown): unknown {
  if (!isPlain(row)) return row;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(row)) {
    const current = row[key];
    if (key === "events") {
      if (Array.isArray(current) && current.length === 0) continue;
      out[key] = Array.isArray(current) ? current.map(packEvent) : current;
      continue;
    }
    out[key] = current;
  }
  return out;
}

function unpackEventRow(row: unknown): unknown {
  if (!isPlain(row)) return row;
  const out: Record<string, unknown> = { ...row };
  out.events = Array.isArray(row.events) ? row.events.map(unpackEvent) : [];
  return out;
}

export function packEventStream(value: unknown): unknown {
  return mapRows(value, packEventRow);
}

export function unpackEventStream(value: unknown): unknown {
  return mapRows(value, unpackEventRow);
}

// ---------------------------------------------------------------------------
// Checkpoints
// ---------------------------------------------------------------------------

const weaponSchema: Schema = {
  fields: {
    weaponId: Z,
    ammoInMag: Z,
    spareClips: Z,
  },
};

const raidSchema: Schema = { fields: { active: F } };

const rngSchema: Schema = {
  fields: {
    damage: Z,
    spread: Z,
    spawn: Z,
    agents: Z,
    collisionSpawn: Z,
  },
};

const matchSchema: Schema = {
  fields: {
    scores: scoresField,
    matchOver: F,
    inPrematch: F,
    restartAtTick: NIL,
    doorCycleOriginTick: Z,
    doorsPowerUpUntilTick: NIL,
    raidDoorPolicy: str("off"),
    debugForceDoorsOpen: F,
    matchEndTick: Z,
    matchDurationTicks: Z,
    raid: obj(raidSchema, true),
  },
};

const checkpointPlayerSchema: Schema = {
  fields: {
    team: str("A"),
    isBot: F,
    isAgent: F,
    x: Z,
    y: Z,
    z: Z,
    yaw: Z,
    pitch: Z,
    velocityX: Z,
    velocityY: Z,
    velocityZ: Z,
    onGround: T,
    crouch: F,
    sprintStamina: Z,
    slideRemaining: Z,
    slideDirX: Z,
    slideDirZ: Z,
    slideForceCrouch: F,
    prevInputCrouch: F,
    lastLandedAtTick: NIL,
    poseHistory: arr(checkpointPoseSchema, true),
    health: num(100),
    maxHealth: num(100),
    alive: T,
    spawnedAtTick: Z,
    diedAtTick: NIL,
    enemyDoorSinceTick: NIL,
    hitSlowStacks: Z,
    hitSlowEndsAtTick: Z,
    weaponId: Z,
    weaponLoadouts: arr(weaponSchema),
    reloadEndsAtTick: NIL,
    weaponSwitchEndsAtTick: NIL,
    lastShotAtTick: NIL,
    lastMeleeAtTick: NIL,
    pausedReloadRemainingTicks: EMPTY_OBJ,
    unlimitedAmmo: F,
    abilityEndsAtTick: EMPTY_OBJ,
    abilityFxOrigin: rec(vec3Schema, true),
    abilitySpent: EMPTY_OBJ,
    abilityGlobalLockEndsAtTick: NIL,
    abilityBarRegenEndsAtTick: NIL,
    abilityDoorRegenEndsAtTick: NIL,
    abilityNoSpendOnEnd: EMPTY_OBJ,
    equipment: obj(equipmentSchema, true),
    skillLoadout: NIL,
    ownedAbilities: NIL,
    score: Z,
    kills: Z,
    deaths: Z,
    xp: Z,
  },
};

const checkpointSchema: Schema = {
  fields: {
    matchSeed: Z,
    rng: obj(rngSchema, true),
    match: obj(matchSchema),
    players: arr(checkpointPlayerSchema, true),
    projectiles: EMPTY_ARR,
  },
};

function packCheckpoint(row: unknown): unknown {
  if (!isPlain(row)) return row;
  return packObject(row, checkpointSchema);
}

function unpackCheckpoint(row: unknown): unknown {
  if (!isPlain(row)) return row;
  return unpackObject(row, checkpointSchema);
}

export function packCheckpoints(value: unknown): unknown {
  return mapRows(value, packCheckpoint);
}

export function unpackCheckpoints(value: unknown): unknown {
  return mapRows(value, unpackCheckpoint);
}
