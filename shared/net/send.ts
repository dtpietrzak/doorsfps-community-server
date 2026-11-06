import { encodeGamePacket } from "./codec.ts";
import {
  GAME_PACKET_EVENT,
  isEmptyGameEvent,
  isGameEvent,
} from "./opcodes.ts";

type Emitter = {
  emit: (event: string, payload?: unknown) => void;
};

/**
 * Encode gameplay payloads onto `"g"`; leave empty/named/engine events alone.
 * Returns the encoded byte length, or 0 when nothing binary was sent.
 */
export function sendGame(
  target: Emitter,
  event: string,
  payload?: unknown,
): number {
  if (!isGameEvent(event)) {
    if (payload === undefined) target.emit(event);
    else target.emit(event, payload);
    return 0;
  }
  if (isEmptyGameEvent(event) && payload === undefined) {
    target.emit(event);
    return 0;
  }
  const buf = encodeGamePacket(event, payload);
  if (!buf) return 0;
  target.emit(GAME_PACKET_EVENT, buf);
  return buf.byteLength;
}
