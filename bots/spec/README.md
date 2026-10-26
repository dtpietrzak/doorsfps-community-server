# Bot protocol

How a Doors server talks to a bot brain. Version **5**.

The server is the authority. It spawns pawns, sends the brain the world on a fixed schedule, and applies the keys that come back. The brain never writes health, position, or score. Any language that can read stdin and write stdout can be a brain.

This folder is also a small npm package (`@doors/bot-spec`) with the TypeScript types, the schedule constants, and an encoder/decoder for every frame:

| File | What |
| --- | --- |
| `src/model/index.ts` | `ThinkFrame`, `ThinkBatchInput`, `ReadyAction`, `BotDefinition`, `PlayerSnapshot`, `BotMapDefinition` |
| `src/protocol/pipeline.ts` | `encodeBotThinkPipelineRequestFrame` and the other three codec functions, `BOT_THINK_PIPELINE_PROTOCOL_VERSION` |
| `src/schedule.ts` | `BOT_TICK_HZ`, `SIM_TICKS_PER_BOT_TICK`, `THINK_BUFFER_BOT_TICKS`, `THINK_BUFFER_SIM_TICKS` |
| `src/config.ts` | `BotBrainConfig` and the built-in configs (community, balance, grey agents, raid) |
| `examples/walk_to_door.py` | A complete brain in Python, standard library only |

`bots/conformance/check.ts` in the server package runs a session against your brain and reports every reply the server would drop. See [Check your brain](#check-your-brain).

## Turn it on

In the server's `config.json`:

```json
{
  "bots": {
    "autofillBots": 8,
    "brain": ["python3", "my_brain.py"]
  }
}
```

`brain` is `"builtin"` (the default) or a command array: the executable, then its arguments. Relative paths resolve against the server's working directory. The server spawns that process with stdin and stdout piped. Its stderr goes to the server log.

## Who thinks

The server picks a brain for each pawn when it spawns and keeps it for that pawn's life.

| Pawn | Role | `brain: "builtin"` | `brain` is a command |
| --- | --- | --- | --- |
| Autofill `bot1`, `bot2`, … | `fill` | built-in | your command |
| Balance filler `bot` | `balance` | built-in | your command |
| Grey agents (spawn while doors are closed) | `agent` | built-in | built-in |
| Raid waves | `raid` | built-in | built-in |
| Pool pawns (spawned by a host operator's identity pool) | `pool` | built-in | built-in, or the operator's pool brain |

Your brain is only ever asked about `fill` and `balance` pawns. Agents, raid waves, humans, and every other body still appear in the world snapshot, because they are on the map. Renaming pawns is the server's job, not the brain's.

## Session

1. **Hello.** The server sends its protocol version. The brain answers with its own. A mismatch ends the session, so answer `5` or send a non-recoverable error.
2. **Load map.** The map geometry. Sent at start, after every restart, and when the map changes (`revision` differs). Acknowledge it.
3. **Synchronize.** The full roster of pawns this brain owns. Sent at start, after every restart, and whenever the roster changes (spawn, despawn, respawn). Acknowledge it.
4. **Think batch.** The hot path. One world snapshot, the tick its actions apply on, and the pawns due this tick. Answer with one decision per requested pawn.
5. **Shutdown.** Acknowledge it and exit.

Requests carry a `requestId`. Echo it on the reply. The server writes requests in order and reads replies in order, so answer each one before reading the next.

The server never sends anything else to a command brain. If an unknown kind ever arrives, reply with a recoverable error.

## Schedule

| Clock | Rule |
| --- | --- |
| Sim | 60 Hz. Each tick: apply due actions, step the sim, then send think batches. |
| Bot period | 20 Hz. Each pawn is due once every 3 sim ticks, so a batch holds about a third of your pawns. |
| Deadline | `applyTick` is 3 bot ticks (9 sim ticks, 150 ms) after the batch's bot tick. A reply that arrives on or after `applyTick` is dropped. |
| Late or bad reply | Dropped whole. The pawn keeps holding its previous keys and look. The sim never waits for a brain. |
| Null action | Accepted. Same as a late reply for that one pawn: keep holding. |
| Restart | If the brain exits or sends a non-recoverable error, the server starts it again after 1 s, doubling up to 30 s. Its pawns hold until hello, load map, and synchronize have been sent again. |

A reply must echo the batch exactly: the same `tick`, `applyTick`, and `mapRevision`, and one decision per requested pawn, in request order, with the same `botId` and `spawnedAtTick`. Anything else drops the whole reply, including a decision for a pawn that was not requested.

`spawnedAtTick` changes when a pawn respawns. Echo the value in the batch, not one you remembered.

## What a brain sees

Every think batch carries the whole world, not just what your pawns can see. Line of sight is the brain's job. This is a bot interface, not an anti-cheat boundary. The one pre-resolved field is Glitch visibility.

- Sim tick, sim delta, map revision, and whether the match is over.
- Doors: open or closed, and the tick they last changed.
- Both team scores.
- Every body: id, kind (`human`, `bot`, `agent`; raid and pool pawns are `bot`), team, alive, health, score, spawn tick, position, velocity, yaw, pitch, crouch, on ground, active weapon (id, magazine, spare clips, reloading, last shot tick), optional carried weapons, skills (id, equipped, charge, active until, can activate), optional Glitch visibility, optional sprint stamina, optional move yaw, and whether the body counts toward the match.

Coordinates are world units on the X/Z floor plane; Y is up. Yaw is radians. Facing yaw `θ` looks along `(-sin θ, -cos θ)` on X/Z, so the yaw toward a point `(dx, dz)` away is `atan2(-dx, -dz)`.

## What a brain sends

Per requested pawn, for the bot period that starts at `applyTick`:

- Keys: forward, back, left, right, jump, sprint, crouch.
- Look: yaw and pitch. Optionally one look sample per sim tick of the period (at most 3); the last sample must equal the yaw and pitch. Without samples the server eases the look across the period.
- Buttons, all optional: shoot, reload, weapon slot, ability id.

The server stamps the input sequence and the tick the brain observed, checks the action, and applies it like a held keyboard. A pawn with no input (`input` absent but the action present) keeps its keys and only presses the buttons.

## Wire format

Every frame is a little-endian `u32` payload length, then the payload. The payload is an 8-byte header and a body.

| Header byte | Value |
| --- | --- |
| 0–1 | `"BP"` (`0x42 0x50`) |
| 2 | wire version `1` |
| 3 | message kind |
| 4–7 | `requestId`, `u32` |

Primitives are little-endian. `bool` is one byte, `0` or `1`. `string` is a `u16` byte length and that many UTF-8 bytes. `point` is two `f64`: x, z. `null i32` is `-2147483648`. A frame is at most 16 MiB. A frame with trailing bytes is invalid.

### Server → brain

| Kind | Message | Body |
| --- | --- | --- |
| 17 | hello | `u16` protocol version, `string` server name |
| 18 | load map | map (below) |
| 19 | synchronize | `u32` count, then per pawn: `string` id, `u8` role (0 fill, 1 balance, 2 pool, 3 agent, 4 raid), `string` profile, `u32` random seed, `bool` has profile data, [`string` profile data] |
| 20 | think batch | frame (below), `u32` applyTick, `u32` count, then per pawn: `string` botId, `u32` spawnedAtTick |
| 21 | shutdown | empty |

`profile` names a built-in personality (`community`, `balance-bot`, …) and `randomSeed` changes per life. A brain may ignore both. `profileData` is opaque bytes from whoever spawned the pawn; fill and balance pawns have none.

**Map:** `string` id, `string` revision, `u16` map format version, `f64` minX, maxX, minZ, maxZ, side A, side B, `u32` wall count and walls, `u32` corner count and `point`s, then hints: nudges, camps, sprints, spawns, stuck.

- Side: `u8` door edge (0 south, 1 east, 2 north, 3 west), `f64` door half width, `f64` spawn radius. The door is centred on that edge of the bounds. South runs from (minX, minZ) to (maxX, minZ), east from (maxX, minZ) to (maxX, maxZ), north from (maxX, maxZ) to (minX, maxZ), west from (minX, maxZ) to (minX, minZ).
- Wall: `string` id, `f64` ax, az, bx, bz, `u8` kind (0 full, 1 half, 2 float).
- Hints, each list prefixed with a `u32` count, each hint starting with `string` id and `u8` team (0 A, 1 B): nudge = `u32` count + `point`s; camp = `point`; sprint = `u32` count + `point`s (polygon); spawn = start `point`, end `point`; stuck = centre `point`, `f64` radius, `f64` yaw.

A brain that only needs the doors can stop reading after side B.

**Frame:** `u32` tick, `f64` sim delta, `string` map revision, `bool` doors open, `null i32` door change tick, `i32` team A score, `i32` team B score, `u32` body count and bodies, `bool` match over.

**Body:** `string` id, `u8` kind (0 human, 1 bot, 2 agent), `u8` team (0 A, 1 B), `u8` flags, `u8` flags2, `f64` health, `i32` score, `u32` spawned at tick, `f64` x, y, z, velocity x, y, z, yaw, pitch, then the optional fields in this order:

| Present when | Field |
| --- | --- |
| flags & 8 | `f64` sprint stamina |
| flags & 16 and not flags2 & 2 | `f64` move yaw (flags2 & 2 means it is null) |
| flags & 128 | `u16` count, then per weapon: `u16` id, `i32` magazine, `i32` spare clips |
| flags2 & 1 | `u8` Glitch visibility (0 hidden, 1 revealed, 2 inactive) |

then always: active weapon (`u16` id, `i32` magazine, `i32` spare clips, `bool` reloading, `f64` last shot tick) and `u16` skill count, per skill: `string` id, `bool` equipped, `f64` charge, `null i32` active until tick, `u8` can activate (0 unknown, 1 no, 2 yes).

Other flag bits: flags & 1 alive, & 2 crouch, & 4 on ground, & 32 match-player bit present (value in flags2 & 4), & 64 unlimited-ammo bit present (value in flags2 & 8).

### Brain → server

| Kind | Message | Body |
| --- | --- | --- |
| 81 | hello | `u16` protocol version, `string` brain name |
| 82 | acknowledgement | `bool` accepted |
| 83 | think result | `u32` tick, `u32` applyTick, `string` map revision, `u32` count, then per pawn: `string` botId, `u32` spawnedAtTick, action |
| 84 | error | `string` code, `string` message, `bool` recoverable |

**Action:** `u8` flags. `0` is a null action (hold) and ends the action. Otherwise bit 1 is set, and:

| Flag | Meaning |
| --- | --- |
| 2 | input follows: `u8` keys (1 forward, 2 back, 4 left, 8 right, 16 jump, 32 sprint, 64 crouch), `f64` yaw, `f64` pitch, `u8` look sample count, then per sample `f64` yaw, `f64` pitch |
| 4 | shoot is set; 8 is its value |
| 16 | reload is set; 32 is its value |
| 64 | `u16` weapon slot follows (after the input) |
| 128 | `string` ability id follows (after the weapon slot) |

Kinds 22–26 and 85–86 are reserved. A server never sends them to a `bots.brain` command.

## Check your brain

From the server folder:

```sh
deno run -A bots/conformance/check.ts -- python3 my_brain.py
```

It runs hello, Courtyard's map, a roster of three fill pawns and a balance pawn, and 40 bot periods of think batches with a human and a grey agent in the world. Partway through, a pawn respawns. It fails on a wrong hello, a missing acknowledgement, a reply that does not echo its batch, a decision for a pawn that was not asked about, an illegal action, more than a tenth of replies slower than 150 ms, or no answer to shutdown. `examples/walk_to_door.py` passes it.

## Built-in brain

`bots/engine/` is the brain the server runs for `"builtin"` and for grey agents and raid waves. It is ordinary TypeScript in this package. Change it and restart the server, or rebuild the binary with `deno task compile`. Its personalities live in `src/config.ts`.
