/**
 * Epic 8.3 — recorded per-tick inputs: movement selections + action rows.
 *
 * The tick-input family IS the 7.5 sink payload:
 * - movement: `TickSelectedInput` per roster player (verbatim 5.2 / 7.1)
 * - actions: consumed weapon/action calls at their 7.1 effect ticks, projected
 *   through `canonicalFromWireParts` into one vocabulary for humans and bots
 *
 * Contract (see notes/replay/08-replay-recording/08-03-input-recording.md):
 * - Frozen copies only — never live owner references / mutable aliases.
 * - One movement row per roster player per tick (gaps are errors, not omissions).
 * - Actions share the same tick base; ordinals preserve effect order.
 * - No bot-brain imports — bots already converge on PlayerManager.handle*.
 * - Memory-only; no store / file / finalized writes.
 *
 * Accessors for later epics: `ReplayRecorder.getTickInputs(runtimeMatchId, tick)`
 * and `ReplayRecorder.getInputStream(runtimeMatchId)`.
 */

import {
  type CanonicalFirePacket,
  canonicalFromWireParts,
  toFirePacket,
} from "../shared/sim/canonicalPlayerInput.ts";
import { isSkillId, type SkillId } from "../shared/sim/skills.ts";
import { isWeaponId } from "../shared/sim/weapons.ts";
import type { SimActionEffect } from "../players/simActionEffect.ts";
import type { TickSelectedInput } from "../players/tickAssociation.ts";
import type { ReplayTickPayload } from "./replayIntegration.ts";
import { deepFreeze } from "./recordedInitialState.ts";

export type { SimActionEffect };

export type RecordedActionRow =
  | {
    readonly tick: number;
    readonly playerId: string;
    readonly ordinal: number;
    readonly kind: "fire";
    readonly fireKind: "shoot" | "melee";
    readonly aim: CanonicalFirePacket;
    /** Resolved RTT lag-comp stamp when live used the RTT window. */
    readonly rewindStamp?: number | null;
  }
  | {
    readonly tick: number;
    readonly playerId: string;
    readonly ordinal: number;
    readonly kind: "reload";
  }
  | {
    readonly tick: number;
    readonly playerId: string;
    readonly ordinal: number;
    readonly kind: "weaponSelect";
    readonly weapon: number;
  }
  | {
    readonly tick: number;
    readonly playerId: string;
    readonly ordinal: number;
    readonly kind: "ability";
    readonly ability: SkillId;
  };

/**
 * Frozen per-tick input capture for one `runtimeMatchId` session tick.
 * Consumed by 8.5 / 8.6 / #10 / 11.2 via
 * `ReplayRecorder.getTickInputs` / `getInputStream`.
 */
export type RecordedTickInputs = {
  readonly tick: number;
  /** One row per roster player present for this tick (association included). */
  readonly movement: ReadonlyArray<TickSelectedInput>;
  /** Effect-order action rows (flush order / call order). */
  readonly actions: ReadonlyArray<RecordedActionRow>;
};

export type CaptureTickInputsResult =
  | {
    ok: true;
    /** Envelope tick (movement key). */
    tick: number;
    movement: ReadonlyArray<TickSelectedInput>;
    /**
     * Projected actions from this fan-out. Each row carries its own effect
     * tick (may be earlier than `tick` for between-tick immediates that
     * arrived after the prior onTick deliver).
     */
    actions: ReadonlyArray<RecordedActionRow>;
  }
  | { ok: false; reason: string };

/**
 * Project a raw seam effect into a recorded action row via the 5.1 pure
 * canonical helpers. Returns null when the effect cannot form a canonical
 * edge (should not happen for notes emitted after handler validation).
 */
export function projectSimActionEffect(
  effect: SimActionEffect,
  ordinal: number,
): RecordedActionRow | null {
  if (
    typeof effect.tick !== "number" || !Number.isFinite(effect.tick) ||
    typeof effect.playerId !== "string" || effect.playerId.length === 0
  ) {
    return null;
  }

  if (effect.kind === "fire") {
    const parts = effect.fireKind === "melee"
      ? { melee: effect.packet ?? { yaw: 0, pitch: 0 } }
      : { shoot: effect.packet ?? { yaw: 0, pitch: 0 } };
    const canonical = canonicalFromWireParts(parts);
    if (!canonical.fire) return null;
    const aim = toFirePacket(canonical.fire);
    // Keep the exact look handle* received: canonical wraps yaw to [-π, π],
    // but live writes the raw packet yaw onto the shooter, and a 2π-shifted
    // angle is not bit-identical through sin/cos (spread / hitscan drift).
    const raw = effect.packet;
    if (raw && Number.isFinite(raw.yaw) && Number.isFinite(raw.pitch)) {
      aim.yaw = raw.yaw;
      aim.pitch = raw.pitch;
    }
    return {
      tick: effect.tick,
      playerId: effect.playerId,
      ordinal,
      kind: "fire",
      fireKind: canonical.fire.kind,
      aim,
      ...(effect.rewindStamp !== undefined
        ? { rewindStamp: effect.rewindStamp }
        : {}),
    };
  }

  if (effect.kind === "reload") {
    const canonical = canonicalFromWireParts({ reload: true });
    if (!canonical.reload) return null;
    return {
      tick: effect.tick,
      playerId: effect.playerId,
      ordinal,
      kind: "reload",
    };
  }

  if (effect.kind === "weaponSelect") {
    if (!isWeaponId(effect.weapon)) return null;
    const canonical = canonicalFromWireParts({ weapon: effect.weapon });
    if (canonical.weaponSelect == null) return null;
    return {
      tick: effect.tick,
      playerId: effect.playerId,
      ordinal,
      kind: "weaponSelect",
      weapon: canonical.weaponSelect,
    };
  }

  if (effect.kind === "ability") {
    if (!isSkillId(effect.ability)) return null;
    const canonical = canonicalFromWireParts({ ability: effect.ability });
    if (canonical.ability == null) return null;
    return {
      tick: effect.tick,
      playerId: effect.playerId,
      ordinal,
      kind: "ability",
      ability: canonical.ability,
    };
  }

  return null;
}

/**
 * Validate the 7.5 tick-input payload, project actions, deep-clone, deep-freeze.
 * Fail-loud on a live roster player with no selection row or an unanchored action.
 */
export function captureRecordedTickInputs(
  payload: Readonly<ReplayTickPayload>,
): CaptureTickInputsResult {
  if (payload == null || typeof payload !== "object") {
    return { ok: false, reason: "tick payload missing" };
  }
  if (typeof payload.tick !== "number" || !Number.isFinite(payload.tick)) {
    return { ok: false, reason: "tick anchor missing" };
  }

  const movement: TickSelectedInput[] = [];
  for (const [playerId, selection] of payload.inputs) {
    if (selection == null) {
      return {
        ok: false,
        reason: `missing selection for live roster player ${playerId}`,
      };
    }
    if (selection.playerId !== playerId) {
      return {
        ok: false,
        reason:
          `selection playerId mismatch for ${playerId} (got ${selection.playerId})`,
      };
    }
    if (selection.tick !== payload.tick) {
      return {
        ok: false,
        reason:
          `selection tick mismatch for ${playerId}: ${selection.tick} vs payload ${payload.tick}`,
      };
    }
    movement.push(selection);
  }

  const actions: RecordedActionRow[] = [];
  const rawActions = payload.actions ?? [];
  for (let i = 0; i < rawActions.length; i++) {
    const effect = rawActions[i]!;
    if (typeof effect.tick !== "number" || !Number.isFinite(effect.tick)) {
      return {
        ok: false,
        reason: `action[${i}] missing tick anchor`,
      };
    }
    // Ordinals are finalized when merging into the per-tick stream; use
    // payload order here as a stable provisional index for projection.
    const row = projectSimActionEffect(effect, i);
    if (!row) {
      return {
        ok: false,
        reason: `action[${i}] failed canonical projection (${effect.kind})`,
      };
    }
    actions.push(row);
  }

  const frozenMovement = deepFreeze(
    structuredClone(movement),
  ) as TickSelectedInput[];
  const frozenActions = deepFreeze(
    structuredClone(actions),
  ) as RecordedActionRow[];

  return {
    ok: true,
    tick: payload.tick,
    movement: frozenMovement,
    actions: frozenActions,
  };
}

/** Build a frozen per-tick row (used when merging late actions into a bucket). */
export function freezeRecordedTickInputs(
  tick: number,
  movement: ReadonlyArray<TickSelectedInput>,
  actions: ReadonlyArray<RecordedActionRow>,
): RecordedTickInputs {
  return deepFreeze({
    tick,
    movement: deepFreeze(structuredClone(movement as TickSelectedInput[])),
    actions: deepFreeze(structuredClone(actions as RecordedActionRow[])),
  });
}
