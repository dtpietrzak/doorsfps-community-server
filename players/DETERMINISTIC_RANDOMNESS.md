# Deterministic Gameplay-Relevant Randomness Contract

This is the local contract for replay epic 4.6. It describes the match-seeded
RNG surface owned by the authoritative simulation (`PlayerManager`,
`MapCollision`, `BotManager` agent drops). It creates no recording,
checkpoint, hash, or replay-file behavior.

## Authority and boundary

At a simulation tick, gameplay-relevant random outcomes are a pure function of:

- the **match seed** (initial state for this match);
- the **per-domain stream** identities and their draw positions;
- the ordered sim events that consume those draws (shots, melees, spawns,
  door-close agent rolls).

Rendering, audio, UI, cameras, tracers, analytics, transport IDs, bot-official
internal dice, and match-config picks that are recorded as outcomes (not
re-rolled) are **not** sim RNG inputs.

```text
matchSeed
  → deriveDomainSeed(matchSeed, domain)
  → createSimRng(domainSeed)   // one stream per domain
  → SIM draws (damage / spread / spawn / agents)
```

Replay (#8+) records the match seed (and named MATCH-CONFIG outcomes) and
**never** re-seeds from wall clock or re-rolls those outcomes.

## Locked decisions

| Topic | Decision |
|---|---|
| PRNG | xorshift32 matching `MapCollision` / `bot-official` `createRandom` style. Factory: `createSimRng(seed): () => number` in `shared/sim/simRng.ts` (Chunk 2). |
| Domain streams | Separate streams: `damage`, `spread`, `spawn`, `agents`. Each derived from `matchSeed + domainTag` so a draw in one domain never shifts another. |
| Per-shot order | Spread radius → spread angle (`spread` stream) → damage sample → raid-scale when `shooter.isRaidBot` (`damage` stream). Melee: damage sample → raid-scale when `attacker.isRaidBot`. Arena bots draw exactly like humans. |
| Match seed | Generated at match creation (`crypto` or config override for tests). Stored on the sim owner; **reseeded on every match start / restart**. Exposed for later recording — not persisted in this epic. |
| Injection compatibility | Keep `damageRandom` / existing inject hooks for tests. Live defaults become the seeded domain streams instead of `Math.random`. |
| Spawn policy | Reseed `spawn` stream per match. `randomSpawn` always advances a **fixed** draw count per call (consume the full sample budget even after an acceptable candidate is found) so early-break no longer skews later spawns. First acceptable candidate is still the returned pose. |
| Agent door-close order | Count roll (`agents`) → first-door coin when applicable (`agents`). |
| Agent / bot UUIDs | Do **not** seed. Classify as MATCH-CONFIG / NON-SIM identity; #5/#8 records the string. |
| Map-vote winner / ties | Do **not** seed. MATCH-CONFIG outcome owned by #5/#8. |
| Bot-think RNG | Outside the boundary (4.5). Only emitted `ReadyAction`s cross into the sim. |
| Recording | Out of scope. Seed + named outcomes are enumerated only. |

## Domain stream identities (future seed-record / hash surface)

| Domain | Consumers | Notes |
|---|---|---|
| `damage` | `rollDamageVariation`, `scaleRaidBotDamage` (shoot + melee, raid bots only) | Replaces live `damageRandom` default |
| `spread` | `applyAimSpread` / `spreadDirectionFromYawPitch` on authoritative shoot path | Split from shared 4.4 `damageRandom` coupling |
| `spawn` | `MapCollision.randomSpawn` (and any other spawn-pose draws on this stream) | Reseeded per match; fixed draws per call |
| `agents` | `rollAgentsPerDoorClose`, `allocAgentDoor` first-door coin | Not agent UUID / name allocation |

Stream names and the match seed are the minimal surface #8/#9/#18 will
persist and hash. No serializer lives here.

## SIM vs MATCH-CONFIG vs NON-SIM vs VISUAL

Disposition vocabulary for the inventory (Chunk 1 fills rows):

| Disposition | Meaning |
|---|---|
| **SEED** | Consumed by sim; must use a domain stream from the match seed |
| **RECORD** | Outcome is initial/config state or identity; record it later, do not re-roll from a seed in-sim |
| **KEEP+PROOF** | May stay `Math.random` / `crypto`; must prove output never reaches sim state |
| **VISUAL** | Client presentation only; confirm no writeback into authoritative state |

### Seeded (SIM) — owned by this epic

- Damage variation + bot damage scale (shoot / melee)
- Aim spread on the authoritative server shoot path
- Team spawn poses (`randomSpawn`)
- Agent-per-door-close count and first-door side

### Record later (MATCH-CONFIG) — enumerate only

| Outcome | Owner | Notes |
|---|---|---|
| Match seed | #8 (initial state) | Exposed by 4.6; not persisted here |
| Map-vote winner / no-vote pick / tie break | #5 / #8 | `GameServer.resolveMapVoteWinner` |
| Bot churn join/leave timing & identities | #5 / #8 | Reuse 4.5 enumeration; do not duplicate |
| Agent / bot identity strings (`crypto.randomUUID` suffixes, etc.) | #5 / #8 | Do not seed UUIDs |

### Keep unseeded (NON-SIM) — prove non-observable

- `BotManager.rand` churn cadence, name/shuffle picks
- `poolMapVotes` bot-vote stuffing (intermission UI)
- Pool-pawn display ping (`setPawnPing` from the population director)
- Transport / runtime IDs (`crypto.randomUUID` for non-sim handles)
- XP / coin / match-card claim randomness on `GameServer`
- Wall-clock metering (`Date.now`, think/apply ms totals)
- Bot-think internal RNG (`@doors/bot-engine`)

### Visual-only — confirm no sim feedback

- Client tracers, particles, muzzle/crosshair jitter, audio variation
- Client `aimSpread` preview path (non-authoritative)

## NON-SIM / VISUAL proofs (Chunk 5)

Call-graph arguments (tests where cheap). Anything that cannot be proven
must move to SEED or RECORD.

| Source | Proof |
|---|---|
| `poolMapVotes.seedPoolMapVotes` | Writes only into `GameServer` intermission vote map (`mapVotes`); never called from `PlayerManager` tick / combat / spawn. Covered by `poolMapVotes_test` purity + this contract. |
| `BotManager.rand` churn delay / `mirrorRoll` | Adjusts fill target / schedules reconcile joins/leaves. Sim combat state changes only after bots are added/removed as roster events (#5 records those). Does not call `handleShoot` / `randomSpawn` / damage APIs. |
| Pool display ping (`setPawnPing`) | The director samples `samplePlayerSimPingMs` off the sim tick and sends `set-ping`. The host writes `player.pingMs` for `role === "pool"` only. 4.4 classifies live ping as NON-SIM; replay supplies recorded lag-comp inputs. |
| Bot/agent `crypto.randomUUID` ids | Identity strings only. Pose/combat use player id as a key but not the UUID entropy as a roll. Same match seed + same inputs → identical combat/spawn/agent-count outcomes even when ids differ (see `sim_rng_non_observability_test`). |
| `runtimeMatchId` / `heatmapBatchId` | Authority / heatmap batch correlation only. |
| `GameServer.resolveMapVoteWinner` | Intermission map pick; RECORD outcome. Does not run during a live sim tick. |
| Client `aimSpread` / audio / FX / Menu RNG | Client-only; no server writeback path into `PlayerManager` state. |
| `bots/helpers/nav.ts` rng | Think/nav helpers behind ReadyAction boundary (4.5). |
| Authority adapter `random` / temp UUIDs | HTTP/IO path outside community tick loop. |

## Future recorded fields (#5 / #8) — enumerate only

Named surface for recording epics (no serializer here):

1. `matchSeed` (`PlayerManager.getMatchSeed()`)
2. Domain stream identities: `damage`, `spread`, `spawn`, `agents`
3. Map-vote winner / no-vote pick / tie-break result
4. Bot churn join/leave events + identities (reuse 4.5)
5. Bot/agent/balance-bot id strings
6. Bot join loadout / seed-profile outcomes when not derived from recorded catalog

## Inventory table

Closed in Chunk 1 via repo-wide grep of `Math.random`, `crypto.randomUUID`,
`crypto.getRandomValues`, and injectable `rand`/`rng` defaults under
`server-community/`, `shared/`, and `client/src/` (excluding tests, scripts,
`node_modules`). Zero unclassified **sim-reachable** sources remain; rows
below are the authoritative dispositions for this epic.

### SEED (sim — this epic)

| Location | Domain | Notes / chunk |
|---|---|---|
| `PlayerManager` damage / raid-scale / melee via `damageRandom` → match `damage` stream | `damage` | Done (Chunk 3) |
| `handleShoot` → `spreadDirectionFromYawPitch` via `spreadRandom` | `spread` | Done (Chunk 3) |
| `MapCollision.spawnRng` + `randomSpawn` (fixed draws/call) | `spawn` | Done (Chunk 4) |
| `BotManager.maybeSpawnAgentOnDoorClose` → `rollAgentsPerDoorClose(agentsRandom)` | `agents` | Done (Chunk 4) |
| `BotManager.allocAgentDoor` first-door coin via `agentsRandom` | `agents` | Done (Chunk 4) |

### RECORD (match-config / identity — #5 / #8; do not seed)

| Location | Owner | Notes |
|---|---|---|
| Match seed itself | #8 initial state | Exposed by 4.6; not persisted here |
| `GameServer.resolveMapVoteWinner` no-vote pick + tie break | #5 / #8 | Bare `Math.random` |
| `server-community/main.ts` `pickRandomMap` (process map pick) | #5 / #8 | Startup / rotation config |
| Bot/agent/balance-bot id suffixes (`crypto.randomUUID` in `BotManager`) | #5 / #8 | Identity strings |
| `runtimeMatchId` / `heatmapBatchId` (`GameServer`) | #5 / #8 / ops | Metering / authority correlation; not sim pose |
| Bot join loadout / profile / seed-pool rolls (`server-game/official-bots/*` injectable `rand`) | #5 / #8 | Rolled by the director. The host stores the pool identity; do not re-roll from seed in-sim |
| Churn join/leave timing & roster identities | #5 / #8 | Reuse 4.5 enumeration |

### KEEP+PROOF (non-sim — Chunk 5 proves non-observable to sim state)

| Location | Rationale |
|---|---|
| `BotManager.rand` churn delay / mirror band (`rollChurnDelayMs`, `mirrorRoll`) | Produces roster events; #5 records joins/leaves. Must not feed combat/movement math directly. |
| Pool-pawn `setPawnPing` (director `samplePlayerSimPingMs`) | Lag-comp live RTT is NON-SIM operational (4.4); replay supplies recorded lag-comp inputs. The oscillator is not on the sim tick. |
| `BotManager` name / shuffle picks via `rand` | Presentation / roster labeling only when not identity-RECORD above. |
| `poolMapVotes.ts` bot-vote stuffing | Intermission UI only. |
| `bots/helpers/nav.ts` path sample `rng` | Think-side / nav helper; outside 4.5 ReadyAction boundary. |
| `authority/adapter.ts` `random` + UUID temp paths / batch ids | Authority claims / IO; not community sim tick. |
| `shared/sim/game.ts` `pickLevelLegalEquipment` default `rand` | Seed-catalog authoring helper; not per-match sim. |
| `shared/authority/devAuthorityTokenKeys.ts` `getRandomValues` / UUID tmp files | Dev key material; not sim. |
| Transport session ids (`webTransportHub`, client transports) | Connection handles only. |
| Client analytics / launch-intent / Find drop-in ids | Client ops only. |

### VISUAL (client presentation — Chunk 5 confirms no sim writeback)

| Location | Notes |
|---|---|
| `client/src/game/aimSpread.ts` `Math.random` default | Non-authoritative preview; server injects. |
| `client/src/game/MapCollision.ts` `randomSpawn` | Client prediction / offline only. |
| `client/src/game/networkSim.ts` | Net sim harness. |
| `client/src/game/MatchXpGain.tsx`, `GameOverModal.tsx` particles | UI FX. |
| `client/src/game/audio/*` synth jitter | Audio only. |
| `client/src/pages/Menu.tsx` skill order pick | Menu UI. |
| `client/src/game/campaign/CampaignDoorsLevel.tsx` local bot jitter | Offline campaign; not community authoritative sim. |

### Defaults that stay injectable (non-authoritative callers)

| Location | Notes |
|---|---|
| `server-community/combat/aimSpread.ts` `rng = Math.random` | Documented non-sim / preview default; authoritative path must inject (Chunk 3). |
| `rollAgentsPerDoorClose(rand = Math.random)` | Keep default for unit tests; door-close call site must pass `agents` stream (Chunk 4). |

## Relationship to 4.4 weapons RNG

Epic 4.4 pinned injection points and per-shot order on a **shared**
`damageRandom` injectable. Epic 4.6 replaces that coupling with separate
`spread` and `damage` domain streams while preserving the same logical order
(spread samples before damage samples on each shot). See
`DETERMINISTIC_WEAPONS.md` (updated to point here).

## Handoff

- **4.7** — pinned draw orders (per-shot, per-door-close, per-spawn) and
  domain stream identities as inputs to global execution order.
- **4.8** — SEED vs RECORD vs KEEP+PROOF vs VISUAL as the isolation seam.
- **#5 / #8** — record match seed as initial state plus named MATCH-CONFIG
  outcomes; never re-roll them.
- **#9 / #18** — hash / checkpoint the match seed and stream positions as
  needed for divergence detection.

## Production independence

After 4.6 the game still operates exactly as a live game. No replay file,
recorder, or viewer is required. Output is a seeded-randomness contract plus
tests: gameplay randomness is reproducible from a per-match seed, and every
remaining nondeterministic source is proven outside the sim.
