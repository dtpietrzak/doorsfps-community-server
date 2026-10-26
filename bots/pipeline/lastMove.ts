/**
 * Last-move memory for failure-tick replay.
 *
 * When soft age hits the failure tick, stuck bots drop remaining pipe work and
 * replay their last applied (or last completed) ReadyAction onto the delay queue.
 * This is not a second buffer — only a per-bot action cache.
 *
 * @see docs/game/bots.md §3.1 / §7
 */

import type { ReadyAction } from "./types.ts";

/** Per-bot last ReadyAction (null = last turn held still / no combat). */
export type LastMoveMemory = Map<string, ReadyAction | null>;

export function createLastMoveMemory(): LastMoveMemory {
  return new Map();
}

/** Record after a successful apply (or completed think if apply not yet wired). */
export function recordLastMove(
  memory: LastMoveMemory,
  botId: string,
  action: ReadyAction | null,
): void {
  memory.set(botId, action);
}

/**
 * Last known move for replay, or `undefined` if never recorded.
 * Failure path treats missing memory as null (hold still).
 */
export function getLastMove(
  memory: LastMoveMemory,
  botId: string,
): ReadyAction | null | undefined {
  if (!memory.has(botId)) return undefined;
  return memory.get(botId);
}

/**
 * Action to enqueue on failure tick.
 * Prefer last recorded move; fall back to null (no input) if unknown.
 */
export function replayLastMove(
  memory: LastMoveMemory,
  botId: string,
): ReadyAction | null {
  if (!memory.has(botId)) return null;
  return memory.get(botId) ?? null;
}

/** Drop memory for a bot that left the server. */
export function clearLastMove(memory: LastMoveMemory, botId: string): void {
  memory.delete(botId);
}
