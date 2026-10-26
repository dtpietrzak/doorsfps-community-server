# Deterministic Simulation Isolation Contract

This is the local contract for replay epic 4.8. It separates the authoritative
simulation from transport, metering, presentation, and wall-clock adapters so
the sim can run headless. It creates no recording, checkpoint, hash, or
replay-file behavior.

Phase order remains owned by 4.7 (`simTickPhases.ts` /
`DETERMINISTIC_SYSTEM_ORDERING.md`). This epic **enforces** the SIM vs NON-SIM
cut structurally.

## Locked decisions (Chunk 0)

| Topic | Decision |
|---|---|
| Step entry name | `stepSim(tick, nowMs, …)` — extracted in Chunk 1 as a callable unit used by `GameServer.startGameLoop`. |
| Event ownership | Step **returns** in-memory authoritative events; the driver owns `sessions.emit`. Order stays `SIM_TICK_EVENT_ORDER`. |
| Connection / AFK | `ConnectionAfkRebalance` stays MIXED. Wall-clock is injected (`nowMs`); roster removals remain sim-visible authoritative events for #5. |
| BotThink | NON-SIM; stays after driver emit/adapters (4.5 / 4.7). Must not mutate Player combat/pose this tick. |
| Snapshots | `toSnapshot` / `createSnapshot` may serialize sim state but are **called from the driver**, not as part of state advancement. |
| Client localSim | `CampaignFpsPlayer` variable-dt integration is non-authoritative and must never be imported by sim modules. |
| Clock / RNG on step | Step signatures require injected `nowMs` and match RNG streams (4.6). No `Date.now` / `performance.now` / `Math.random` inside the step. Adapter signatures may default `nowMs = Date.now()`. |
| Transport identity | Sim keys on stable `player.id` / `isBot` / `connectionIssue`. `socketId` / `getBySocket` / `socketToPlayer` are adapter-only. **Chunk 4 done** (audit + `sim_identity_isolation_test.ts`). |
| Match-lifecycle RNG | Map-pick / leader-pick `Math.random` stay outside the per-tick step (adapters). Headless tick runner need not call them. |
| Recording / checkpoints | Out of scope. Step signature + allowlist are the handoff surface for #5 / #8 / #9. |

## SIM vs adapter

### SIM (advances replay-relevant state)

Core modules / surfaces the step may mutate or call:

- `shared/sim/moveStep.ts`, `shared/sim/game.ts` (constants + pure helpers), `shared/sim/simRng.ts`
- `server-community/players/Player.ts` (combat/pose/move; not socket binding)
- `server-community/players/PlayerManager.ts` — `update`, weapons flush, scores, respawns, match-end / intermission / time-limit, roster mutations that are authoritative
- `server-community/players/weaponsQueue.ts`
- `server-community/world/MapCollision.ts` (collision / spawn draws on injected streams)
- `server-community/bots/BotManager.ts` — churn, housekeeping, `applyReadyActions` only (not `thinkAll`)
- `server-community/bots/pipeline/*` apply path (`ReadyAction` → player input)
- Raid encounter / fail helpers invoked from the tick’s SIM phases

Runtime driver today: `GameServer.startGameLoop` (becomes thin driver over `stepSim`).

### Adapters (consume sim state; must not feed sim resolution)

- Transport: `sessions.emit`, per-socket `session.emit`, disconnect / welcome
- Wire presentation: `createSnapshot` / `toSnapshot` / `emitPoseStream` / Ping assembly
- Metering: `heatmaps.*`, `phaseTiming.record`, `performance.now` brackets
- Wall-clock ops: participation sampling, AFK kick **driver**, ping `t`, `endedAtMs`, rebalance notice timers
- Bot AI enqueue: `bots.thinkAll` (NON-SIM)
- Map-vote / rebalance UI flows, match report hooks

### Forbid list (inside the step / SIM modules)

Must not import or call:

- Transport hubs (`sessions`, `transport/*`)
- Client renderer (`three`, client `*.tsx`)
- Audio / DOM (`document`, `window`, `canvas`, `requestAnimationFrame`, `AudioContext`)
- Direct wall-clock (`Date.now`, `performance.now`) or process RNG (`Math.random`) — inject instead

Allowed escape hatch: clock/RNG arrive as **parameters** (same pattern as
`damageRandom` / match domain streams).

## Target tick shape

**Chunks 1–2 (done):** `stepSim` returns events + heatmap facts; driver applies
NON-SIM adapters then emits. MIXED roster logic stays in the step.

**Epic 7.1 (done):** connection-timeout `PlayerLeft` / `MapVoteState` moved to
driver via `SimTickResult.rosterLeaves` (emitted after `emitSimTickEvents`).
Ingress is `players/simIngress.ts`. Remaining MIXED transport side effects
reachable from the step: AFK kick (`kickPlayerForAfk` → `dropPlayer` emits),
abandon `MatchVoided`, prematch/rebalance broadcasts — deferred (not the
connection-timeout leave path).

```text
nowMs = Date.now()                         // driver only
t0 = performance.now()                     // driver only
result = stepSim(tick, nowMs)              // SIM + MIXED; no timing/heatmap writes
recordShoot / departures from result       // NON-SIM
sampleParticipation + heatmaps.tick        // NON-SIM (post-step)
emitSimTickEvents(result.events)           // pinned SIM_TICK_EVENT_ORDER
pose / ping                                // NON-SIM
bots.thinkAll(tick, …)                     // NON-SIM
phaseTiming.record(…)                      // NON-SIM
```

## Named contracts (Chunk 6)

| Contract | Location |
|---|---|
| Phase order / event order | `simTickPhases.ts` (`SIM_TICK_PHASES`, `SIM_TICK_EVENT_ORDER`) |
| Returned events | `simTickResult.ts` (`SimTickEvent`, `SimTickResult`) |
| SIM allowlist + forbid scan | `simIsolation.ts` (`SIM_FILE_ALLOWLIST`, …) |
| Runtime step + emit | `GameServer.stepSim`, `GameServer.emitSimTickEvents` |
| Headless proof | `simIsolation_test.ts` |

## Handoff

- **#5 (inputs)** — takes the step’s per-tick input parameter shape and
  `SimTickEvent` as the authoritative event source.
- **#8 / #9 (record / checkpoints)** — take `stepSim` + `SIM_FILE_ALLOWLIST` as
  the record/checkpoint boundary; headless runner is the future replay sim seam
  (bot inputs replayed, never re-thought per 4.5).
- **4.7** — phase ids stay the order contract; NON-SIM work is driver-owned.
