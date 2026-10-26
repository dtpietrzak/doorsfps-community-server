import { nextRandom, normalizeSeed } from "../core/random.ts";
import {
  resolveBrainHooks,
  type BrainHooks,
} from "../hooks.ts";
import { BotBrain } from "../pipeline/brain.ts";
import {
  emptyBotBrainState,
  UNSET,
  type BotBrainState,
  type TeammateCampClaim,
} from "../types.ts";
import type {
  BotDecision,
  BotDefinition,
  BotMapDefinition,
  ReadyAction as WireReadyAction,
  ThinkBatchDecision,
  ThinkBatchInput,
  ThinkBatchOutput,
  ThinkFrame,
} from "../model/index.ts";
import type { ReadyAction } from "../pipeline/types.ts";
import { runtimePlayer } from "../runtime/player.ts";
import type { Player } from "../players/Player.ts";
import { runtimeMap } from "../runtime/map.ts";
import type { DoorsMap } from "../shared/map.ts";
import { MapCollision } from "../world/MapCollision.ts";

type PipelineSlot = {
  id: string;
  profile: string;
  /** In-process config the slot was built from; a new object rebuilds it. */
  config: BotDefinition["config"];
  initialRandomState: number;
  random: { state: number };
  state: BotBrainState;
  brain: BotBrain;
};

function configFor(definition: BotDefinition, hooks: BrainHooks) {
  if (definition.config !== undefined) return definition.config;
  return hooks.resolveConfig(definition.profile);
}

function createSlot(
  definition: BotDefinition,
  hooks: BrainHooks,
): PipelineSlot {
  const initialRandomState = normalizeSeed(definition.randomSeed);
  const random = { state: initialRandomState };
  const rng = (): number => {
    const sample = nextRandom(random.state);
    random.state = sample.state;
    return sample.value;
  };
  return {
    id: definition.id,
    profile: definition.profile,
    config: definition.config,
    initialRandomState,
    random,
    state: emptyBotBrainState(),
    brain: new BotBrain(configFor(definition, hooks), { rng, hooks }),
  };
}

function wireAction(action: ReadyAction | null): WireReadyAction | null {
  if (action === null) return null;
  const source = action.input;
  const input = source === null ? null : {
    forward: source.forward,
    backward: source.backward,
    left: source.left,
    right: source.right,
    jump: source.jump,
    sprint: source.sprint,
    crouch: source.crouch,
    yaw: source.yaw,
    pitch: source.pitch,
  };
  const wired: {
    input: WireReadyAction["input"];
    lookSamples?: Array<{ yaw: number; pitch: number }>;
    shoot?: boolean;
    reload?: boolean;
    weapon?: number;
    ability?: string;
  } = { input };
  const samples = action.lookSamples;
  if (input !== null && samples !== undefined && samples.length > 0) {
    const look: Array<{ yaw: number; pitch: number }> = [];
    for (let i = 0; i < samples.length; i++) {
      const sample = samples[i]!;
      look.push({ yaw: sample.yaw, pitch: sample.pitch });
    }
    wired.lookSamples = look;
  }
  if (action.shoot === true) wired.shoot = true;
  if (action.reload === true) wired.reload = true;
  const weapon = action.weapon;
  if (typeof weapon === "number" && Number.isFinite(weapon)) {
    wired.weapon = weapon;
  }
  const ability = action.ability;
  if (typeof ability === "string" && ability.length > 0) {
    wired.ability = ability;
  }
  return wired;
}

/** Omitted hooks keep the public behavior. One object for every pawn. */
export type BotThinkEngineOptions = {
  hooks?: Partial<BrainHooks>;
};

/** Persistent, runtime-neutral owner of every bot's full thought pipeline. */
export class PersistentBotThinkEngine {
  private slots: PipelineSlot[] = [];
  private mapDefinition: BotMapDefinition | null = null;
  private map: DoorsMap | null = null;
  private collision: MapCollision | null = null;
  private readonly hooks: BrainHooks;

  constructor(options?: BotThinkEngineOptions) {
    this.hooks = resolveBrainHooks(options?.hooks);
  }

  loadMap(definition: BotMapDefinition): void {
    if (this.mapDefinition?.revision === definition.revision) return;
    const map = runtimeMap(definition);
    this.mapDefinition = definition;
    this.map = map;
    this.collision = new MapCollision(map);
  }

  private findSlot(id: string): PipelineSlot | null {
    const slots = this.slots;
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i]!;
      if (slot.id === id) return slot;
    }
    return null;
  }

  synchronizeBots(definitions: readonly BotDefinition[]): void {
    const next: PipelineSlot[] = [];
    for (let d = 0; d < definitions.length; d++) {
      const definition = definitions[d]!;
      let duplicate = false;
      for (let e = 0; e < next.length; e++) {
        if (next[e]!.id === definition.id) {
          duplicate = true;
          break;
        }
      }
      if (duplicate) continue;

      const existing = this.findSlot(definition.id);
      const seed = normalizeSeed(definition.randomSeed);
      if (
        existing !== null &&
        existing.initialRandomState === seed &&
        existing.profile === definition.profile &&
        existing.config === definition.config
      ) {
        next.push(existing);
      } else {
        next.push(createSlot(definition, this.hooks));
      }
    }
    this.slots = next;
  }

  private players(frame: ThinkFrame): Player[] {
    const output: Player[] = [];
    const snapshots = frame.players;
    for (let i = 0; i < snapshots.length; i++) {
      output.push(runtimePlayer(snapshots[i]!));
    }
    return output;
  }

  private findPlayer(
    players: readonly Player[],
    id: string,
  ): Player | null {
    for (let i = 0; i < players.length; i++) {
      const player = players[i]!;
      if (player.id === id) return player;
    }
    return null;
  }

  private teammateCamps(
    players: readonly Player[],
  ): TeammateCampClaim[] {
    const output: TeammateCampClaim[] = [];
    const slots = this.slots;
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i]!;
      const player = this.findPlayer(players, slot.id);
      if (player === null || !player.alive) continue;
      const state = slot.state;
      if (state.doorCampActive !== true) continue;
      const x = state.doorCampPlantX;
      const z = state.doorCampPlantZ;
      if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
      output.push({ playerId: slot.id, x, z });
    }
    return output;
  }

  thinkBatch(input: ThinkBatchInput): ThinkBatchOutput {
    const frame = input.frame;
    const runtimePlayers = this.players(frame);
    const camps = this.teammateCamps(runtimePlayers);
    const decisions: ThinkBatchDecision[] = [];
    const map = this.map;
    const collision = this.collision;
    const validMap = map !== null && collision !== null &&
      this.mapDefinition?.revision === frame.mapRevision;
    if (collision !== null) collision.doorWalkInEnabled = frame.doorsOpen;

    const requestedBots = input.bots;
    for (let b = 0; b < requestedBots.length; b++) {
      const requested = requestedBots[b]!;
      const slot = this.findSlot(requested.botId);
      const self = this.findPlayer(runtimePlayers, requested.botId);
      let action: WireReadyAction | null = null;
      if (
        validMap && map !== null && collision !== null && slot !== null &&
        self !== null && self.spawnedAtTick === requested.spawnedAtTick
      ) {
        action = wireAction(slot.brain.think({
          tick: frame.tick,
          simDelta: frame.simDelta,
          self,
          players: runtimePlayers,
          collision,
          map,
          doorsOpen: frame.doorsOpen,
          doorChangeTick: frame.doorChangeTick === null
            ? UNSET
            : frame.doorChangeTick,
          teammateCamps: camps,
          teamScores: { A: frame.teamScoreA, B: frame.teamScoreB },
          humanHeatByPole: frame.humanHeatByPole,
          matchOver: frame.matchOver === true,
        }, slot.state));
      }
      decisions.push({
        botId: requested.botId,
        spawnedAtTick: requested.spawnedAtTick,
        action,
      });
    }

    return {
      tick: frame.tick,
      applyTick: input.applyTick,
      mapRevision: frame.mapRevision,
      decisions,
    };
  }

  think(frame: ThinkFrame): readonly BotDecision[] {
    const bots: Array<{ botId: string; spawnedAtTick: number }> = [];
    const slots = this.slots;
    const snapshots = frame.players;
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i]!;
      let spawnedAtTick = 0;
      for (let p = 0; p < snapshots.length; p++) {
        const player = snapshots[p]!;
        if (player.id === slot.id) {
          spawnedAtTick = player.spawnedAtTick;
          break;
        }
      }
      bots.push({ botId: slot.id, spawnedAtTick });
    }
    const output = this.thinkBatch({
      frame,
      applyTick: frame.tick + 1,
      bots,
    });
    return output.decisions.map((decision) => ({
      botId: decision.botId,
      action: decision.action,
    }));
  }
}

export function createBotThinkEngine(
  options?: BotThinkEngineOptions,
): PersistentBotThinkEngine {
  return new PersistentBotThinkEngine(options);
}
