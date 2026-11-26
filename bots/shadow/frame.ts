import type {
  BotMapDefinition,
  BotObjectiveDirective,
  PlayerSnapshot,
  SkillSnapshot,
  ThinkFrame,
} from "@doors/bot-engine/model";
import { SKILL_ORDER } from "../../shared/sim/skills.ts";
import { WEAPON_ORDER } from "../../protocol/network.ts";
import type { Player } from "../../players/Player.ts";
import type { MapCollision } from "../../world/MapCollision.ts";
import { SLIDING_DOOR_COST } from "../../shared/world/slidingDoors.ts";

const mapRevisions = new WeakMap<MapCollision, string>();
const mapDefinitions = new WeakMap<MapCollision, BotMapDefinition>();

let zombotsCollisionSerial = 0;

export function stableMapRevision(collision: MapCollision): string {
  const cached = mapRevisions.get(collision);
  if (cached !== undefined) return cached;
  const source = JSON.stringify(collision.map);
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  // Zombots doors only ever open inside one collision; a new run builds a
  // new one. Its own revision makes the engine rebuild with every door shut.
  const run = collision.map.mirrorMode === "zombots"
    ? `:run${++zombotsCollisionSerial}`
    : "";
  const revision = `${collision.map.name}:${collision.map.version}:${
    (hash >>> 0).toString(16).padStart(8, "0")
  }${run}`;
  mapRevisions.set(collision, revision);
  return revision;
}

function snapshotSkills(
  player: Player,
  tick: number,
): readonly SkillSnapshot[] {
  const loadout = player.snapshotSkillLoadout();
  const equipped = loadout === null
    ? SKILL_ORDER
    : loadout.filter((id): id is (typeof SKILL_ORDER)[number] => id !== null);
  const skills: SkillSnapshot[] = [];
  for (const id of equipped) {
    const activeUntilTick = player.abilityEndsAtTick[id];
    skills.push({
      id,
      equipped: true,
      charge: player.isAbilitySpent(id) ? 0 : 1,
      activeUntilTick: typeof activeUntilTick === "number"
        ? activeUntilTick
        : null,
      canActivate: player.canActivateAbility(id, tick),
    });
  }
  return skills;
}

function snapshotPlayer(
  player: Player,
  tick: number,
  collision: MapCollision,
  objectiveDirective?: BotObjectiveDirective,
): PlayerSnapshot {
  const weapons = WEAPON_ORDER.map((id) => ({
    id,
    ammoInMagazine: player.ammoInMagFor(id),
    spareClips: player.spareClipsFor(id),
  }));
  return {
    id: player.id,
    kind: player.isAgent ? "agent" : player.isBot ? "bot" : "human",
    team: player.team,
    alive: player.alive,
    health: player.health,
    score: player.score,
    spawnedAtTick: player.spawnedAtTick,
    x: player.x,
    y: player.y,
    z: player.z,
    velocityX: player.velocityX,
    velocityY: player.velocityY,
    velocityZ: player.velocityZ,
    yaw: player.yaw,
    pitch: player.pitch,
    crouch: player.crouch,
    onGround: player.onGround,
    sprintStamina: player.sprintStamina,
    moveYaw: player.moveYawForFov(),
    matchPlayer: player.isMatchPlayer(),
    unlimitedAmmo: player.unlimitedAmmo,
    weapons,
    glitchState: player.glitchSnapState(tick, collision) ?? "inactive",
    // Zombots only; other modes keep the frame unchanged.
    ...(player.downed ? { isDowned: true } : {}),
    ...(objectiveDirective !== undefined ? { objectiveDirective } : {}),
    weapon: {
      id: player.weaponId,
      ammoInMagazine: player.ammoInMag,
      spareClips: player.spareClips,
      reloading: player.isReloading(),
      lastShotTick: player.lastShotAtTick,
    },
    skills: snapshotSkills(player, tick),
  };
}

/** Normalize the authoritative map once for the persistent thought engine. */
export function buildBotMapDefinition(
  collision: MapCollision,
): BotMapDefinition {
  const cached = mapDefinitions.get(collision);
  if (cached !== undefined) return cached;
  const map = collision.map;
  const nudges: Array<{
    id: string;
    team: "A" | "B";
    points: readonly { x: number; z: number }[];
  }> = [];
  const camps: Array<{
    id: string;
    team: "A" | "B";
    point: { x: number; z: number };
  }> = [];
  const sprints: Array<{
    id: string;
    team: "A" | "B";
    polygon: readonly { x: number; z: number }[];
  }> = [];
  const spawns: Array<{
    id: string;
    team: "A" | "B";
    start: { x: number; z: number };
    end: { x: number; z: number };
  }> = [];
  const stuck: Array<{
    id: string;
    team: "A" | "B";
    center: { x: number; z: number };
    radius: number;
    yaw: number;
  }> = [];
  for (const hint of map.botHints ?? []) {
    switch (hint.kind) {
      case "nudge":
        nudges.push({ id: hint.id, team: hint.team, points: hint.points });
        break;
      case "camp":
        camps.push({ id: hint.id, team: hint.team, point: hint.p });
        break;
      case "sprint":
        sprints.push({ id: hint.id, team: hint.team, polygon: hint.polygon });
        break;
      case "spawn":
        spawns.push({ id: hint.id, team: hint.team, start: hint.a, end: hint.b });
        break;
      case "stuck":
        stuck.push({
          id: hint.id,
          team: hint.team,
          center: hint.center,
          radius: hint.radius,
          yaw: hint.yaw,
        });
        break;
    }
  }
  const wallCorners = map.wallCorners ?? map.walls.flatMap((wall) => [
    { x: wall.a.x, z: wall.a.z },
    { x: wall.b.x, z: wall.b.z },
  ]);
  const definition: BotMapDefinition = {
    id: map.name,
    revision: stableMapRevision(collision),
    formatVersion: map.version,
    bounds: { ...map.bounds },
    teamA: {
      edge: map.teamA.edge,
      doorHalfWidth: map.teamA.doorHalfWidth,
      spawnRadius: map.teamA.spawnRadius,
    },
    teamB: {
      edge: map.teamB.edge,
      doorHalfWidth: map.teamB.doorHalfWidth,
      spawnRadius: map.teamB.spawnRadius,
    },
    walls: map.walls.map((wall) => ({
      id: wall.id,
      ax: wall.a.x,
      az: wall.a.z,
      bx: wall.b.x,
      bz: wall.b.z,
      kind: wall.kind ?? "full",
    })),
    wallCorners,
    hints: { nudges, camps, sprints, spawns, stuck },
    ...((map.windows?.length ?? 0) > 0
      ? {
        windows: (map.windows ?? []).map((win) => ({
          id: win.id,
          wallId: win.wallId,
          center: { x: win.center.x, z: win.center.z },
        })),
      }
      : {}),
    ...((map.doors?.length ?? 0) > 0
      ? {
        doors: (map.doors ?? []).map((door) => ({
          id: door.id,
          wallId: door.wallId,
          center: { x: door.center.x, z: door.center.z },
          cost: door.cost ?? SLIDING_DOOR_COST,
        })),
      }
      : {}),
    ...(map.mirrorMode === "zombots"
      ? {
        mirrorMode: "zombots" as const,
        spawnCorner: map.spawnCorner ?? 0,
      }
      : {}),
  };
  mapDefinitions.set(collision, definition);
  return definition;
}

/** Build the one immutable world snapshot shared by this scheduled shard. */
export function buildThinkFrame(
  input: Readonly<{
    tick: number;
    simDelta: number;
    collision: MapCollision;
    players: readonly Player[];
    doorsOpen: boolean;
    doorChangeTick: number | null;
    teamScoreA: number;
    teamScoreB: number;
    combatDelayMsA?: number;
    combatDelayMsB?: number;
    objectiveDirectiveFor?: (playerId: string) => BotObjectiveDirective | undefined;
    matchOver?: boolean;
  }>,
): ThinkFrame {
  const players: PlayerSnapshot[] = [];
  for (const player of input.players) {
    players.push(
      snapshotPlayer(
        player,
        input.tick,
        input.collision,
        input.objectiveDirectiveFor?.(player.id),
      ),
    );
  }
  const hasCombatDelay = (input.combatDelayMsA ?? 0) > 0 ||
    (input.combatDelayMsB ?? 0) > 0;
  return {
    tick: input.tick,
    simDelta: input.simDelta,
    mapRevision: stableMapRevision(input.collision),
    doorsOpen: input.doorsOpen,
    doorChangeTick: input.doorChangeTick,
    teamScoreA: input.teamScoreA,
    teamScoreB: input.teamScoreB,
    ...(hasCombatDelay
      ? {
        combatDelayMsA: input.combatDelayMsA ?? 0,
        combatDelayMsB: input.combatDelayMsB ?? 0,
      }
      : {}),
    players,
    // Presence-implies-true, matching the wire codec (which omits the key
    // on the false/absent side of the round trip — see protocol/pipeline.ts).
    ...(input.matchOver === true ? { matchOver: true } : {}),
  };
}
