import { assertEquals } from "jsr:@std/assert";
import {
  isClientInitiatedDisconnect,
  SOCKET_IO_CLIENT_DISCONNECT,
} from "./disconnectReason.ts";

Deno.test("client-initiated disconnect is only the Socket.IO client close reason", () => {
  assertEquals(isClientInitiatedDisconnect(SOCKET_IO_CLIENT_DISCONNECT), true);
  assertEquals(isClientInitiatedDisconnect("io server disconnect"), false);
  assertEquals(isClientInitiatedDisconnect("transport close"), false);
  assertEquals(isClientInitiatedDisconnect("ping timeout"), false);
  assertEquals(isClientInitiatedDisconnect("transport error"), false);
  assertEquals(isClientInitiatedDisconnect(undefined), false);
  assertEquals(isClientInitiatedDisconnect(""), false);
});
