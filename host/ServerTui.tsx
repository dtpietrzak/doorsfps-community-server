/** Ink-based interactive host console (commands, status, log). */
import { useCallback, useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import type { GameServer } from "../runtime/GameServer.ts";
import { volatileDropPct } from "../transport/poseHeartbeat.ts";
import { SERVER_VERSION } from "./version.ts";
import type { MapBundle } from "../world/loadMap.ts";
import { loadMapBundle } from "../world/loadMap.ts";

export type MapCandidate = {
  path: string;
  name: string;
  stem: string;
};

export type HostInfo = {
  local: string[];
  publicIp: string | null;
  port: number;
};

type LogLine = {
  id: number;
  text: string;
  tone?: "info" | "ok" | "warn" | "err";
};

const MAX_LOG = 12;

function fileNameFromPath(path: string): string {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return idx >= 0 ? path.slice(idx + 1) : path;
}

/** Resolve a CLI map name against candidates (case-insensitive). */
export function findMapCandidate(
  candidates: MapCandidate[],
  query: string,
): MapCandidate | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;

  const exactName = candidates.find((c) => c.name.toLowerCase() === q);
  if (exactName) return exactName;

  const exactStem = candidates.find((c) => c.stem.toLowerCase() === q);
  if (exactStem) return exactStem;

  const exactFile = candidates.find(
    (c) => fileNameFromPath(c.path).toLowerCase() === q,
  );
  if (exactFile) return exactFile;

  const partial = candidates.filter(
    (c) => c.name.toLowerCase().includes(q) || c.stem.toLowerCase().includes(q),
  );
  if (partial.length === 1) return partial[0]!;
  return null;
}

type Props = {
  gameServer: GameServer;
  maps: MapCandidate[];
  host: HostInfo;
  initialMapPath?: string;
};

export function ServerTui({ gameServer, maps, host, initialMapPath }: Props) {
  const { exit } = useApp();
  const [input, setInput] = useState("");
  const inputRef = useRef("");
  const [mapName, setMapName] = useState(gameServer.getMapName());
  const [mapPath, setMapPath] = useState(
    gameServer.getMapPath() ?? initialMapPath ?? "",
  );
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [, setLogId] = useState(1);
  const [logs, setLogs] = useState<LogLine[]>(() => [
    { id: 0, text: `Server online · ${gameServer.getMapName()}`, tone: "ok" },
  ]);
  const [players, setPlayers] = useState(gameServer.getPlayerCount());
  const [scores, setScores] = useState(gameServer.getScores());
  const [matchOver, setMatchOver] = useState(gameServer.isMatchOver());
  /** Compact tick load line for the status header (avg + hottest phase). */
  const [tickLine, setTickLine] = useState<string | null>(null);
  /** True when avg or peak tick load is in the warn/danger band. */
  const [tickHot, setTickHot] = useState(false);
  /** Pose-stream mirror (volatile drops / write buffer) for host uplink diagnosis. */
  const [netMirrorLine, setNetMirrorLine] = useState<string | null>(null);
  /** True when host is intentionally dropping volatile poses under backpressure. */
  const [netMirrorHot, setNetMirrorHot] = useState(false);

  const pushLog = useCallback((text: string, tone?: LogLine["tone"]) => {
    setLogId((n) => {
      const id = n;
      setLogs((prev) => {
        const next = [...prev, { id, text, tone }];
        return next.length > MAX_LOG ? next.slice(-MAX_LOG) : next;
      });
      return n + 1;
    });
  }, []);

  // Live player / score / tick-load poll (game loop is authoritative elsewhere).
  useEffect(() => {
    const id = setInterval(() => {
      const nextPlayers = gameServer.getPlayerCount();
      const nextScores = gameServer.getScores();
      const nextMatchOver = gameServer.isMatchOver();
      const nextMap = gameServer.getMapName();
      setPlayers((p) => (p === nextPlayers ? p : nextPlayers));
      setScores((s) =>
        s.A === nextScores.A && s.B === nextScores.B ? s : nextScores
      );
      setMatchOver((m) => (m === nextMatchOver ? m : nextMatchOver));
      setMapName((n) => (n === nextMap ? n : nextMap));

      const timing = gameServer.getTickTiming();
      if (!timing) {
        setTickLine((prev) => (prev === null ? prev : null));
        setTickHot((h) => (h ? false : h));
      } else {
        const avgPct = Math.round(timing.avgLoad * 100);
        const peakPct = Math.round(timing.peakLoad * 100);
        let hottest = "";
        if (timing.phases) {
          let bestName = "";
          let bestPeak = -1;
          for (const name of ["bots", "sim", "scores", "emit"] as const) {
            const p = timing.phases[name];
            if (p && p.peakMs > bestPeak) {
              bestPeak = p.peakMs;
              bestName = name;
            }
          }
          if (bestName) {
            hottest = ` · hot ${bestName} ${bestPeak.toFixed(1)}ms`;
          }
        }
        const nextLine = `tick avg ${
          timing.avgMs.toFixed(1)
        }ms (${avgPct}%) · peak ${
          timing.peakMs.toFixed(1)
        }ms (${peakPct}%)${hottest}`;
        setTickLine((prev) => (prev === nextLine ? prev : nextLine));
        const hot = timing.avgLoad >= 0.7 || timing.peakLoad >= 0.9;
        setTickHot((prev) => (prev === hot ? prev : hot));
      }

      // Host uplink / pose-stream pressure (not player Wi‑Fi).
      const mirror = gameServer.getNetMirrorSummary();
      if (mirror.clients <= 0) {
        setNetMirrorLine((prev) => (prev === null ? prev : null));
        setNetMirrorHot((h) => (h ? false : h));
      } else {
        const dropPct = volatileDropPct(
          mirror.volatileSent,
          mirror.volatileDrops,
        );
        const nextMirror =
          `pose volDrop ${dropPct.toFixed(0)}% (${mirror.volatileDrops}/${
            mirror.volatileSent + mirror.volatileDrops
          })` +
          ` · peakWb ${mirror.peakWriteBuffer}` +
          ` · hb ${mirror.reliableHeartbeats}` +
          ` · clientsWithDrops ${mirror.clientsWithDrops}/${mirror.clients}`;
        setNetMirrorLine((prev) => (prev === nextMirror ? prev : nextMirror));
        const mirrorHot = dropPct >= 10 ||
          mirror.peakWriteBuffer >= 8 ||
          mirror.clientsWithDrops >= 2;
        setNetMirrorHot((prev) => (prev === mirrorHot ? prev : mirrorHot));
      }
    }, 500);
    return () => clearInterval(id);
  }, [gameServer]);

  const changeMap = useCallback(
    async (query: string) => {
      if (busyRef.current) {
        pushLog("Already changing map…", "warn");
        return;
      }
      const match = findMapCandidate(maps, query);
      if (!match) {
        pushLog(`Unknown map: "${query.trim()}"`, "err");
        pushLog("Type `maps` to list available maps.", "info");
        return;
      }
      if (
        match.name === gameServer.getMapName() &&
        match.path === gameServer.getMapPath()
      ) {
        pushLog(`Already on map "${match.name}".`, "warn");
        return;
      }

      busyRef.current = true;
      setBusy(true);
      let bundle: MapBundle;
      try {
        bundle = await loadMapBundle(match.path);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        pushLog(`Failed to load map: ${message}`, "err");
        busyRef.current = false;
        setBusy(false);
        return;
      }

      try {
        const result = gameServer.changeMap({
          map: bundle.map,
          collision: bundle.collision,
          mapPath: bundle.path,
        });
        setMapName(bundle.map.name);
        setMapPath(bundle.path);
        setScores(result.scores);
        setMatchOver(false);

        if (result.endedAsDraw) {
          const prev = result.previousScores;
          pushLog(
            `Match draw${
              prev ? ` ${prev.A}–${prev.B}` : ""
            } · loading ${bundle.map.name}`,
            "warn",
          );
        } else {
          pushLog(`Loading map "${bundle.map.name}"…`, "ok");
        }
        pushLog(`Map file: ${bundle.path}`, "info");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        pushLog(`Map change failed: ${message}`, "err");
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [gameServer, maps, pushLog],
  );

  const runCommand = useCallback(
    async (raw: string) => {
      const trimmed = raw.trim();
      if (!trimmed) return;

      pushLog(`› ${trimmed}`, "info");

      const parts = trimmed.split(/\s+/);
      const cmd = parts[0]!.toLowerCase();
      const rest = parts.slice(1).join(" ");

      if (cmd === "quit" || cmd === "exit" || cmd === "q") {
        pushLog("Shutting down…", "warn");
        exit();
        return;
      }
      if (cmd === "help" || cmd === "?") {
        pushLog("map <name>     — change map (mid-game → draw)", "info");
        pushLog("maps           — list available maps", "info");
        pushLog("bots           — list bots / show fill status", "info");
        pushLog("bots add [n]   — add n bots (default 1)", "info");
        pushLog("bots remove [n]— remove n bots (default 1)", "info");
        pushLog("help           — show this help", "info");
        pushLog("quit           — stop the server", "info");
        return;
      }
      if (cmd === "maps" || cmd === "list") {
        for (const m of maps) {
          const active = m.name === gameServer.getMapName() ? " ← active" : "";
          pushLog(`· ${m.name}  [${m.stem}]${active}`, "info");
        }
        return;
      }
      if (cmd === "map") {
        if (!rest) {
          pushLog("Usage: map <map_name>", "warn");
          for (const m of maps) {
            const active = m.name === gameServer.getMapName()
              ? " ← active"
              : "";
            pushLog(`· ${m.name}${active}`, "info");
          }
          return;
        }
        await changeMap(rest);
        return;
      }
      if (cmd === "bots" || cmd === "bot") {
        const sub = (parts[1] ?? "list").toLowerCase();
        const parseCount = (raw: string | undefined, fallback = 1): number => {
          if (raw === undefined) return fallback;
          const n = Math.floor(Number(raw));
          return Number.isFinite(n) && n > 0 ? n : fallback;
        };

        if (parts.length === 1 || sub === "list" || sub === "status") {
          const bots = gameServer.listBots();
          const humans = gameServer.getHumanCount();
          pushLog(
            `Humans ${humans} · bots ${bots.length} · total ${gameServer.getPlayerCount()}/${gameServer.getMaxPlayers()}`,
            "info",
          );
          pushLog(
            `Auto-fill keeps ${gameServer.getAutofillBots()} total while any human is connected (0 humans → 0 bots).`,
            "info",
          );
          pushLog(
            `Difficulty: ${gameServer.getBotDifficulty()} (new spawns use this brain).`,
            "info",
          );
          if (bots.length === 0) {
            pushLog("No bots in the match.", "info");
          } else {
            for (const b of bots) {
              pushLog(`· ${b.name}  team ${b.team}  [${b.brainId}]`, "info");
            }
          }
          return;
        }
        if (sub === "add" || sub === "+") {
          const n = parseCount(parts[2], 1);
          const added = gameServer.addBots(n);
          pushLog(
            added > 0
              ? `Added ${added} bot${
                added === 1 ? "" : "s"
              } (${gameServer.getBotCount()} total).`
              : "No bots added (need ≥1 human; empty server stays empty).",
            added > 0 ? "ok" : "warn",
          );
          return;
        }
        if (sub === "remove" || sub === "rm" || sub === "-") {
          const n = parseCount(parts[2], 1);
          const removed = gameServer.removeBots(n);
          pushLog(
            removed > 0
              ? `Removed ${removed} bot${
                removed === 1 ? "" : "s"
              } (${gameServer.getBotCount()} left).`
              : "No bots to remove.",
            removed > 0 ? "ok" : "warn",
          );
          return;
        }
        pushLog("Usage: bots | bots add [n] | bots remove [n]", "warn");
        return;
      }

      pushLog(`Unknown command: "${cmd}". Type help.`, "err");
    },
    [changeMap, exit, gameServer, maps, pushLog],
  );

  const submitLine = useCallback(() => {
    const line = inputRef.current;
    inputRef.current = "";
    setInput("");
    void runCommand(line);
  }, [runCommand]);

  const appendInput = useCallback(
    (chunk: string) => {
      // Normalize CR/LF (TTY, paste, and scripted input all differ).
      const normalized = chunk.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      if (!normalized.includes("\n")) {
        inputRef.current += normalized;
        setInput(inputRef.current);
        return;
      }

      const parts = normalized.split("\n");
      // Everything before the first newline appends to the current draft.
      inputRef.current += parts[0] ?? "";
      const complete = [inputRef.current];
      // Intermediate complete lines.
      for (let i = 1; i < parts.length - 1; i++) {
        complete.push(parts[i] ?? "");
      }
      // Remainder after the last newline becomes the new draft.
      inputRef.current = parts[parts.length - 1] ?? "";
      setInput(inputRef.current);

      for (const line of complete) {
        void runCommand(line);
      }
    },
    [runCommand],
  );

  useInput((ch, key) => {
    if (busyRef.current) return;

    if (key.ctrl && (ch === "c" || ch === "C")) {
      exit();
      return;
    }
    if (key.escape) {
      inputRef.current = "";
      setInput("");
      return;
    }
    if (key.backspace || key.delete) {
      inputRef.current = inputRef.current.slice(0, -1);
      setInput(inputRef.current);
      return;
    }
    // Enter — Ink sets key.return; some environments only deliver \r/\n in ch.
    if (key.return || ch === "\r" || ch === "\n") {
      // If ch is a longer paste ending in newline, handle via appendInput.
      if (ch && ch.length > 1) {
        appendInput(ch);
        return;
      }
      submitLine();
      return;
    }
    if (!ch || key.ctrl || key.meta) return;
    if (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) return;

    appendInput(ch);
  });

  const wanLine = host.publicIp
    ? `${host.publicIp}:${host.port}`
    : "(public IP unavailable)";

  const mapList = maps
    .map((m) => (m.name === mapName ? `${m.name}*` : m.name))
    .join(", ");

  return (
    <Box flexDirection="column" paddingX={1} paddingY={0}>
      <Box
        borderStyle="round"
        borderColor="cyan"
        flexDirection="column"
        paddingX={1}
        width={72}
      >
        <Text bold color="cyan">
          DOORS {SERVER_VERSION} · {gameServer.getName()}
        </Text>
        <Text>
          Map: <Text color="green">{mapName}</Text>{"  "}Players:{" "}
          <Text color="yellow">
            {players}/{gameServer.getMaxPlayers()}
          </Text>
          {gameServer.getBotCount() > 0
            ? (
              <Text dimColor>
                {" ("}
                {gameServer.getBotCount()} bot
                {gameServer.getBotCount() === 1 ? "" : "s"})
              </Text>
            )
            : null}{"  "}Score: <Text color="blue">{scores.A}</Text>
          <Text dimColor>–</Text>
          <Text color="red">{scores.B}</Text>
          {matchOver ? <Text color="magenta">(intermission)</Text> : null}
        </Text>
        {tickLine
          ? (
            <Text color={tickHot ? "yellow" : undefined} dimColor={!tickHot}>
              {tickLine}
            </Text>
          )
          : null}
        {netMirrorLine
          ? (
            <Text
              color={netMirrorHot ? "yellow" : undefined}
              dimColor={!netMirrorHot}
            >
              {netMirrorLine}
            </Text>
          )
          : null}
        <Text dimColor>File: {mapPath || "—"}</Text>
        <Text>
          Port: <Text color="white">{host.port}</Text>
        </Text>
        <Text>
          Public IP: <Text color="green">{wanLine}</Text>
        </Text>
        <Text>
          Join password:{" "}
          {gameServer.hasJoinPassword()
            ? <Text color="green">set (share it with the IP)</Text>
            : <Text dimColor>not used (official server)</Text>}
        </Text>
        <Text dimColor>
          Friends type this exact IP:port in Find. Not listed in the game.
        </Text>
        <Text dimColor>
          Forward TCP {host.port} on your router for internet play.
        </Text>
        <Text>
          Maps: <Text color="cyan">{mapList}</Text>
        </Text>
      </Box>

      <Box flexDirection="column" marginTop={1} width={72}>
        <Text bold dimColor>
          Log
        </Text>
        {logs.map((line) => (
          <Text
            key={line.id}
            color={line.tone === "ok"
              ? "green"
              : line.tone === "warn"
              ? "yellow"
              : line.tone === "err"
              ? "red"
              : undefined}
            dimColor={line.tone === "info"}
          >
            {line.text}
          </Text>
        ))}
      </Box>

      <Box marginTop={1} width={72}>
        <Text color="cyan" bold>
          {"> "}
        </Text>
        <Text>
          {input}
          <Text color="cyan">{busy ? " …" : "█"}</Text>
        </Text>
      </Box>

      <Box marginTop={0}>
        <Text dimColor>
          map &lt;name&gt; · maps · bots · bots add/remove · help · quit
        </Text>
      </Box>
    </Box>
  );
}
