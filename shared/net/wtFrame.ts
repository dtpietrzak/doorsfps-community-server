/**
 * WebTransport application framing.
 * Auth is length-prefixed JSON. Gameplay is encodeGamePacket
 * (length-prefixed on the control stream, raw on datagrams).
 */
import { decodeGamePacket, encodeGamePacket } from "./codec.ts";
import type { DecodedGamePacket } from "./codec.ts";

/** Client connects to `https://host:port/wt`. */
export const WEBTRANSPORT_PATH = "/wt";

/** Reject control-stream frames larger than this (auth + gameplay). */
export const WEBTRANSPORT_MAX_FRAME_BYTES = 64 * 1024;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** u32be length + body. */
export function encodeLengthPrefixed(body: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + body.byteLength);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint32(0, body.byteLength);
  out.set(body, 4);
  return out;
}

export function encodeAuthFrame(auth: unknown): Uint8Array {
  return encodeLengthPrefixed(textEncoder.encode(JSON.stringify(auth ?? {})));
}

export function decodeAuthJson(body: Uint8Array): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(textDecoder.decode(body));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function encodeStreamGameFrame(
  event: string,
  payload?: unknown,
): Uint8Array | null {
  const packet = encodeGamePacket(event, payload);
  if (!packet) return null;
  return encodeLengthPrefixed(packet);
}

export function decodeStreamGameFrame(
  body: Uint8Array,
): DecodedGamePacket | null {
  return decodeGamePacket(body);
}

/**
 * Assemble length-prefixed frames from a byte stream.
 * Returns completed frame bodies (without the 4-byte length).
 */
export class StreamFrameReader {
  private buf = new Uint8Array(0);
  private overflow = false;
  private readonly maxBytes: number;

  constructor(maxBytes: number = WEBTRANSPORT_MAX_FRAME_BYTES) {
    this.maxBytes = maxBytes;
  }

  get errored(): boolean {
    return this.overflow;
  }

  /** Unconsumed bytes (partial next frame). */
  remainder(): Uint8Array {
    return this.buf.slice();
  }

  push(chunk: Uint8Array): Uint8Array[] {
    if (this.overflow) return [];
    if (chunk.byteLength === 0) return [];
    const next = new Uint8Array(this.buf.byteLength + chunk.byteLength);
    next.set(this.buf, 0);
    next.set(chunk, this.buf.byteLength);
    this.buf = next;

    const frames: Uint8Array[] = [];
    while (this.buf.byteLength >= 4) {
      const view = new DataView(
        this.buf.buffer,
        this.buf.byteOffset,
        this.buf.byteLength,
      );
      const len = view.getUint32(0);
      if (len > this.maxBytes) {
        this.overflow = true;
        this.buf = new Uint8Array(0);
        return frames;
      }
      if (this.buf.byteLength < 4 + len) break;
      frames.push(this.buf.subarray(4, 4 + len));
      this.buf = this.buf.subarray(4 + len);
    }
    return frames;
  }
}
