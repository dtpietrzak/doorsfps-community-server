/**
 * Epic 16.2 — searchable fields copied out of a finalized replay file.
 *
 * The SQL row does not hold simulation bytes. It holds the fields 16.2 names
 * (map, mode, duration, roster, teams, versions, checksum, the 10.3 index)
 * plus the 16.5 byte-offset sidecar, which is derived here and is not part
 * of the file. A file that does not decode yields null; finalize still keeps
 * the blob.
 */

import type { AuthoritativeRosterSnapshot } from "../shared/sim/authoritativeEvent.ts";
import { decodeReplayContainer } from "./replayEncoding.ts";
import { deriveReplayByteMap, type ReplayByteMap } from "./replayByteMap.ts";
import { isFilledReplayIndex, type ReplayIndex } from "./replayIndex.ts";

export type ReplayRosterEntry = {
  readonly id: string;
  readonly name: string;
  readonly team: string;
  readonly isBot: boolean;
};

export type ReplayTeamsStamp = {
  readonly scores: { readonly A: number; readonly B: number };
  readonly ids: readonly string[];
};

export type ReplayCatalogStamp = {
  readonly mapName: string;
  readonly mapVersion: string;
  readonly gameMode: string | null;
  readonly durationTicks: number;
  readonly firstTick: number;
  readonly lastTick: number;
  readonly roster: readonly ReplayRosterEntry[];
  readonly teams: ReplayTeamsStamp;
  readonly gameProto: number;
  readonly replayFormatVersion: number;
  readonly buildSha: string | null;
  readonly checksum: string;
  readonly index: ReplayIndex | null;
  readonly byteMap: ReplayByteMap | null;
};

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function slimRoster(
  roster: readonly AuthoritativeRosterSnapshot[],
): ReplayRosterEntry[] {
  return roster.map((player) => ({
    id: player.id,
    name: player.name,
    team: player.team,
    isBot: player.isBot,
  }));
}

/**
 * Read catalog fields from the exact bytes that were stored.
 * Checksum covers those bytes. Null when the container does not decode.
 */
export async function extractReplayCatalog(
  bytes: Uint8Array,
): Promise<ReplayCatalogStamp | null> {
  let container;
  try {
    container = decodeReplayContainer(bytes);
  } catch {
    return null;
  }
  const { header, metadata, initialState } = container;
  if (header.lastTick < header.firstTick) return null;
  const roster = slimRoster(initialState.metadata.roster);
  const teamIds: string[] = [];
  for (const player of roster) {
    if (!teamIds.includes(player.team)) teamIds.push(player.team);
  }
  const index = isFilledReplayIndex(container.index) ? container.index : null;
  return {
    mapName: header.map.name,
    mapVersion: String(header.map.version),
    gameMode: metadata.modeId,
    durationTicks: header.lastTick - header.firstTick + 1,
    firstTick: header.firstTick,
    lastTick: header.lastTick,
    roster,
    teams: { scores: initialState.metadata.scores, ids: teamIds },
    gameProto: metadata.gameProto,
    replayFormatVersion: header.replayFormatVersion,
    buildSha: metadata.buildSha,
    checksum: await sha256Hex(bytes),
    index,
    byteMap: deriveReplayByteMap(bytes),
  };
}
