# Deterministic Game Rules Contract

This is the local contract for replay epic 4.3. It describes the authoritative
game-rule surface owned by `PlayerManager`, `Player`, and `MapCollision`.
It creates no recording, checkpoint, hash, or replay-file behavior.

## Authority and boundary

At a simulation tick, the authoritative rules result is a function of the
initial rules state, canonical player inputs, authoritative external events,
and the deterministic state listed below. Rendering, audio, UI, cameras, and
analytics are not rules inputs.

Damage amount generation and the hitscan-only projectile contract are owned
by epic 4.4 (`DETERMINISTIC_WEAPONS.md`). Bot decisions and the global
cross-system update order are owned by later 4.x work. This contract only
owns the rule consequences after those systems supply their inputs.

## Authoritative rules state

Manager-level state:

- stable player/session roster and team scores;
- phase and end state: `inPrematch`, `matchOver`, `restartAtTick`, and the
  frozen game-over snapshot;
- clock and doors: `matchEndTick`, `doorCycleOriginTick`,
  `doorsPowerUpUntilTick`, `raidDoorPolicy`, and `debugForceDoorsOpen`;
- prematch configuration and ready-vote state;
- the current simulation tick and match-duration configuration.

For every player, the future checkpoint/hash surface includes the stable id,
team, connected/connection-issue status, bot/agent flags, life state and
pose, plus these rule-owned fields:

- `diedAtTick` for respawn eligibility;
- `enemyDoorSinceTick` and `lastScoreAtTick` for capture dwell and cooldown;
- health, sprint stamina, ammunition, and `unlimitedAmmo`, because respawn
  and score-reset rules update them;
- all tick-based spawn-protection and combat modifiers needed to preserve the
  death/respawn consequence visible to the rules boundary.

Map state includes the seeded `spawnRng` held by `MapCollision`. Spawn poses
are reproducible only when every RNG-consuming spawn request is replayed in
the same canonical order.

## Future checkpoint/hash inventory

This is an inventory for later replay epics, not a serializer or hash schema.
The authoritative manager record must include:

- `simTick`, `scores`, `inPrematch`, `matchOver`, `restartAtTick`, and the
  frozen game-over snapshot;
- `matchEndTick`, `doorCycleOriginTick`, `doorsPowerUpUntilTick`,
  `raidDoorPolicy`, `debugForceDoorsOpen`, prematch configuration, and match
  duration;
- ready-vote state and live-match void/abandon state when ranked prematch is
  enabled;
- the canonical player roster in ascending stable id order, including each
  player's team, connection/life flags, bot/agent flags, pose, score, combat
  resources, `diedAtTick`, `enemyDoorSinceTick`, `lastScoreAtTick`, and other
  tick-based protections that affect future rule results;
- the map revision/configuration and `MapCollision` spawn-RNG state.

Operational timestamps such as AFK, participation, party expiry, connection
grace, and `liveStartedAtMs` are metadata and must not be included in a future
simulation checkpoint unless a later epic explicitly defines them as such.

## Rule semantics pinned by this epic

- Team selection and rebalance are roster functions. Agents do not participate
  in team counts or balancing and are exempt from team-fire restrictions.
- Doors are the single capture and ordinary-respawn-delay gate. The shared
  `getDoorCycleState`/`areDoorsOpen` gate applies this precedence: debug, raid
  policy, prematch, agents sealed, post-agent power-up hold, then the normal
  door cycle. Lifecycle transitions reset the cycle origin; power-up expiry
  creates a fresh open phase at its exact boundary.
- A score requires an eligible live, connected, non-agent player to remain in
  the enemy door zone through the dwell period and outside the cooldown. A
  score updates team and personal scores together, resupplies ammunition, and
  sends players home according to the PvP or raid rule while preserving sprint
  stamina on score teleports.
- Respawn eligibility is tick-based. Respawn restores health, sprint stamina,
  and ammunition; score teleports preserve health and sprint stamina.
- The normal win rule is first to `WIN_SCORE` while leading by
  `WIN_BY_MARGIN`. At the match time limit, the leader wins and a tied score
  draws. End-of-match effects freeze scores and schedule only the configured
  restart.
- An agent is created with an explicit pose, has unlimited ammunition, never
  respawns, seals doors while present, and may start the post-clear door
  power-up hold when removed.

## Canonical ordering policy

The adopted policy is stable ascending player/session-id order for all
multi-player rule passes, including score resolution, raid reset-player
enumeration, and respawn processing. Movement and player clipping retain their
separate roster order; this rule order controls only gameplay effects and the
shared spawn-RNG consumption sequence.

## External authoritative inputs for later replay work

These are server-owned events, not state reconstructed from player input.
They must be recorded by epics 5 and 7.5 when recording is introduced:

- `setDebugForceDoorsOpen` / debug-door toggle;
- `setRaidDoorPolicy` (`off`, `idle`, or `open`);
- `forceDraw`;
- `forceEndMatch`, including winner, `scheduleRestart`, and `restartSeconds`;
- prematch ready-vote changes and lifecycle calls that begin/end/restart a
  match;
- match/prematch configuration selected outside the simulation, including
  prematch policy and match duration;
- roster-changing or explicit-spawn events that can consume the shared spawn
  RNG, such as joins, team changes, rebalances, and agent add/remove.

Wall-clock values used for participation, AFK, connection timeout, or other
operational metadata are not authoritative rule inputs. The live server now
captures and passes explicit timestamps at its transport/tick boundaries;
direct helpers retain a `Date.now()` fallback for non-simulation callers.
The fixed-timestamp tests must continue to prove that gameplay advancement
does not read the wall clock.
