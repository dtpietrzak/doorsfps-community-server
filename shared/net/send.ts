import { encodeGamePacket } from "./codec.ts";
import {
  GAME_PACKET_EVENT,
  isEmptyGameEvent,
  isGameEvent,
} from "./opcodes.ts";

type Emitter = {
  emit: (event: string, payload?: unknown) => void;
};

/** Encode gameplay payloads onto `"g"`; leave empty/named/engine events alone. */
export function sendGame(
  target: Emitter,
  event: string,
  payload?: unknown,
): void {
  if (!isGameEvent(event)) {
    if (payload === undefined) target.emit(event);
    else target.emit(event, payload);
    return;
  }
  if (isEmptyGameEvent(event) && payload === undefined) {
    target.emit(event);
    return;
  }
  const buf = encodeGamePacket(event, payload);
  if (!buf) return;
  target.emit(GAME_PACKET_EVENT, buf);
}
