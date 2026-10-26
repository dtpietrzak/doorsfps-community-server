# Deterministic Bot Simulation Boundary Contract

This is the local contract for replay epic 4.5. It describes the think→sim
handoff owned by `BotManager.applyReadyActions`, `bots/pipeline/*`, and the
`PlayerManager` entry points those steps call. It creates no recording,
checkpoint, hash, or replay-file behavior.

## Authority and boundary

At a simulation tick, bot-driven sim inputs are a pure function of:

- the delayed `ReadyAction` stream already queued for this tick;
- apply hold / look-interp state (`applyInterp`);
- optional apply-time raid WASD stop;
- the five apply steps (`APPLY_STEP_IDS`);
- inventoried `isBot` / match parameters listed below.

Shoot enqueues onto the shared Weapons queue (`players/weaponsQueue.ts`)
exactly like a human client's Shoot packet — no apply-time cap (keys-only
PR 4 deleted `MAX_BOT_SHOTS_PER_TICK` / `ApplyShotBudget` / `pendingShoot`).
Resolution and the only remaining fire-rate limit (`PlayerManager.handleShoot`'s
`canShoot` ROF gate) live entirely in the Weapons-phase flush, shared with
humans.

Think (`@doors/bot-engine`), churn, housekeeping, and wall-clock metering are
**not** sim inputs. Replay records the applied stream and **never re-thinks**.

```text
think (NON-SIM) → ReadyAction (+ THINK_BUFFER_BOT_TICKS)
                → botInputAdapter (normalize / sample / raid / idle)
                → applyReadyActions → runApplyPipe (boundary)
                → PlayerManager.handleInput / Shoot / Reload / Switch / Ability
                → Player sim (SIM)
```

`ReadyAction` plus the five apply steps are the **only** think→sim crossing.
Epic 5.4 owns think→per-tick conversion in `botInputAdapter.ts`; the pipe
still performs the `handle*` calls.
Bots must not mutate `Player` fields except through those `PlayerManager`
entry points.

## Locked decisions

| Topic | Decision |
|---|---|
| Think→sim crossing | `ReadyAction` + `APPLY_STEP_IDS` only |
| Apply iteration order | Stable ascending player/session id (bots + agents in one ordered list) via `collectApplyRoster`. Same policy as 4.3/4.4 `ruleRoster`. |
| Apply step order | `stampAndInput` → `weaponSwitch` → `reload` → `shoot` → `ability` |
| Think delay | Fixed tick-count: `THINK_BUFFER_BOT_TICKS`. Wall-clock think duration is NON-SIM. |
| Tick placement (4.7) | `BotApply` before MovePhysics; `BotThink` after emit. `think(T) → apply(T + THINK_BUFFER_BOT_TICKS)`. See `players/DETERMINISTIC_SYSTEM_ORDERING.md`. |
| Think-internal RNG / AI | Allowed; must not leak into sim. Only emitted `ReadyAction` crosses. |
| Raid WASD stop | Apply-time transform before the pipe; part of the applied stream. |
| Recording | Out of scope here. Future fields enumerated below. |

## Apply pipe (sim-input, not sim-logic)

Per managed bot each sim tick (after due-slot / interp / raid stop):

1. **stampAndInput** — stamp monotonic `bot.sequence`, call `handleInput`.
2. **weaponSwitch** — edge-gated `handleWeaponSwitch`.
3. **reload** — edge-gated `handleReload`.
4. **shoot** — build `ShootPacket` `{ yaw, pitch, clientTick }`, enqueue onto the shared Weapons queue (`enqueueWeapon`); no apply-time cap or deferral (keys-only PR 4). Resolved later in the Weapons-phase flush, same as a human's Shoot packet.
5. **ability** — edge-gated `handleAbility`.

Combat edges (shoot / reload / weapon / ability) fire on the **first** sim
tick of a ready slot only (`combatEdgeDone`). Between slots, keys hold and
look interpolates; empty buffer holds/idles and never invents keys.

`takeDueReadySlot`: FIFO; if several slots are due, the latest due wins.

## SIM vs NON-SIM

| Call / field | Classification |
|---|---|
| `ReadyAction` stream, apply interp, raid WASD stop, apply pipe | SIM input boundary |
| `PlayerManager` handle* entry points and below | SIM (owned by 4.2–4.4 as applicable) |
| `attacker.isRaidBot` damage-drop branch in shoot/melee | SIM rule (see inventory) |
| `lastApplyMs` / `lastThinkMs` / `thinkMsTotal` / `performance.now` metering | NON-SIM; must never feed resolution |
| `nowMs` on apply context | Transport / AFK bookkeeping stamp; NON-SIM for resolution |
| AFK hard-kick (humans roster only) | NON-SIM operational |
| Think scheduling, compiled-think async, churn / fill | NON-SIM / match config |

## `isBot` inventory

The bot-official keys-only epic (`the keys-only note`) finished
(keys-only PR 7): the sim has no `Player.isBot` reads left anywhere in this
boundary. Roles the sim may branch on are `isAgent` (grey FFA) and
`isRaidBot` (raid damage drop) only — `Player.isBot` ("AI-controlled") is
NON-SIM bookkeeping (AFK, participation, party, snapshots).

Roster/checkpoint recording keeps the field name `isBot` for the wire/schema,
but it now carries the **raid-bot role**, not "AI-controlled": `true` only
for a raid bot in raid mode. Arena fill bots and agents record `isBot: false`
(agents carry `isAgent: true` separately), same as humans — the recording is
identity-stripped by construction, not by a test-only rewrite.

| Branch | Classification |
|---|---|
| `scaleRaidBotDamage` on shoot/melee when `attacker.isRaidBot` | SIM rule keyed on the raid-bot *role* + extra RNG draw (4.6 owns draw order). Arena bots: removed (keys-only PR 2). |
| ~~Lag-comp RTT window bypass (`!shooter.isBot`)~~ | Removed (keys-only PR 3). Bots stamp `clientTick`/`lastAppliedSnapshotTick` from `ReadyAction.observedTick` and share the human RTT window (no pongs → unknown-RTT band). |
| ~~Bot slide stamina assist~~ | Removed (keys-only PR 1). |
| ~~Bot airborne clearance assist (`BOT_JUMP_CLEARANCE_ASSIST`)~~ | Removed (keys-only PR 1). |
| ~~Server-authored idle / cadence inputs (`idleManagedBot`, raid movement cadence)~~ | Removed (keys-only PR 5, PR 6) — bot-official emits every key, including idle and raid temperament. |
| Construction flags `isAgent` / `isRaidBot` | Initial / checkpoint state; `isBot` (bookkeeping) derives from `isAgent` on reconstruction (see `PlayerManager.insertFromAuthoritativeRoster`, `checkpointLoading.playerFromCheckpointState`). |
| Recorded roster/checkpoint `isBot` field | Wire/schema name for the raid-bot role (see above), not "AI-controlled". |
| Snapshot omit `lastProcessedInputSeq` / attach `botDec`; `socketId = null` | Wire / identity only; not movement logic. |
| AFK kick humans-only | NON-SIM. Note: `touchActivity` may still stamp for bots; kick path uses humans roster. |

## Future recorder surface (epic #5+)

Per tick per bot (applied stream — never re-derived from AI):

- `playerId`, stamped `sequence`
- applied `PlayerInput` after interp / raid stop (`null` when idle/hold without input)
- shoot / reload / weapon / ability edges actually invoked (shoot: the enqueued
  Weapons-queue request, resolved in the same tick's Weapons flush)
- identity flags: `isAgent`, `isRaidBot` (recorded on the wire as `isBot`)

Per match (not per tick):

- `raidDoorPolicy` and other match config that gates bot-only SIM branches

Replay consumer rule: reconstruct from this stream; **do not re-run think**.

## Handoff

- **4.6** — sim-side raid-bot draws (`scaleRaidBotDamage`) join seeded draw order; think RNG stays outside by construction.
- **4.7** — consumes apply step order, ascending-id apply iteration, and apply→sim→think phase order.
- **4.8** — think-side packages and churn are non-sim; at and below `PlayerManager` entry points are sim.
- **#5+** — serialize/hash the applied per-bot stream enumerated above.
