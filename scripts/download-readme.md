# Doors community server

This folder is a Doors server you can run on your own computer. Friends join it from the game with an address and a password. Matches stay on your machine: no XP, coins, or cards, and the public server list never shows it.

- Play Doors: https://doorsfps.com/
- Docs and hosting guide: https://docs.doorsfps.com/play/hosting
- Source code: https://github.com/dtpietrzak/doorsfps-community-server

```text
doors/
  doors-server      (doors-server.exe on Windows)
  config.json
  TERMS.md
  maps/
```

## 1. Set a password

Open `config.json` in a text editor and set `password` to a secret you will share with friends. The server will not start while it is empty.

```json
"password": "pick-a-secret"
```

The same file sets the player cap, match length, map, and bots. Defaults are fine for a first try.

## 2. Start it

### macOS

The server is not code signed yet, so macOS blocks it the first time. Open Terminal, go to this folder, and run:

```sh
cd ~/Downloads/doors        # wherever you unzipped it
chmod +x doors-server
xattr -d com.apple.quarantine doors-server
./doors-server
```

- `chmod +x` makes the file runnable. The unzip step sometimes drops that.
- `xattr -d com.apple.quarantine` removes the "downloaded from the internet" flag that triggers *"doors-server cannot be opened because Apple cannot check it for malicious software"*. If it says `No such xattr`, the flag is already gone and you can skip it.

Already double-clicked it and got the warning? Open **System Settings → Privacy & Security**, scroll down, and click **Open Anyway** next to `doors-server`. Or run the `xattr` line above.

Double-clicking `doors-server` in Finder opens a window that closes when the server stops. Start it from Terminal as shown so you can see the console.

### Windows

Double-click `doors-server.exe`, or run it from PowerShell in this folder:

```powershell
.\doors-server.exe
```

If Windows SmartScreen says *"Windows protected your PC"*, click **More info**, then **Run anyway**. The first start may also show a Windows Firewall prompt: allow **Private networks** for LAN play, and **Public networks** if friends join over the internet.

### Linux

```sh
chmod +x doors-server
./doors-server
```

## 3. Accept the terms

On every start the server asks you to accept the [Community Server Terms of Use](TERMS.md) (`TERMS.md` in this folder). Type `accept` to go on.

To skip the prompt (a service, a container, a script), pass `--accept-terms` or set `DOORS_ACCEPT_TERMS=1`:

```sh
./doors-server --accept-terms
```

## 4. Let friends join

The startup banner prints your LAN address and, when it can look it up, your public IP. In the game, friends open **Find → Custom server** and enter:

- the IP address (LAN address on the same network, public IP from anywhere else)
- the port (`3000` unless you changed it)
- the password

The game uses **TCP** on that single port. For friends outside your home network, forward that TCP port on your router to this computer, and allow it through the computer's firewall. The banner links two port-forwarding guides.

## Options

```sh
./doors-server --port 3001 --name "Friday night"
```

| Flag | Meaning |
|---|---|
| `-p, --port <n>` | TCP port. Default `3000`. |
| `-n, --name <str>` | Name on the startup banner. |
| `--host <addr>` | Bind address. Default `0.0.0.0`. |
| `--accept-terms` | Accept `TERMS.md` without the prompt. |
| `-h, --help` | Print the built-in help. |

The server looks for `config.json` and `maps/` next to the program first, then in the folder you ran it from.

## Console

Type these into the server's terminal: `maps`, `map <name>`, `bots`, `bots add [n]`, `bots remove [n]`, `help`, `quit`.

## Custom maps

Export a `*.doors.json` file from the [map builder](https://map-builder.doorsfps.com/) and drop it in `maps/`. Restart the server to load it.

## Stopping

Type `quit` in the console, or press Ctrl+C.
