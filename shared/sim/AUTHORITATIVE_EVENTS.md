# Authoritative Events Contract

Local contract for replay epic **5.5**. Defines the canonical non-input
event vocabulary in `shared/sim/authoritativeEvent.ts`. Creates no recording,
checkpoint, transport, or playback behavior.

Live construction: `PlayerManager` mutation sites derive events via
`server-community/players/authoritativeEventDerive.ts` and push into a
drainable buffer (`drainAuthoritativeEvents` / `peekAuthoritativeEvents`).
`buildMatchInitEvent()` builds the init snapshot without buffering.

## Authority and boundary

Server-owned state changes that cannot be expressed as
`CanonicalPlayerInput` enter the sim as `AuthoritativeEvent`. Every variant
carries `appliedTick`. Application point (for later replay) is the tick
boundary **before** player updates — matching today's outside-`update`
call sites.

Out of scope here:

| Concern | Owner |
|---|---|
| Canonical per-tick input | 5.1 |
| Tick / missing / late input policy | 5.2 |
| Human / bot adapters | 5.3 / 5.4 |
| Live event-source wiring / match metadata | 7.3–7.5 |
| Persistence / buffering / finalization | #8 |
| Checkpoints | #9 |
| File format | #10 |
| Playback re-apply | 11.2 |

## Closed event inventory

| Kind | Live source |
|---|---|
| `matchInit` | `buildMatchInitEvent()` (recording start shape) |
| `matchConfig` | `setRaidDoorPolicy`, `setDebugForceDoorsOpen` / toggle |
| `humanJoin` | `add` |
| `botAdd` | `addBot` |
| `agentAdd` | `addAgent` |
| `agentRemove` / `playerRemove` | `remove` (agent vs non-agent) |
| `connectionStatus` | `markConnectionIssue`, `takeOverConnection` / `restoreConnection` |
| `teamAssign` | `changeTeam`, `forceChangeTeam`, `forceChangeTeamGroup`, `rebalanceBotTeams` |
| `loadoutCommit` | `handleSkillLoadout` when `raw` is an array |
| `readyVote` | `setMatchReady`; `clearAll` on prematch roster wipe |
| `matchStart` | `enterPrematch`, `beginLiveMatch` (via `startNewMatch` / restart) |
| `matchEnd` | `endMatch` with winner `A`/`B` |
| `matchDraw` | `endMatch` with winner `draw` (`forceDraw`) |
| `combatBurst` | Mapped from `SimTickResult` CombatBurst (epic 7.3) |
| `playerDied` | Mapped from `SimTickResult` PlayerDied (epic 7.3) |
| `score` | Mapped from `SimTickResult` Score (epic 7.3) |
| `gameOver` | Mapped from `SimTickResult` GameOver when no same-tick `matchEnd`/`matchDraw` (epic 7.3 dedup) |
| `playerRespawned` | Mapped from `SimTickResult` PlayerRespawned (epic 7.3) |

Operational wall-clock values (AFK, participation, party expiry, connection
grace deadlines, `liveStartedAtMs`) are **not** authoritative event fields.

## Intra-tick order

Pinned as category order then ascending stable id:

1. **lifecycleConfig** — `matchInit` → `matchConfig` → `matchStart` →
   `matchEnd` → `matchDraw`
2. **roster** — joins / adds / removes / connection, sorted by affected
   player id ascending
3. **commit** — `teamAssign` → `loadoutCommit` → `readyVote`, then by id
4. **simOutcome** — `combatBurst` → `playerDied` → `score` → `gameOver` →
   `playerRespawned` (mirrors `SIM_TICK_EVENT_ORDER`; epic 7.3)

Use `sortAuthoritativeEvents` / `compareAuthoritativeEvents`. Live buffer
order is construction order; recording/replay should sort before apply.

Unified per-tick source (epic 7.3): `drainTickAuthoritativeEvents` in
`server-community/players/authoritativeEventSource.ts` returns sorted 5.5
buffer events then mapped sim outcomes. `GameOver` is omitted when the same
tick already has `matchEnd`/`matchDraw`.

## Spawn-RNG rule (Decision 4)

Spawn-consuming roster ops request poses in ascending stable-id order under
the 4.3 policy. Event payloads **also** record the drawn pose so replay can
re-apply without re-drawing, and 9.4 can cross-check. Domain ownership of
the RNG stream stays with epic 4.6.

## Normalization (`normalizeAuthoritativeEvent`)

- `appliedTick` must be a non-negative finite integer (else reject → `null`).
- Team ids restricted to `A` / `B`.
- Poses require five finite numbers (`x,y,z,yaw,pitch`).
- Equipment via `normalizePlayerEquipment`.
- Loadout unknown / duplicate skill ids → null slots (live validator).
- `matchConfig` requires at least one of `raidDoorPolicy` /
  `debugForceDoorsOpen`.
- Result is JSON-serializable (no class instances).

## Snapshot-not-delta (Decision 3)

Roster / team / connection events carry the **resulting** sim-relevant
player snapshot so re-application does not require looking up earlier
stream position. Removes carry `playerId` only (entity absent after apply).

## Handoffs

- **7.3 / 7.5** — Tap `drainTickAuthoritativeEvents(tick, simEvents)` (and
  `buildMatchInitEvent`) at the server event-source boundary. Do not reshape
  the union beyond the documented 7.3 sim-outcome variants.
- **8.2 / 8.4** — Persist `matchInit` + the per-tick sorted event stream
  alongside inputs. Byte layout is #10.
- **9.1** — Checkpoint roster/config payload shapes reuse these snapshots.
- **11.2** — Re-apply events in canonical order at the tick boundary before
  player updates; use recorded poses, do not re-run join team-pick logic.
- **5.1** — Skill loadout stays here, never on `CanonicalPlayerInput`.
