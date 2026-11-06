/**
 * Post-match map vote. Owns the ballot map and whether voting is open.
 * GameServer passes the catalog, the raid-runtime flag, and the bot pawn
 * lookup. It never imports GameServer.
 */

import {
  seedPoolMapVotes,
  type PoolVoteShare,
} from "../bots/poolMapVotes.ts";
import type { MapVoteStatePacket } from "../protocol/network.ts";
import { isRaidOnlyMapName } from "../shared/campaign/raids.ts";
import type { MapCatalogEntry } from "./gameServerOptions.ts";

/** Pool pawns that may receive a seeded vote when a window opens. */
export type MapVotePlayerSimBots = {
  voteSeedPolicy(): PoolVoteShare | null;
  poolPawnIds(): readonly string[];
};

export type MapVoteDeps = {
  /** Full preloaded catalog. Read on each call; it is set during construction. */
  catalog: () => readonly MapCatalogEntry[];
  raidRuntime: () => boolean;
  /** Roster membership. A vote is ignored when the player is already gone. */
  hasPlayer: (playerId: string) => boolean;
  playerSimBots: MapVotePlayerSimBots;
};

export class MapVote {
  /** playerId → map name (only meaningful while voting is open). */
  readonly ballots = new Map<string, string>();
  private open = false;

  constructor(private readonly deps: MapVoteDeps) {}

  /** Community vote pool excludes raid-only maps; official raid keeps them. */
  voteCatalog(): readonly MapCatalogEntry[] {
    const catalog = this.deps.catalog();
    if (this.deps.raidRuntime()) return catalog;
    return catalog.filter((entry) => !isRaidOnlyMapName(entry.name));
  }

  /**
   * Open a vote window and, when seeding is on, cast votes for a share of
   * the pool pawns. Community leaves the policy off.
   */
  begin(): void {
    this.ballots.clear();
    this.open = this.voteCatalog().length > 0;
    if (this.open) this.seedPlayerSimVotes();
  }

  clear(): void {
    this.ballots.clear();
    this.open = false;
  }

  get isOpen(): boolean {
    return this.open;
  }

  /**
   * Cast or change a player's map vote. Returns the new state when accepted.
   */
  cast(
    playerId: string,
    mapName: string,
    matchOver: boolean,
  ): MapVoteStatePacket | null {
    if (!this.open || !matchOver) return null;
    if (!this.deps.hasPlayer(playerId)) return null;
    const entry = this.findEntry(mapName);
    if (!entry) return null;
    this.ballots.set(playerId, entry.name);
    return this.state();
  }

  state(): MapVoteStatePacket {
    const catalog = this.voteCatalog();
    const counts = new Map<string, number>();
    for (const entry of catalog) {
      counts.set(entry.name, 0);
    }
    for (const mapName of this.ballots.values()) {
      if (!counts.has(mapName)) continue;
      counts.set(mapName, (counts.get(mapName) ?? 0) + 1);
    }
    return {
      options: catalog.map((entry) => ({
        name: entry.name,
        votes: counts.get(entry.name) ?? 0,
      })),
      voterCount: this.ballots.size,
    };
  }

  /** Drop one ballot. False when that player had not voted. */
  forget(id: string): boolean {
    return this.ballots.delete(id);
  }

  findEntry(query: string): MapCatalogEntry | null {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    const catalog = this.deps.catalog();
    return (
      catalog.find((m) => m.name.toLowerCase() === q) ??
        catalog.find((m) => m.stem.toLowerCase() === q) ??
        null
    );
  }

  /**
   * Intermission map pick. Highest votes wins; ties broken randomly.
   * No votes → random map from this server's catalog.
   * Epic 4.6: MATCH-CONFIG / RECORD — do not seed.
   * #5/#8 records the chosen map as initial state for the next match.
   * `random` defaults to `Math.random`. Tests pass their own sequence.
   */
  resolveWinner(random: () => number = Math.random): MapCatalogEntry | null {
    const catalog = this.deps.catalog();
    if (catalog.length === 0) return null;
    if (this.ballots.size === 0) {
      return catalog[Math.floor(random() * catalog.length)]!;
    }

    const counts = new Map<string, number>();
    for (const name of this.ballots.values()) {
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }

    let best = 0;
    for (const n of counts.values()) {
      if (n > best) best = n;
    }
    const leaders = catalog.filter(
      (m) => (counts.get(m.name) ?? 0) === best,
    );
    if (leaders.length === 0) return null;
    if (leaders.length === 1) return leaders[0]!;
    return leaders[Math.floor(random() * leaders.length)]!;
  }

  /**
   * When vote seeding is on, cast random map votes for a share of the pool
   * pawns. Community leaves the policy off.
   */
  private seedPlayerSimVotes(): void {
    const share = this.deps.playerSimBots.voteSeedPolicy();
    if (!share) return;
    const catalog = this.voteCatalog();
    if (catalog.length === 0) return;
    const pawnIds = this.deps.playerSimBots.poolPawnIds();
    if (pawnIds.length === 0) return;
    const mapNames = catalog.map((entry) => entry.name);
    const seeded = seedPoolMapVotes(pawnIds, mapNames, share);
    for (const [playerId, mapName] of seeded) {
      this.ballots.set(playerId, mapName);
    }
  }
}
