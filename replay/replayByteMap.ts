/**
 * Epic 16.5 — tick → byte-offset sidecar.
 *
 * The file index (10.3) is tick-anchored and must not store byte offsets
 * (they would move when written into the same document). This map is derived
 * from the canonical JSON bytes after encode, and lives beside the file
 * (the `replays` row), never inside it.
 *
 * Granularity is the checkpoint, plus the input-stream row at or just before
 * that tick. Section spans cover the eight container sections. A client uses
 * an offset as `Range: bytes=<offset>-`.
 */

export const REPLAY_BYTE_MAP_VERSION = 1 as const;

export type ReplaySectionByteSpan = {
  readonly start: number;
  readonly end: number;
};

export type ReplayTickByteOffset = {
  readonly tick: number;
  readonly byteOffset: number;
};

export type ReplayByteMap = {
  readonly version: typeof REPLAY_BYTE_MAP_VERSION;
  readonly fileSizeBytes: number;
  readonly sections: Readonly<Record<string, ReplaySectionByteSpan>>;
  readonly checkpoints: readonly ReplayTickByteOffset[];
  readonly inputs: readonly ReplayTickByteOffset[];
};

type Cursor = { i: number; b: number };

function step(text: string, cur: Cursor): void {
  const code = text.charCodeAt(cur.i);
  if (Number.isNaN(code)) {
    throw new Error("replay-byte-map: walked off the end");
  }
  if (code < 0x80) {
    cur.i += 1;
    cur.b += 1;
    return;
  }
  if (code < 0x800) {
    cur.i += 1;
    cur.b += 2;
    return;
  }
  if (code >= 0xd800 && code <= 0xdbff) {
    cur.i += 2;
    cur.b += 4;
    return;
  }
  cur.i += 1;
  cur.b += 3;
}

function skipString(text: string, cur: Cursor): void {
  if (text[cur.i] !== '"') throw new Error("replay-byte-map: expected string");
  step(text, cur);
  while (cur.i < text.length) {
    const c = text[cur.i];
    if (c === "\\") {
      step(text, cur);
      if (cur.i < text.length) step(text, cur);
      continue;
    }
    if (c === '"') {
      step(text, cur);
      return;
    }
    step(text, cur);
  }
  throw new Error("replay-byte-map: unterminated string");
}

function readRawString(text: string, cur: Cursor): string {
  const start = cur.i;
  skipString(text, cur);
  return text.slice(start + 1, cur.i - 1);
}

function skipValue(text: string, cur: Cursor): void {
  const c = text[cur.i];
  if (c === '"') {
    skipString(text, cur);
    return;
  }
  if (c === "{") {
    skipContainer(text, cur, "{", "}");
    return;
  }
  if (c === "[") {
    skipContainer(text, cur, "[", "]");
    return;
  }
  if (c == null || ",}]".includes(c)) {
    throw new Error("replay-byte-map: missing value");
  }
  while (cur.i < text.length && !",}]".includes(text[cur.i]!)) step(text, cur);
}

function skipContainer(
  text: string,
  cur: Cursor,
  open: "{" | "[",
  close: "}" | "]",
): void {
  if (text[cur.i] !== open) throw new Error("replay-byte-map: expected container");
  step(text, cur);
  if (text[cur.i] === close) {
    step(text, cur);
    return;
  }
  while (cur.i < text.length) {
    if (open === "{") {
      skipString(text, cur);
      if (text[cur.i] !== ":") throw new Error("replay-byte-map: expected colon");
      step(text, cur);
    }
    skipValue(text, cur);
    if (text[cur.i] === ",") {
      step(text, cur);
      continue;
    }
    if (text[cur.i] === close) {
      step(text, cur);
      return;
    }
    throw new Error("replay-byte-map: bad container");
  }
  throw new Error("replay-byte-map: unterminated container");
}

function readInteger(text: string, cur: Cursor): number | null {
  const start = cur.i;
  if (text[cur.i] === "-") step(text, cur);
  if (cur.i >= text.length || text[cur.i]! < "0" || text[cur.i]! > "9") {
    return null;
  }
  while (cur.i < text.length && text[cur.i]! >= "0" && text[cur.i]! <= "9") {
    step(text, cur);
  }
  const n = Number(text.slice(start, cur.i));
  if (!Number.isInteger(n)) return null;
  return n;
}

/** Walk one object. Returns the integer `tick` field when present. */
function readObjectTick(text: string, cur: Cursor): number | null {
  if (text[cur.i] !== "{") throw new Error("replay-byte-map: expected object");
  step(text, cur);
  let tick: number | null = null;
  if (text[cur.i] === "}") {
    step(text, cur);
    return null;
  }
  while (cur.i < text.length) {
    const key = readRawString(text, cur);
    if (text[cur.i] !== ":") throw new Error("replay-byte-map: expected colon");
    step(text, cur);
    if (key === "tick") {
      tick = readInteger(text, cur);
      if (tick == null) skipValue(text, cur);
    } else {
      skipValue(text, cur);
    }
    if (text[cur.i] === ",") {
      step(text, cur);
      continue;
    }
    if (text[cur.i] === "}") {
      step(text, cur);
      return tick;
    }
    throw new Error("replay-byte-map: bad object");
  }
  throw new Error("replay-byte-map: unterminated object");
}

function readTickArray(text: string, cur: Cursor): ReplayTickByteOffset[] {
  if (text[cur.i] !== "[") throw new Error("replay-byte-map: expected array");
  step(text, cur);
  const out: ReplayTickByteOffset[] = [];
  if (text[cur.i] === "]") {
    step(text, cur);
    return out;
  }
  while (cur.i < text.length) {
    if (text[cur.i] === "{") {
      const byteOffset = cur.b;
      const tick = readObjectTick(text, cur);
      if (tick != null && tick >= 0) out.push({ tick, byteOffset });
    } else {
      skipValue(text, cur);
    }
    if (text[cur.i] === ",") {
      step(text, cur);
      continue;
    }
    if (text[cur.i] === "]") {
      step(text, cur);
      return out;
    }
    throw new Error("replay-byte-map: bad array");
  }
  throw new Error("replay-byte-map: unterminated array");
}

/**
 * Input row to open for a checkpoint tick: the greatest input tick at or
 * before it, else the first input row.
 */
function inputAnchor(
  inputs: readonly ReplayTickByteOffset[],
  tick: number,
): ReplayTickByteOffset | null {
  let best: ReplayTickByteOffset | null = null;
  for (const row of inputs) {
    if (row.tick <= tick && (best == null || row.tick > best.tick)) best = row;
  }
  return best ?? inputs[0] ?? null;
}

/**
 * Derive the sidecar from canonical container bytes.
 * Returns null when the bytes are not a JSON object we can walk.
 */
export function deriveReplayByteMap(bytes: Uint8Array): ReplayByteMap | null {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  if (!text.startsWith("{")) return null;
  try {
    const cur: Cursor = { i: 0, b: 0 };
    step(text, cur);
    const sections: Record<string, ReplaySectionByteSpan> = {};
    let checkpoints: ReplayTickByteOffset[] = [];
    let allInputs: ReplayTickByteOffset[] = [];
    if (text[cur.i] !== "}") {
      while (cur.i < text.length) {
        const key = readRawString(text, cur);
        if (text[cur.i] !== ":") return null;
        step(text, cur);
        const start = cur.b;
        if (key === "checkpoints" || key === "inputStream") {
          const rows = readTickArray(text, cur);
          if (key === "checkpoints") checkpoints = rows;
          else allInputs = rows;
        } else {
          skipValue(text, cur);
        }
        sections[key] = { start, end: cur.b };
        if (text[cur.i] === ",") {
          step(text, cur);
          continue;
        }
        break;
      }
    }
    if (text[cur.i] !== "}") return null;
    step(text, cur);
    if (cur.i !== text.length || cur.b !== bytes.byteLength) return null;

    const inputs: ReplayTickByteOffset[] = [];
    const seen = new Set<number>();
    const push = (row: ReplayTickByteOffset | null) => {
      if (!row || seen.has(row.byteOffset)) return;
      seen.add(row.byteOffset);
      inputs.push(row);
    };
    if (checkpoints.length === 0) push(allInputs[0] ?? null);
    for (const cp of checkpoints) push(inputAnchor(allInputs, cp.tick));

    return {
      version: REPLAY_BYTE_MAP_VERSION,
      fileSizeBytes: bytes.byteLength,
      sections,
      checkpoints,
      inputs,
    };
  } catch {
    return null;
  }
}
