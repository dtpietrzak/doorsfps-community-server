# Deterministic System Ordering Contract

This is the local contract for replay epic 4.7. It pins the authoritative
execution order across one simulation tick. It creates no recording,
checkpoint, hash, or replay-file behavior.

Phase identities live in `simTickPhases.ts`. Runtime order lives in
`GameServer.startGameLoop` and must match that list.

## Locked decisions (Chunk 0)

| Topic | Decision |
|---|---|
| Human Shoot/Melee | Defer on packet arrival; resolve in `Weapons` **before** `MovePhysics`, ascending shooter id. Aligns with bot apply (pre-move). **Implemented (Chunk 3).** |
| Movement / clip roster | `simulationRoster` = ascending `player.id` (same policy as `ruleRoster` / `collectApplyRoster`). **Implemented (Chunk 2).** |
| Scores / respawns / hitscan fill | Already `ruleRoster` ascending id (4.3/4.4) — do not regress to Map join order. |
| Bot apply / think | Apply-first, think-last. `think(T) → apply(T + THINK_BUFFER_BOT_TICKS)`. Think must not mutate Player combat/pose this tick. |
| Bot Shoot | `HumanWeapons` renamed `Weapons`; bot shot intents now enqueue into the same queue as humans from `BotApply` and resolve in the `Weapons` flush, ascending shooter id alongside humans. `MAX_BOT_SHOTS_PER_TICK` / `ApplyShotBudget` deleted — no bot-only cap or cross-tick defer; `PlayerManager.handleShoot`'s `canShoot` ROF gate is the only limiter. **Implemented (keys-only PR 4).** |
| Intermission vs respawn | Pin current order: `Intermission` then `Respawn` on the same tick (new match may already have started). |
| Connection / AFK | Remain in-callback as `ConnectionAfkRebalance` (MIXED). 4.8 owns relocating NON-SIM work. |
| Combat vs overlap death channels | Combat deaths ride inside `CombatBurst`; overlap deaths use `PlayerDied`. Do not merge channels in 4.7. |
| Recording / checkpoints | Out of scope. Phase ids are the handoff surface for #8/#9. |

## SIM vs NON-SIM

See `SIM_TICK_PHASES` in `simTickPhases.ts`. Summary:

- **SIM** — advances state a future replay must reproduce.
- **NON_SIM** — metering, wire emit, AI enqueue, wall-clock probes; must not feed sim resolution.
- **MIXED** — wall-clock gated but may mutate roster (authoritative leave/AFK events for #5).

## Pinned event emission order

`CombatBurst` → `PlayerDied` → `Score` → `GameOver` → `PlayerRespawned`

(`SIM_TICK_EVENT_ORDER` in `simTickPhases.ts`.)

## Weapons vs movement

`BotApply` runs, then `Weapons`, both **before** `MovePhysics`. Human packets
that arrive between ticks associate to the **next** tick's `Weapons` flush
(association tick = the tick whose weapons phase drains the queue). Bot shot
intents built during `BotApply` this same tick enqueue into the same queue
and drain in the same flush, interleaved with humans by ascending shooter id
(keys-only PR 4 — no more bot-only resolution inside `BotApply`).

## Bot think / apply named contract

```text
think(T)  →  enqueue ReadyAction(applyAt = T + THINK_BUFFER_BOT_TICKS)
BotApply  →  consume due ReadyActions; shoot intents enqueue for Weapons (before Weapons / MovePhysics)
BotThink  →  after PoseSnapshot / Ping (must not mutate Player combat/pose)
```

Intervening `PlayerManager.update` / scores / respawns between think and apply
must not change `applyAt` or invent actions. Covered by
`bots/pipeline/bot_apply_hold_test.ts` and `bots/bot_think_apply_order_test.ts`.

## Handoff

- **4.8** — NON_SIM / MIXED cut is structurally enforced.
  Contract: [`DETERMINISTIC_SIMULATION_ISOLATION.md`](./DETERMINISTIC_SIMULATION_ISOLATION.md).
  Surfaces: `GameServer.stepSim` + `emitSimTickEvents`, `SimTickEvent` /
  `SimTickResult` (`simTickResult.ts`), `SIM_FILE_ALLOWLIST` (`simIsolation.ts`).
- **#5** — takes the `Weapons` association rule for tick-keyed input records,
  plus `SimTickEvent` as the authoritative in-memory event source.
- **#8 / #9** — key phase boundaries on `SimTickPhaseId`; record/checkpoint against
  `stepSim` + `SIM_FILE_ALLOWLIST` without modifying this contract.
