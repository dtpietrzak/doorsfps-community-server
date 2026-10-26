/**
 * Socket.IO client called `disconnect()` — a clean local close, not a
 * transport blip (wifi drop / ping timeout / RST).
 */
export const SOCKET_IO_CLIENT_DISCONNECT = "io client disconnect";

/** True when the peer tore the socket down on purpose. */
export function isClientInitiatedDisconnect(reason: unknown): boolean {
  return reason === SOCKET_IO_CLIENT_DISCONNECT;
}
