# Canonical PlayerInput Contract

Local contract for replay epic **5.1**. Defines the authoritative per-tick
action vocabulary in `shared/sim/canonicalPlayerInput.ts`. Creates no tick
association, adapters, recording, or playback behavior.

## Authority and boundary

At a simulation tick, gameplay actions enter the sim only as
`CanonicalPlayerInput` (via existing `PlayerManager.handle*` entry points,
fed by pure projections in this module). Wire packets
(`PlayerInput`, `ShootPacket`, `MeleePacket`, `WeaponSwitchPacket`,
`AbilityPacket`) and bot `ReadyAction` remain live transport shapes —
adapters (5.3 / 5.4) convert them into the canonical type.

Out of scope here:

| Concern | Owner |
|---|---|
| Tick / sequence / missing / repeat / late policy | 5.2 |
| Keyboard / mouse / controller → canonical | 5.3 |
| Bot brain / `ReadyAction` → canonical | 5.4 |
| Skill loadout, joins/leaves, match config | 5.5 |
| Recording the stream | 8.3 |
| Player identity, match id | caller |

## Closed action inventory (held vs edge)

| Field | Kind | Maps to |
|---|---|---|
| `forward` / `backward` / `left` / `right` | held | `MoveInput` / wire `PlayerInput` |
| `sprint` / `crouch` | held | same |
| `yaw` / `pitch` | held | look; movement consumes yaw only |
| `jump` | edge | `MoveInput.jump` — cleared after `stepMove` |
| `meleeLunge` | edge | movement lunge — cleared after `stepMove` |
| `fire` (`kind: "shoot"`) | edge | `handleShoot` + aim snapshot |
| `fire` (`kind: "melee"`) | edge | `handleMelee` pistol-whip + aim snapshot |
| `reload` | edge | `handleReload` |
| `weaponSelect` | edge | `handleWeaponSwitch(id, weapon, tick)` |
| `ability` | edge | `handleAbility` |

`SkillLoadoutPacket` / `handleSkillLoadout` is **not** a per-tick action (→ 5.5).

## Apply order

Pinned as `CANONICAL_APPLY_ORDER`:

`input → weapon → reload → shoot → ability`

Same order as bot `APPLY_STEP_IDS`. `projectCanonicalHandlerCalls` emits
calls in this order. Shoot vs melee share the `shoot` slot (at most one
`fire` edge per tick).

## Normalization (`normalizeCanonicalInput`)

- Booleans coerced (`=== true` only).
- Non-finite yaw/pitch → `0`; yaw wrapped to `[-π, π]`; pitch clamped to
  `±(π/2 − 0.01)` (`CANONICAL_PITCH_LIMIT`), matching `handleShoot`.
- Unknown weapon id → `weaponSelect: null` (no-op; does **not** trigger
  `handleWeaponSwitch` cycle-on-invalid).
- Unknown or passive skill id → `ability: null` (matching
  `isSkillActivatable` / `canActivateAbility` passive reject).
- Fire origin must be three finite numbers or is stripped.
- Result is fully populated (no `undefined` holes) and JSON-serializable.

## Edge consumption

After a tick apply, `consumeCanonicalEdges` clears every edge field and
preserves held move/look. Double-consuming an edge (e.g. leaving `jump`
true across ticks) breaks determinism for every later epic — the
consumption table in `canonical_input_test.ts` is the gate.

## Dead / spectating

Canonical struct still carries look for AFK tracking. Whether movement is
applied is owned by `queueInput` / adapters (dead branch: track look, never
move). 5.1 does not change that policy.

## Handoffs

- **5.2** (done) — tick/sequence/hold policy lives in
  `server-community/players/tickAssociation.ts` +
  `TICK_ASSOCIATION.md`. Recording taps
  `Player.lastTickInputSelection()` (wire `PlayerInput` today; adapters
  will project to this canonical type).
- **5.3** (done) — human hardware → wire intents in
  `client/src/game/humanInputAdapter.ts`. Movement packets + discrete
  shoot/melee/reload/switch/ability intents are normalized there;
  fold into this canonical type via `normalizeCanonicalInput` /
  `canonicalFromWireParts` when recording/sim wiring lands. Monotonic
  per-connection `sequence` owned by the adapter.
- **5.4** call `normalizeCanonicalInput` (or `canonicalFromWireParts`)
  then `projectCanonicalHandlerCalls` / individual `toMoveInput` /
  `toFirePacket` shims — no sim-logic edits required. Emit monotonic
  per-player sequences; do not bypass `queueInput`.
- **5.5** (done) — non-input authoritative events in
  `shared/sim/authoritativeEvent.ts` + `AUTHORITATIVE_EVENTS.md`; must not
  overload this type.
- **8.3** records the selected-per-tick stream (one uniform vocabulary),
  never raw `latestInput`.
