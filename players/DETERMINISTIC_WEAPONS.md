# Deterministic Weapons and Projectiles Contract

This is the local contract for replay epic 4.4. It describes the authoritative
weapons surface owned by `PlayerManager`, `Player`, and
`server-community/combat/*`. It creates no recording, checkpoint, hash, or
replay-file behavior.

## Authority and boundary

At a simulation tick, the authoritative weapons result is a function of:

- per-player weapon sim state (inventory below);
- per-tick shoot / melee / reload / switch inputs;
- injected RNG samples for spread and damage;
- lag-comp pose inputs (rewind target poses plus the window inputs listed
  under future recorded events);
- ability flags already present as tick state (Rapid Fire, Hawkeyes, OneShot,
  Glitch, Bullets free-fire, Force Field / spawn invulnerability).

Rendering, audio, UI, cameras, tracers, and analytics are not weapons inputs.
Movement pose integration and `takeDamage` / death application internals are
owned by 4.2; this contract owns fire gates, bloom direction, hitscan
selection, damage **amount** computation, and melee resolution up to the
`takeDamage` boundary. Bot decision-making is owned by 4.5. Global RNG policy
is owned by 4.6. Cross-system tick order is owned by 4.7.

## Locked decisions

| Topic | Decision |
|---|---|
| Hitscan target-list order | Stable ascending player/session id (same policy as 4.3 rule passes). Equidistant tie-breaks and `limit` truncation follow this order, not Map join/insertion order. |
| Spread RNG source | Separate `spread` domain stream from match seed (`PlayerManager.spreadRandom`). |
| Per-shot draw order | Bloom draws → pellet pattern draws (multi-pellet guns, normal mode only) → per victim in ascending id order: damage roll → raid-scale draw (raid bots only). Bloom and pattern sample the `spread` stream; damage/raid-scale the `damage` stream. |
| Multi-pellet damage | One outcome per victim per shot: pellet bases (zone × falloff at that pellet's distance) are summed per victim, then rolled once. Zone is `head` if any pellet hit the head. OneShot / raid-scale / ≥ 1 clamp / teamfire mirror / Leech / hit-slow run once per victim. |
| Projectiles | Hitscan-only. Snapshots always carry `projectiles: []`. `SnapshotProjectile` remains an unpopulated placeholder. |
| Recording | Out of scope. Lag-comp live filter inputs are enumerated as future recorded events only. |

## Authoritative weapon state

Per player, the future checkpoint/hash surface for weapons includes:

- `weaponId` (active slot);
- `lastShotAtTick`, `lastMeleeAtTick`;
- `reloadEndsAtTick` and `pausedReloadRemainingTicks` (per-slot remaining);
- `weaponSwitchEndsAtTick`;
- per-slot `ammoInMag` / `spareClips` (and `unlimitedAmmo` / Bullets free-ammo window as tick-gated flags);
  for shell guns `spareClips` counts loose spare shells;
- shell guns: per-slot `chambered`, plus per-player `shellReloadNextAtTick`
  (next shell-insert tick while loading) and `pumpEndsAtTick` (checkpoint
  omits both when null, and `chambered` on mag-gun slots, so pistol/rifle
  checkpoints keep their pre-shotgun shape);
- hit-slow stacks and expiry (`hitSlowStacks` / `hitSlowEndsAtTick` as consumed by `activeHitSlowStacks` / `activeHitSlowEndsAtTick`).

### Shell reload + pump (shell guns)

Per-tick order inside `Player.update`: `tickWeaponSwitch` (a shell gun drawn
uncocked starts its pump here) → `tickReload` (shell insert when due; the
reload ends with a pump when the tube fills or spares run out) → `tickPump`
(sets `chambered`). Reload opens for `startMs`, then inserts one shell every
`perShellMs`. A switch stops loading (loaded shells stay, nothing is paused)
and drops a pump in progress, leaving the slot uncocked. Starting a reload
drops a post-shot pump, since the reload ends with its own. Rapid Fire halves
each open / per-shell / pump timer that **starts** under the buff. No RNG.

Ability charge/activation systems are not owned here; only their weapon-path
effects at a given tick are inputs (Rapid Fire cooldown/reload halving at
timer start, Hawkeyes zero cone, OneShot lethal floor, Glitch shoot/melee
block, Bullets free-fire, invulnerability gates).

Manager-level metering such as `rewindClampTotal` is NON-SIM and must never
feed back into shot resolution.

## SIM vs NON-SIM on the shoot path

| Call / field | Classification |
|---|---|
| `canShoot` / `markShot` / reload / switch / melee tick gates | SIM |
| Spread direction, hitscan, damage roll, raid-scale, OneShot / teamfire / Leech / hit-slow triggers | SIM |
| `touchActivity()` from shoot/reload/melee | NON-SIM (AFK / participation metadata only; must not mutate weapon sim state) |
| `Date.now()` / `opts.nowMs` death timestamp fallbacks | NON-SIM operational timestamp; tick-loop passes explicit `nowMs` |
| Live `pingFilter` EWMA evolution from pongs | Live operational; replay must supply recorded values (see below), not re-derive |
| `recordRewindClamp` / `rewindClampTotal` | NON-SIM metering |

## Per-shot resolution order (pinned for 4.7)

For `handleShoot`, after the action effect is noted:

0. Shell guns: a press while `shellReloadNextAtTick` is set is consumed as the
   reload interrupt (`tryInterruptShellReload`): loading stops, a pump starts,
   and the handler returns with no shot and no RNG draws. Otherwise the fire
   gate (`canShoot`) runs, which for shell guns also requires `chambered` and
   no pump in progress.
1. `markShot` (ammo / cooldown stamp; shell guns start a pump)
2. Apply packet yaw/pitch (clamped)
3. Resolve shoot origin (server eye + soft client clamp)
4. Bloom direction from stance cone + RNG (Hawkeyes forces zero cone)
5. Pellet directions around the bloomed aim (`shared/sim/pellets.ts`
   `pelletDirections`). Single-pellet guns: the aim itself, no draws.
   Multi-pellet: 1 ring rotation + 2 jitter draws per ring pellet (normal),
   or none (Hawkeyes: uniform ring, cone × `HAWKEYES_PELLET_CONE_SCALE`).
   The draw count depends only on weapon + Hawkeyes.
6. Resolve lag-comp rewind ticks
7. Collect lag-comp targets in **stable ascending id** order (once per shot)
8. Per pellet, in pattern order: wall-cap range; `hitscanPoses`
   closest-surface-wins; base damage (zone × distance falloff,
   `shotBaseDamage`) summed per victim
9. Per victim in **stable ascending id** order: skip dead / invulnerable
   (tracer-only hit, no damage) → damage roll → raid-scale (raid bots only)
   → `clampHitDamage` (≥ 1) → OneShot floor
10. `takeDamage` application (4.2) + teamfire mirror / Leech / hit-slow,
    per victim inside step 9

Melee reuses steps 6–10 without bloom or pellets (one ray), gated on the equipped weapon having
`melee` stats (pistol-whip, shotgun stock bash), with that weapon's
`melee.range` / `melee.cooldownMs` and a flat `melee.baseDamage` roll (no
falloff). A mag reload blocks melee; shell loading does not: `markMelee`
stops the loading (loaded shells stay) and starts a pump that ends at
`tick + swingTicks + pumpTicks` (Rapid Fire halves only the pump part). A
pump already in progress is left alone, and a bash never needs `chambered`.

## Hitscan and target order

- Geometry (`hitscanPoses`, hit volumes, wall raycast) is pure given origin,
  direction, range, and target poses.
- Target fill for lag-comp sampling must enumerate living players excluding
  the shooter in **stable ascending player/session id** order before pose
  expansion / scratch fill, so equidistant tie-breaks and any `limit`
  truncation are join-order independent.
- Closest surface wins; equal distance keeps the earlier (id-ordered) entry.

## Damage and RNG injection

- `damageFalloffMult(weapon, distance)` is pure (no RNG draws): 1 inside
  `falloff.fullDamageRange`, linear to `falloff.minMult` at
  `minDamageRange`, flat after. `minMult` is never 0, and a real hit is
  clamped to ≥ 1 damage, so there is no hard range cutoff.
- `rollDamageVariation(base, sample)` is pure (±5 spread, top 10% critical
  +5, neutral 0.5 → +0).
- `PlayerManager` defaults `damageRandom` / `spreadRandom` to the match
  `damage` / `spread` domain streams (`DETERMINISTIC_RANDOMNESS.md`).
- Spread (bloom, then pellet pattern) is sampled **before** any damage
  sample on each shot; each victim's damage roll is followed by one
  `scaleRaidBotDamage` **damage-domain** sample only when
  `shooter.isRaidBot` (10–20% of the roll). Arena bots draw like humans
  (bot-official keys-only PR 2, 2026-09-14).
- Tests may still inject a single `damageRandom` override (spread shares it
  when `spreadRandom` is omitted) for 4.4-style sequenced fixtures.

## Lag-comp inputs for later recording (#5 / #7.5)

`resolveLagCompWindow` / `buildLagCompTicks` stay pure functions. A replay
must supply these as recorded or fixed values rather than re-deriving them
from live pongs:

| Input | Role | Default when absent |
|---|---|---|
| `clientTick` (packet) | Preferred rewind stamp | Window maps missing/invalid → expectTick |
| `lastAppliedSnapshotTick` (packet) | Snap base candidate | Sanitized or fall back to `lastSnapTick` |
| `lastSnapTick` (server) | Latest emitted snapshot tick | Inferred from `simTick` grid |
| `pingEwmaMs` / `pingJitterMs` / `pingReady` | RTT window sizing | Unknown RTT (`LAG_COMP_UNKNOWN_RTT_MS`) and jitter 0 until ready |
| `volDropPct` | Widen pad under loss | 0 |
| `interpDelayMs` claim | May narrow/shift expect within [50, 150] ms | `LAG_COMP_INTERP_DEFAULT_MS` (75) |

Bots and the RTT-window-off path keep the non-window rewind behavior. No
recorder code lives in this epic.

## Projectile contract (hitscan-only)

The live game has no simulated projectile entities. Authoritative snapshots
and the game-over frozen snapshot always carry `projectiles: []`.
`SnapshotProjectile` (`id`, `x`, `y`, `z`) is a network placeholder and must
remain unpopulated.

If a future epic adds projectiles, the minimal sim state to account for in
4.7 / #9 is (documentation only here):

- stable `id`, owning player id;
- position and velocity per tick;
- expiry tick;
- collision against the existing move/collision solid surface;
- optional damage payload / weapon id.

No projectile simulation, entities, or endpoints are introduced by 4.4.

## Future checkpoint/hash inventory

Inventory only — not a serializer:

- every per-player weapon field listed under Authoritative weapon state;
- active ability weapon-path flags needed to reproduce the next shot
  (Rapid Fire window, Hawkeyes, OneShot, Glitch, Bullets, invulnerability);
- injected RNG stream position / seed (owned formally by 4.6);
- empty projectile list (always).

Exclude: AFK / participation timestamps, ping EWMA live evolution (supply as
recorded events instead), rewind-clamp counters, tracer/presentation state.

## Handoff to later epics

- **4.5** — treat `isBot` / bot damage scale (now raid-only) / bot rewind-tick path as
  recorded-state dependencies at the decision→input boundary.
- **4.6** — take `damageRandom`, the spread `rng` thread, and the per-shot
  draw order as the weapons RNG inventory (plus 4.3 `spawnRng` sequencing).
  Global policy and domain streams: `DETERMINISTIC_RANDOMNESS.md`.
- **4.7** — take the per-shot resolution order and stable target-list order
  as inputs to the global execution order.
- **#5+** — record per-tick shoot/melee packets, the lag-comp event inputs
  above, and the weapon state inventory for checkpoints/hashes.

## Production independence

After 4.4 the game still operates exactly as a live game. No replay file,
recorder, or viewer is required. Output is a reproducible
weapons-and-projectiles contract plus tests.
