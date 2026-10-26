# Community server

[Play Doors](https://doorsfps.com/) · [Docs](https://docs.doorsfps.com/) · [Hosting guide](https://docs.doorsfps.com/play/hosting)

`server-community` is the authoritative match process for Doors. Official hosts run this same program. You can run it yourself and invite friends: they get a door-capture match, a join password, guest names, and whatever maps you put on disk.

Matches here stay on this machine. They do not write XP, Skill, coins, or cards, and the public server list never shows them. Friends type the address and password you send them.

The zip linked from Extras in the game is a compiled copy of this package. This folder is everything the server needs: the sim and the rest of the game rules are in `shared/`, the built-in bot brain is in `bots/engine/`, and the bot protocol is in `bots/spec/`.

## Run from source

Install [Deno 2](https://deno.land/) and Node 24. Node is only used to install this package's npm dependencies.

From this folder:

```sh
npm ci
```

`deno.json` sets `"nodeModulesDir": "manual"`, so Deno will not fetch `socket.io`, `express`, or `ink` on its own. Run `npm ci` in this directory first.

Open `config.json` and set `password` to a secret you will share. The file in git has an empty password, and the process exits until that field is a non-empty string.

```sh
deno task dev
```

`deno task start` is the same command. A terminal gets a small console. A service or a pipe logs the address once and stays up until SIGINT or SIGTERM.

Every start asks you to accept the [Community Server Terms of Use](TERMS.md). Type `accept` to go on. With no terminal (a service, a container, a pipe), pass `--accept-terms` or set `DOORS_ACCEPT_TERMS=1`; without one of those, the process exits. The MIT License lets you change this code. The Terms decide whether you keep access to official DoorsFPS servers.

Flags go after `--`, so Deno forwards them to the program:

```sh
deno task dev -- --port 3001 --name "Friday night"
```

| Flag | Meaning |
|---|---|
| `-p, --port <n>` | TCP port. Default `3000`, or the `PORT` environment variable. |
| `--host <addr>` | Bind address. Default `0.0.0.0`, or `LISTEN_HOST`, then `HOST`. |
| `-n, --name <str>` | Name on the startup banner. Default `Doors Server`, or `SERVER_NAME`. |
| `--open` | Guest-name joins. This is the custom-server mode, and the default. |
| `--ranked` | Official admission, which requires authority join tokens. Leave this off for a server you host for friends. |
| `--accept-terms` | Accept [TERMS.md](TERMS.md) without the prompt. Same as `DOORS_ACCEPT_TERMS=1`. |
| `-h, --help` | Print the built-in help. |

Startup also reads `env-vars/.env.development` when that file exists. A variable already exported in the shell wins over the file. For a custom server, leave `SERVER_JOIN_MODE`, `RANKED_SERVER_ID`, and `DOORS_MODE_ID` unset. Setting one of them to `easy`, `medium`, or `hard` turns this process into an official runtime, and guest joins stop working. Leave `DOORS_BOT_THINK_RUNTIME` unset (or `pipeline-js`) so bots think inside this process.

## Run a downloaded build

Extras in the game links the current zip: `doors-server-win.zip`, `doors-server-mac-arm64.zip`, `doors-server-mac-x64.zip`, and `doors-server-linux.zip`. Each unpacks to:

```text
doors/
  doors-server      (doors-server.exe on Windows)
  config.json
  TERMS.md
  README.md         (run steps, incl. the macOS unsigned-binary workaround)
  maps/*.doors.json
```

Set `password` in that `config.json`, then run the binary from that folder. On macOS or Linux, `chmod +x doors-server` first. The binary is not code signed yet, so on macOS also run `xattr -d com.apple.quarantine doors-server` (the packaged `README.md` covers this and the Windows SmartScreen prompt; its source is `scripts/download-readme.md`). The binary looks for `config.json` and `maps/` next to itself, then in the current directory.

To produce that zip from source, after `npm ci`:

```sh
deno task compile
```

That writes `dist/doors-server` for the machine you are on, plus a zip. `deno task compile:all` cross-compiles macOS (arm64 and x64), Windows, and Linux, then packages each one.

## config.json

The first readable file wins:

1. `./config.json`
2. `config.json` next to the executable
3. `./server-community/config.json`
4. `./server/config.json`

Unknown keys are ignored. Missing keys use the defaults below. A file that is not valid JSON is skipped, and the next candidate is tried.

```json
{
  "maxPlayers": 8,
  "matchDurationSeconds": 900,
  "password": "pick-a-secret",
  "map": "Pillars",
  "mapRotation": ["Pillars", "Crossroads", "Hourglass"],
  "bots": {
    "autofillBots": 4,
    "difficulty": "easy",
    "noBotsOnEmptyServer": true,
    "brain": "builtin"
  }
}
```

| Field | Default | What it does |
|---|---|---|
| `password` | none | Required on a custom server. Trimmed, and cut at 64 characters. Friends type it with the address. Startup confirms that it is set and does not print it. Official runtimes ignore it. |
| `maxPlayers` | 8 | Cap on humans plus bots, from 1 to 64. A join past the cap is refused. Bots stop filling at the cap. |
| `matchDurationSeconds` | 900 | Time limit in seconds, from 30 to 10800 (3 hours). At the limit the team with more door captures wins, and a tie is a draw. Reaching the score win still ends the match early. |
| `map` | random | First map. Accepts the display name, the file stem, or the filename (`Pillars` or `Pillars.doors.json`). An unknown name logs a warning and a random loaded map is used. |
| `mapRotation` | every discovered map | Allow-list of map **display names** (`DoorsMap.name`), matched without case. Unknown names are logged and skipped. An empty list loads nothing, and the process exits. |
| `bots.autofillBots` | 4 | Target roster size, humans and bots together. As people join, bots leave so the roster stays near this number. `0` disables fill. |
| `bots.difficulty` | `easy` | `easy`, `medium`, or `hard`. New spawns pick this up. Bots already on the map keep the tier they spawned with. |
| `bots.noBotsOnEmptyServer` | `true` | With nobody connected, every bot is removed. `false` keeps them in the match on an empty server. |
| `bots.brain` | `builtin` | `"builtin"` thinks inside this process. A command array spawns that program for fill and balance bots. See [Your own fill bots](#your-own-fill-bots). |

## How friends join

The banner prints your LAN addresses and, when the lookup works, a public IPv4. Community servers stay off the in-game server list.

In the game, friends open **Find → Custom server** and enter:

- the IP (a LAN address on the same network, the public IP from anywhere else)
- the port (`3000` unless you changed it)
- the password

The game uses **TCP** on that single port: HTTP plus Socket.IO. Friends across the internet need your router to forward that TCP port to this computer, and the machine's firewall has to allow it. The banner prints two port-forwarding guides when the server starts. Leave `TLS_CERT` and `TLS_KEY` unset. With both set, this process terminates TLS itself. That path is for official hosts. WebTransport is only started there.

Everyone joins with a guest display name. There is no account check on this server.

`GET http://127.0.0.1:3000/api/status` returns JSON while the process is up. `GET /api/map` returns the current map. Change the port in those URLs if you bound a different one.

## Maps

A map file is `*.doors.json`, format version 1 or 2 (`shared/world/doorsMapFormat.ts`). The [map builder](https://map-builder.doorsfps.com/) exports that file. A file you add here is only loaded by servers that have it on disk.

Discovery uses the first directory that actually contains maps:

1. `./maps`
2. `maps/` next to the executable
3. `./server-community/maps`
4. `./server/maps`

Two layouts work:

- **Flat.** `*.doors.json` files sitting directly in that folder. The downloadable zip is flat. When any flat file is present, the pool folders below are left alone.
- **Pools**, which is how this folder is laid out. `maps/competitive/` is loaded. Campaign maps ship with the game client; this server never loads them. `maps/README.md` has the pool list.

A custom arena saved as `maps/MyArena.doors.json` therefore **replaces** the pooled rotation, because the flat files win. To add a map and keep the shipped arenas, put the file in `maps/competitive/` when you run from source. On a binary, copy it into the flat `maps/` folder next to the arenas you want to keep.

The catalog is read once at boot. Adding a file means restarting. `map <name>` in the console switches among maps already loaded.

Put arena names (`Pillars`, `Courtyard`, and the rest of `maps/competitive/`) in `map` and `mapRotation` for a normal rotation.

A custom server plays every loaded map as a door-capture arena.

## Console

With a terminal on stdin:

| Command | Effect |
|---|---|
| `maps` | List loaded maps. The active one is marked. |
| `map <name>` | Switch map. A live match ends as a draw. A switch during intermission loads the new map and starts clean. |
| `bots` | Fill status and the live bots. |
| `bots add [n]` | Add n bots (default 1). With `noBotsOnEmptyServer` and no human connected, the server stays empty. |
| `bots remove [n]` | Remove n bots (default 1). |
| `help` | Show these commands. |
| `quit` | Stop the server. |

Autofill still aims at `bots.autofillBots` after you add or remove bots by hand.

## How a match runs

This process owns the match. The game client predicts movement and then reconciles to the server. Hits, doors, score, and who is alive are decided here.

`runtime/GameLoop.ts` steps at 60 Hz (`TICK_HZ` in `shared/sim/game.ts`). The sim uses that fixed step. After an overrun the clock may catch up at most three steps, then drop the surplus so the process keeps serving the network.

Each tick, in order:

1. Apply inputs that are due. That is held human input, and bot actions whose think deadline has arrived.
2. Step movement, combat, doors, and score.
3. Send a pose snapshot about 20 times a second, and send shots, damage, kills, score, and joins on the reliable channel.
4. Ask the bot brain about the pawns whose think slot landed on this tick. The tick continues either way. A late answer is discarded, and that bot keeps the keys it already had.

Human clients send input about 20 times a second over Socket.IO. A shot is checked against the pose the shooter was aiming at: the server rewinds to the tick stamped on the shot, inside a capped delay. `docs/game/networking.md` is the longer version of that path.

The door cycle lives in `shared/sim/game.ts`. Doors stay open for 30 seconds, and a capture in that window scores. They then close for 15 seconds. While they are closed, up to three grey agents can spawn. After the last agent is down, the doors power up for 3 seconds and open again. The first team to **21** captures wins, and it has to lead by **2**. If the clock in `matchDurationSeconds` runs out first, the team with more captures wins, and a tie is a draw. A short intermission follows. Players then vote for the next map on the game-over screen. A majority wins the vote. A tie, or nobody voting, picks at random from this server's vote list.

## Where the code lives

`main.ts` is the only entry point, and it is what `deno compile` builds. `config.json` sits next to it. The rest of the package is folders:

| Folder | Job |
|---|---|
| `host/` | Load `config.json`, TLS material, the startup banner, and the console. |
| `runtime/` | `GameServer` and `GameLoop`, tick timing, and the official session and release-lock checks. Those checks sit idle on a custom server. |
| `players/` | Movement, weapons, abilities, and the match lifecycle. |
| `world/` | Read `*.doors.json`, build collision, and pick spawns. |
| `combat/` | Hitscan, aim spread, and lag-compensated shots. |
| `transport/` | The Socket.IO hub, optional WebTransport, the input rate limit, and the pose heartbeat. |
| `protocol/network.ts` | Packet shapes and tick constants for this process. The gameplay numbers are defined in `shared/sim/game.ts` and re-exported here. |
| `bots/` | Autofill (`botN`), the balance filler, grey agents, and the brain slots. |
| `bots/engine/` | The built-in bot brain. See [Change the built-in bots](#change-the-built-in-bots). |
| `bots/spec/` | The bot protocol, its types and codec, and an example brain. |
| `bots/conformance/` | The check to run against your own brain. |
| `shared/` | Game rules the server and the game client both run: `sim/`, `world/`, `net/`, `replay/`, `math/`, and the rest. |
| `replay/` | Match recording. A custom server has no authority store, so recording never opens. |
| `heatmaps/` | Walk samples taken during the match. Official hosts upload the batch. On a custom server the upload is skipped and the samples are dropped at the end of the match. |
| `authority/` | Join-token checks and the HTTP client official hosts use for match reports. A custom server loads no signing keys and uses `NoopAuthorityAdapter`, which writes nothing. |
| `maps/` | Shipped arenas. See [Maps](#maps). |

`server-game` is the official host agent that spawns this program on the fleet. You do not run it for a custom server. `server-authority` is the account and rankings API. A custom server never calls it.

## Your own fill bots

With `bots.brain` omitted or set to `"builtin"`, fill bots, the balance filler, and grey agents all think inside this process. That is the setup to use for a normal server.

To drive fill and balance from your own program, set `brain` to a command array. The first string is the executable. The rest are arguments.

```json
"brain": ["python3", "bots/spec/examples/walk_to_door.py"]
```

The server spawns it with stdin and stdout piped and speaks bot protocol 5: hello, load the map, synchronize the roster, then a think batch whenever those pawns are due. Each batch is one world snapshot plus the pawns scheduled for this tick (each pawn is due 20 times a second). The reply is one action per requested pawn, applied 150 ms later. A late, garbled, or mismatched reply is dropped, and those pawns keep their previous keys. If the child exits, the server starts it again, waiting 1 second and doubling up to 30 seconds. The 60 Hz sim never waits for it.

Grey agents stay on the built-in brain. The brain never writes health, position, or score.

- [`bots/spec/README.md`](bots/spec/README.md) is the protocol: messages, schedule, every field, and the byte layout.
- `bots/spec/examples/walk_to_door.py` is a complete brain in about 150 lines of standard-library Python. It holds W toward the enemy door.
- `deno run -A bots/conformance/check.ts -- <your command>` runs a session against your brain and lists every reply the server would drop.

## Change the built-in bots

`bots/engine/` is the brain behind `"builtin"`: perception, pathing, aim, trigger discipline, door play, skills. It is the same TypeScript the server imports, so edit it and restart `deno task dev`, or rebuild the binary with `deno task compile`. The personalities (reaction times, aim, aggression) are the configs in `bots/spec/src/config.ts`. `COMMUNITY_BOT_CONFIG` is what fill bots run.

## Develop

```sh
npm ci
deno task types
deno task lint
deno task check:imports
deno task test
```

`deno task check:imports` fails if any file imports something outside this folder, so the package keeps building on its own. To run one test file:

```sh
deno test -A --unstable-net --node-modules-dir=manual bots/commandBrain_test.ts
```

Change shared constants in one place: `shared/sim/game.ts` for the tick, doors, and score, `shared/sim/weapons.ts` for guns, and `shared/sim/skills.ts` for abilities.

## Contributing

This repository is published from the game's main repository on every server release, one commit per release. Pull requests are welcome: a merged change is carried over by hand and appears in the next release commit, so it will not show up as a merge here.
