# Tick Association Contract

Local contract for replay epic **5.2**. Defines which input player P uses on
tick T. Creates no adapters, recording, checkpoint, or playback behavior.

Implementation: `tickAssociation.ts` + `Player.queueInput` / `Player.update`.
Handoff surface for recording: `Player.lastTickInputSelection()`.

## Policy truth table

| Case | Arrival / state | Selected at tick start | Edges |
|---|---|---|---|
| **Fresh** | new `sequence` (> prior applied) | that packet | armed once |
| **Hold** | same `sequence` re-queued before step | same packet | suppressed after prior consume |
| **Repeat missing** | no arrival; prior packet still latest | previous packet | suppressed |
| **Late / stale** | `sequence < lastSequence` at queue | **dropped** (never selected) | n/a |
| **Neutral** | never any input (`latestInput` null) | `null` → `stepMove` null path | none |
| **Dead** | `!alive` | look-only in `queueInput`; no move | n/a |
| **Connection issue** | sitting duck | forced `null` | none |

Multiple arrivals between ticks: **last-write-wins**. Mid-tick arrivals after
the `update` snapshot apply on the **next** tick only.

## Locked decisions

| Topic | Decision |
|---|---|
| Selection rule | Pin live behavior: last-wins + repeat-on-missing + drop-stale. No per-tick queue / first-wins. |
| Snapshot point | Top of `Player.update` (before weapon/reload/ability ticks and `stepMove`). |
| Tick stamp | At consumption (`update`), not arrival (`queueInput`). |
| `lastSequence` vs `appliedSequence` | Received vs stepped. Distinct by design (A1 ack). |
| Movement edges | `jump` / `meleeLunge` cleared via `consumeWireMovementEdges` only after successful start (preserves mid-air jump buffer). |
| Out-of-band actions | Reload / weapon / ability / shoot stay call-time stamped with current sim tick (Decision 7). Idempotent via existing handler guards. |
| Neutral vs empty keys | Neutral keeps `stepMove(null)` — not an all-false `MoveInput` — so crouch-edge / slide-drop semantics stay identical. Recording may materialize `neutralPlayerInput(yaw, pitch)`. |

## Edge suppression

- Wire movement edges: `consumeWireMovementEdges` after `stepMove`.
- Canonical edges (`fire`, `reload`, `weaponSelect`, `ability`): still out-of-band
  in 5.2. When 5.3/5.4 wire them into the per-tick snapshot, call
  `consumeCanonicalEdges` after apply so a held packet cannot double-fire.
- Out-of-band handlers already gate repeats (`canShoot`, reload/switch windows,
  ability locks).

## Handoffs

- **5.3 / 5.4** — Adapters must emit monotonic per-player `sequence` values.
  Do not rely on intra-tick arrival order beyond last-wins. Feed
  `PlayerManager.handleInput` / existing bot `stampAndInput` paths; do not
  bypass `queueInput`.
- **5.5** — Joins / leaves / loadout / match config are not tick inputs.
- **8.3** — Record `lastTickInputSelection()` each tick (one row per player).
  Never record `latestInput` (may already hold the next tick's packet).
- **11.2** — Replay feeds the recorded selected stream; same association
  outcomes without re-running adapters.
