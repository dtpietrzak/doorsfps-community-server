const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** Growable little-endian writer. `toBytes()` copies the used prefix (safe to hand to Socket.IO). */
export class ByteWriter {
  private buf: Uint8Array;
  private view: DataView;
  private off = 0;

  constructor(capacity = 256) {
    this.buf = new Uint8Array(capacity);
    this.view = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength);
  }

  get length(): number {
    return this.off;
  }

  private grow(extra: number): void {
    const need = this.off + extra;
    if (need <= this.buf.byteLength) return;
    let cap = this.buf.byteLength;
    while (cap < need) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.off));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }

  u8(v: number): void {
    this.grow(1);
    this.view.setUint8(this.off, v & 0xff);
    this.off += 1;
  }

  u16(v: number): void {
    this.grow(2);
    this.view.setUint16(this.off, v & 0xffff, true);
    this.off += 2;
  }

  u32(v: number): void {
    this.grow(4);
    this.view.setUint32(this.off, v >>> 0, true);
    this.off += 4;
  }

  i16(v: number): void {
    this.grow(2);
    this.view.setInt16(this.off, v | 0, true);
    this.off += 2;
  }

  i32(v: number): void {
    this.grow(4);
    this.view.setInt32(this.off, v | 0, true);
    this.off += 4;
  }

  f32(v: number): void {
    this.grow(4);
    this.view.setFloat32(this.off, v, true);
    this.off += 4;
  }

  f64(v: number): void {
    this.grow(8);
    this.view.setFloat64(this.off, v, true);
    this.off += 8;
  }

  bytes(src: Uint8Array): void {
    this.grow(src.byteLength);
    this.buf.set(src, this.off);
    this.off += src.byteLength;
  }

  /** Length-prefixed UTF-8, max 255. */
  str8(s: string): void {
    const raw = textEncoder.encode(s);
    const n = Math.min(255, raw.byteLength);
    this.u8(n);
    if (n > 0) this.bytes(raw.subarray(0, n));
  }

  /** Length-prefixed UTF-8, max 65535. */
  str16(s: string): void {
    const raw = textEncoder.encode(s);
    const n = Math.min(65535, raw.byteLength);
    this.u16(n);
    if (n > 0) this.bytes(raw.subarray(0, n));
  }

  /** Independent copy of the written prefix — Socket.IO may hold this until flush. */
  toBytes(): Uint8Array {
    return this.buf.slice(0, this.off);
  }
}

export class ByteReader {
  readonly view: DataView;
  readonly bytes: Uint8Array;
  off: number;
  readonly end: number;
  ok = true;

  constructor(data: ArrayBuffer | ArrayBufferView) {
    if (ArrayBuffer.isView(data)) {
      this.bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    } else {
      this.bytes = new Uint8Array(data);
    }
    this.view = new DataView(
      this.bytes.buffer,
      this.bytes.byteOffset,
      this.bytes.byteLength,
    );
    this.off = 0;
    this.end = this.bytes.byteLength;
  }

  get remaining(): number {
    return this.end - this.off;
  }

  private need(n: number): boolean {
    if (!this.ok) return false;
    if (this.off + n > this.end) {
      this.ok = false;
      return false;
    }
    return true;
  }

  u8(): number {
    if (!this.need(1)) return 0;
    const v = this.view.getUint8(this.off);
    this.off += 1;
    return v;
  }

  u16(): number {
    if (!this.need(2)) return 0;
    const v = this.view.getUint16(this.off, true);
    this.off += 2;
    return v;
  }

  u32(): number {
    if (!this.need(4)) return 0;
    const v = this.view.getUint32(this.off, true);
    this.off += 4;
    return v;
  }

  i16(): number {
    if (!this.need(2)) return 0;
    const v = this.view.getInt16(this.off, true);
    this.off += 2;
    return v;
  }

  i32(): number {
    if (!this.need(4)) return 0;
    const v = this.view.getInt32(this.off, true);
    this.off += 4;
    return v;
  }

  f32(): number {
    if (!this.need(4)) return 0;
    const v = this.view.getFloat32(this.off, true);
    this.off += 4;
    return v;
  }

  f64(): number {
    if (!this.need(8)) return 0;
    const v = this.view.getFloat64(this.off, true);
    this.off += 8;
    return v;
  }

  str8(): string {
    const n = this.u8();
    if (!this.need(n)) return "";
    const s = textDecoder.decode(this.bytes.subarray(this.off, this.off + n));
    this.off += n;
    return s;
  }

  str16(): string {
    const n = this.u16();
    if (!this.need(n)) return "";
    const s = textDecoder.decode(this.bytes.subarray(this.off, this.off + n));
    this.off += n;
    return s;
  }
}

export function clampInt(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(min, Math.min(max, n | 0));
}

export function toMilli(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 1000);
}

export function fromMilli(n: number): number {
  return n / 1000;
}

export function toCenti(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

export function fromCenti(n: number): number {
  return n / 100;
}

/** Engine.IO type digit(s) + JSON array for a named JSON event. */
export function socketIoJsonEventBytes(
  event: string,
  payload?: unknown,
): number {
  const arr = payload === undefined ? [event] : [event, payload];
  return 2 + JSON.stringify(arr).length;
}

/**
 * Socket.IO BINARY_EVENT envelope for `emit("g", buf)`.
 * `451-["g",{"_placeholder":true,"num":0}]` + attachment bytes.
 */
export const SOCKET_IO_BINARY_ENVELOPE_BYTES =
  4 + '["g",{"_placeholder":true,"num":0}]'.length;

export function socketIoBinaryEventBytes(payloadLen: number): number {
  return SOCKET_IO_BINARY_ENVELOPE_BYTES + payloadLen;
}
