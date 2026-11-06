import { assertEquals } from "@std/assert";
import type { BotThinkEngine } from "@doors/bot-engine";
import type { CompiledBotThinkPipeline } from "../bots/compiled/index.ts";
import {
  type BotThinkRuntimeMode,
  parseBotThinkRuntimeMode,
  type ResolvedBotThinkRuntime,
  resolveBotThinkRuntime,
} from "./botThinkRuntime.ts";

const js = { id: "js" } as unknown as BotThinkEngine;
const compiled = { id: "compiled" } as unknown as CompiledBotThinkPipeline;

Deno.test("parseBotThinkRuntimeMode names Deno-compiled child hosts", () => {
  assertEquals(parseBotThinkRuntimeMode(undefined), "pipeline-js");
  assertEquals(
    parseBotThinkRuntimeMode("pipeline-compiled"),
    "pipeline-compiled",
  );
  assertEquals(
    parseBotThinkRuntimeMode("pipeline-compiled-shadow"),
    "pipeline-compiled-shadow",
  );
  assertEquals(
    parseBotThinkRuntimeMode("pipeline-compiled-deno"),
    "pipeline-compiled-deno",
  );
  assertEquals(
    parseBotThinkRuntimeMode("compiled-deno"),
    "pipeline-compiled-deno",
  );
  assertEquals(
    parseBotThinkRuntimeMode("pipeline-compiled-deno-shadow"),
    "pipeline-compiled-deno-shadow",
  );
});

type ModeCase = {
  env: string | undefined;
  botThinkEngine?: BotThinkEngine | null;
  compiledBotThinkEngine?: CompiledBotThinkPipeline | null;
  compiledBotThinkMode?: "shadow" | "compiled";
  mode: BotThinkRuntimeMode;
  thoughtEngine: BotThinkEngine | null;
  thoughtCodecLoop: boolean;
  compiledThoughtEngine: CompiledBotThinkPipeline | null;
  compiledThoughtMode: "shadow" | "compiled";
  compiledThoughtHost: "scriptc" | "deno" | "perry";
  warn?: string;
};

const modeCases: ModeCase[] = [
  {
    env: undefined,
    botThinkEngine: js,
    mode: "pipeline-js",
    thoughtEngine: js,
    thoughtCodecLoop: false,
    compiledThoughtEngine: null,
    compiledThoughtMode: "shadow",
    compiledThoughtHost: "scriptc",
  },
  {
    env: "js",
    botThinkEngine: js,
    mode: "pipeline-js",
    thoughtEngine: js,
    thoughtCodecLoop: false,
    compiledThoughtEngine: null,
    compiledThoughtMode: "shadow",
    compiledThoughtHost: "scriptc",
  },
  {
    env: "pipeline-js-codec",
    botThinkEngine: js,
    mode: "pipeline-js-codec",
    thoughtEngine: js,
    thoughtCodecLoop: true,
    compiledThoughtEngine: null,
    compiledThoughtMode: "shadow",
    compiledThoughtHost: "scriptc",
  },
  {
    env: "pipeline-js",
    botThinkEngine: js,
    compiledBotThinkMode: "compiled",
    mode: "pipeline-js",
    thoughtEngine: js,
    thoughtCodecLoop: false,
    compiledThoughtEngine: null,
    compiledThoughtMode: "compiled",
    compiledThoughtHost: "scriptc",
  },
  {
    env: "pipeline-compiled",
    botThinkEngine: null,
    compiledBotThinkEngine: compiled,
    mode: "pipeline-compiled",
    thoughtEngine: null,
    thoughtCodecLoop: false,
    compiledThoughtEngine: compiled,
    compiledThoughtMode: "compiled",
    compiledThoughtHost: "scriptc",
  },
  {
    env: "compiled",
    botThinkEngine: null,
    compiledBotThinkEngine: compiled,
    mode: "pipeline-compiled",
    thoughtEngine: null,
    thoughtCodecLoop: false,
    compiledThoughtEngine: compiled,
    compiledThoughtMode: "compiled",
    compiledThoughtHost: "scriptc",
  },
  {
    env: "pipeline-compiled",
    botThinkEngine: js,
    compiledBotThinkEngine: compiled,
    mode: "pipeline-compiled-shadow",
    thoughtEngine: js,
    thoughtCodecLoop: false,
    compiledThoughtEngine: compiled,
    compiledThoughtMode: "compiled",
    compiledThoughtHost: "scriptc",
  },
  {
    env: "pipeline-compiled",
    botThinkEngine: js,
    mode: "pipeline-js",
    thoughtEngine: js,
    thoughtCodecLoop: false,
    compiledThoughtEngine: null,
    compiledThoughtMode: "compiled",
    compiledThoughtHost: "scriptc",
  },
  {
    env: "pipeline-compiled-shadow",
    botThinkEngine: js,
    compiledBotThinkEngine: compiled,
    mode: "pipeline-compiled-shadow",
    thoughtEngine: js,
    thoughtCodecLoop: false,
    compiledThoughtEngine: compiled,
    compiledThoughtMode: "shadow",
    compiledThoughtHost: "scriptc",
  },
  {
    env: "pipeline-compiled-shadow",
    botThinkEngine: js,
    mode: "pipeline-js",
    thoughtEngine: js,
    thoughtCodecLoop: false,
    compiledThoughtEngine: null,
    compiledThoughtMode: "shadow",
    compiledThoughtHost: "scriptc",
  },
  {
    env: "pipeline-compiled-deno",
    botThinkEngine: null,
    compiledBotThinkEngine: compiled,
    mode: "pipeline-compiled-deno",
    thoughtEngine: null,
    thoughtCodecLoop: false,
    compiledThoughtEngine: compiled,
    compiledThoughtMode: "compiled",
    compiledThoughtHost: "deno",
  },
  {
    env: "compiled-deno",
    botThinkEngine: null,
    compiledBotThinkEngine: compiled,
    mode: "pipeline-compiled-deno",
    thoughtEngine: null,
    thoughtCodecLoop: false,
    compiledThoughtEngine: compiled,
    compiledThoughtMode: "compiled",
    compiledThoughtHost: "deno",
  },
  {
    env: "pipeline-compiled-deno",
    botThinkEngine: js,
    compiledBotThinkEngine: compiled,
    mode: "pipeline-compiled-deno-shadow",
    thoughtEngine: js,
    thoughtCodecLoop: false,
    compiledThoughtEngine: compiled,
    compiledThoughtMode: "compiled",
    compiledThoughtHost: "deno",
  },
  {
    env: "pipeline-compiled-deno-shadow",
    botThinkEngine: js,
    compiledBotThinkEngine: compiled,
    mode: "pipeline-compiled-deno-shadow",
    thoughtEngine: js,
    thoughtCodecLoop: false,
    compiledThoughtEngine: compiled,
    compiledThoughtMode: "shadow",
    compiledThoughtHost: "deno",
  },
  {
    env: "deno-compiled-shadow",
    botThinkEngine: js,
    compiledBotThinkEngine: compiled,
    mode: "pipeline-compiled-deno-shadow",
    thoughtEngine: js,
    thoughtCodecLoop: false,
    compiledThoughtEngine: compiled,
    compiledThoughtMode: "shadow",
    compiledThoughtHost: "deno",
  },
  {
    env: "pipeline-compiled-perry",
    botThinkEngine: null,
    compiledBotThinkEngine: compiled,
    mode: "pipeline-compiled-perry",
    thoughtEngine: null,
    thoughtCodecLoop: false,
    compiledThoughtEngine: compiled,
    compiledThoughtMode: "compiled",
    compiledThoughtHost: "perry",
  },
  {
    env: "compiled-perry",
    botThinkEngine: null,
    compiledBotThinkEngine: compiled,
    mode: "pipeline-compiled-perry",
    thoughtEngine: null,
    thoughtCodecLoop: false,
    compiledThoughtEngine: compiled,
    compiledThoughtMode: "compiled",
    compiledThoughtHost: "perry",
  },
  {
    env: "pipeline-compiled-perry",
    botThinkEngine: js,
    compiledBotThinkEngine: compiled,
    mode: "pipeline-compiled-perry-shadow",
    thoughtEngine: js,
    thoughtCodecLoop: false,
    compiledThoughtEngine: compiled,
    compiledThoughtMode: "compiled",
    compiledThoughtHost: "perry",
  },
  {
    env: "pipeline-compiled-perry-shadow",
    botThinkEngine: js,
    compiledBotThinkEngine: compiled,
    mode: "pipeline-compiled-shadow",
    thoughtEngine: js,
    thoughtCodecLoop: false,
    compiledThoughtEngine: compiled,
    compiledThoughtMode: "shadow",
    compiledThoughtHost: "scriptc",
  },
  {
    env: "nope",
    botThinkEngine: js,
    mode: "pipeline-js",
    thoughtEngine: js,
    thoughtCodecLoop: false,
    compiledThoughtEngine: null,
    compiledThoughtMode: "shadow",
    compiledThoughtHost: "scriptc",
    warn: "[bot-brain] unknown runtime 'nope'; using pipeline-js",
  },
];

function captureConsole(run: () => ResolvedBotThinkRuntime): {
  resolved: ResolvedBotThinkRuntime;
  logs: string[];
  warns: string[];
} {
  const logs: string[] = [];
  const warns: string[] = [];
  const origLog = console.log;
  const origWarn = console.warn;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  console.warn = (...args: unknown[]) => {
    warns.push(args.map(String).join(" "));
  };
  try {
    return { resolved: run(), logs, warns };
  } finally {
    console.log = origLog;
    console.warn = origWarn;
  }
}

Deno.test("resolveBotThinkRuntime mode matrix uses injected engines", () => {
  for (const row of modeCases) {
    const { resolved, logs, warns } = captureConsole(() =>
      resolveBotThinkRuntime({
        botThinkEngine: row.botThinkEngine,
        compiledBotThinkEngine: row.compiledBotThinkEngine,
        compiledBotThinkMode: row.compiledBotThinkMode,
      }, row.env)
    );
    assertEquals(resolved.mode, row.mode, row.env);
    assertEquals(resolved.botThinkEngine, row.thoughtEngine, row.env);
    assertEquals(resolved.compiledBotThinkEngine, row.compiledThoughtEngine, row.env);
    assertEquals(resolved.botManagerOptions, {
      thoughtEngine: row.thoughtEngine,
      thoughtCodecLoop: row.thoughtCodecLoop,
      compiledThoughtEngine: row.compiledThoughtEngine,
      compiledThoughtMode: row.compiledThoughtMode,
      compiledThoughtHost: row.compiledThoughtHost,
    }, row.env);
    assertEquals(logs, [`[bot-brain] runtime=${row.mode}`], row.env);
    assertEquals(warns, row.warn ? [row.warn] : [], row.env);
  }
});

Deno.test("resolveBotThinkRuntime falls back when the authority binary is missing", () => {
  const { resolved, logs, warns } = captureConsole(() =>
    resolveBotThinkRuntime({
      compiledBotThinkEngine: null,
    }, "pipeline-compiled")
  );
  assertEquals(
    warns,
    ["[bot-brain pipeline-compiled] binary unavailable; falling back to pipeline-js"],
  );
  assertEquals(logs, ["[bot-brain] runtime=pipeline-js"]);
  assertEquals(resolved.mode, "pipeline-js");
  assertEquals(resolved.compiledBotThinkEngine, null);
  assertEquals(resolved.botThinkEngine !== null, true);
  assertEquals(resolved.botManagerOptions, {
    thoughtEngine: resolved.botThinkEngine,
    thoughtCodecLoop: false,
    compiledThoughtEngine: null,
    compiledThoughtMode: "compiled",
    compiledThoughtHost: "scriptc",
  });
});
