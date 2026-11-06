/**
 * Whole-brain runtime selection. GameServer resolves it once and passes
 * the BotManager options through.
 */

import { type BotThinkEngine, createBotThinkEngine } from "@doors/bot-engine";
import {
  type CompiledBotThinkPipeline,
  DEFAULT_DENO_COMPILED_BOT_THINK_HOST,
  DEFAULT_PERRY_COMPILED_BOT_THINK_HOST,
  startCompiledBotThinkPipelineFromEnv,
} from "../bots/compiled/index.ts";

export type BotThinkRuntimeMode =
  | "pipeline-js"
  | "pipeline-js-codec"
  | "pipeline-compiled-shadow"
  | "pipeline-compiled"
  | "pipeline-compiled-deno-shadow"
  | "pipeline-compiled-deno"
  | "pipeline-compiled-perry"
  | "pipeline-compiled-perry-shadow";

export function parseBotThinkRuntimeMode(
  value: string | null | undefined,
): BotThinkRuntimeMode {
  const raw = value?.trim().toLowerCase();
  if (raw === "compiled" || raw === "pipeline-compiled") {
    return "pipeline-compiled";
  }
  if (raw === "compiled-shadow" || raw === "pipeline-compiled-shadow") {
    return "pipeline-compiled-shadow";
  }
  if (
    raw === "compiled-deno" || raw === "pipeline-compiled-deno" ||
    raw === "deno-compiled" || raw === "pipeline-deno"
  ) {
    return "pipeline-compiled-deno";
  }
  if (
    raw === "compiled-deno-shadow" ||
    raw === "pipeline-compiled-deno-shadow" ||
    raw === "deno-compiled-shadow"
  ) {
    return "pipeline-compiled-deno-shadow";
  }
  if (raw === "js-codec" || raw === "pipeline-js-codec") {
    return "pipeline-js-codec";
  }
  if (raw === "pipeline-compiled-perry" || raw === "compiled-perry" || raw === "pipeline-perry") {
    return "pipeline-compiled-perry";
  }
  if (raw === "pipeline-compiled-perry-shadow" || raw === "compiled-perry-shadow" || raw === "pipeline-perry-shadow") {
    return "pipeline-compiled-perry-shadow";
  }
  if (
    raw &&
    raw !== "pipeline-js" &&
    raw !== "js"
  ) {
    console.warn(
      `[bot-brain] unknown runtime '${raw}'; using pipeline-js`,
    );
  }
  return "pipeline-js";
}

export function botThinkRuntimeModeFromEnv(): BotThinkRuntimeMode {
  return parseBotThinkRuntimeMode(Deno.env.get("DOORS_BOT_THINK_RUNTIME"));
}

function isCompiledChildRuntime(mode: BotThinkRuntimeMode): boolean {
  return mode === "pipeline-compiled" ||
    mode === "pipeline-compiled-shadow" ||
    mode === "pipeline-compiled-deno" ||
    mode === "pipeline-compiled-deno-shadow" ||
    mode === "pipeline-compiled-perry" ||
    mode === "pipeline-compiled-perry-shadow";
}

function isCompiledAuthorityRuntime(mode: BotThinkRuntimeMode): boolean {
  return mode === "pipeline-compiled" || mode === "pipeline-compiled-deno" ||
    mode === "pipeline-compiled-perry";
}

function isDenoCompiledRuntime(mode: BotThinkRuntimeMode): boolean {
  return mode === "pipeline-compiled-deno" ||
    mode === "pipeline-compiled-deno-shadow";
}

/** Select the in-process half of the whole-brain runtime. */
export function createBotThinkEngineFromEnv(): BotThinkEngine | null {
  return isCompiledAuthorityRuntime(botThinkRuntimeModeFromEnv())
    ? null
    : createBotThinkEngine();
}

/** Injected engines from GameServerOptions. Omitted fields read the env. */
export type BotThinkRuntimeSelection = {
  botThinkEngine?: BotThinkEngine | null;
  compiledBotThinkEngine?: CompiledBotThinkPipeline | null;
  compiledBotThinkMode?: "shadow" | "compiled";
};

export type ResolvedBotThinkRuntime = {
  botThinkEngine: BotThinkEngine | null;
  compiledBotThinkEngine: CompiledBotThinkPipeline | null;
  /** Logged as `[bot-brain] runtime=...`. */
  mode: BotThinkRuntimeMode;
  botManagerOptions: {
    thoughtEngine: BotThinkEngine | null;
    thoughtCodecLoop: boolean;
    compiledThoughtEngine: CompiledBotThinkPipeline | null;
    compiledThoughtMode: "shadow" | "compiled";
    compiledThoughtHost: "scriptc" | "deno" | "perry";
  };
};

/**
 * `env` is the `DOORS_BOT_THINK_RUNTIME` value, not the process environment.
 * Injected engines skip the compiled-child spawn.
 */
export function resolveBotThinkRuntime(
  options: BotThinkRuntimeSelection,
  env: string | null | undefined,
): ResolvedBotThinkRuntime {
  const runtimeMode = parseBotThinkRuntimeMode(env);
  let botThinkEngine = options.botThinkEngine === undefined
    ? (isCompiledAuthorityRuntime(runtimeMode) ? null : createBotThinkEngine())
    : options.botThinkEngine;
  const compiledBotThinkEngine =
    options.compiledBotThinkEngine === undefined &&
      options.botThinkEngine === undefined &&
      isCompiledChildRuntime(runtimeMode)
      ? (isDenoCompiledRuntime(runtimeMode)
        ? startCompiledBotThinkPipelineFromEnv(undefined, {
          envName: "DOORS_BOT_THINK_DENO_BIN",
          defaultPath: DEFAULT_DENO_COMPILED_BOT_THINK_HOST,
        })
        : (runtimeMode === "pipeline-compiled-perry"
          ? startCompiledBotThinkPipelineFromEnv(undefined, {
            envName: "DOORS_BOT_THINK_BIN",
            defaultPath: DEFAULT_PERRY_COMPILED_BOT_THINK_HOST,
          })
          : startCompiledBotThinkPipelineFromEnv()))
      : options.compiledBotThinkEngine ?? null;
  if (
    isCompiledAuthorityRuntime(runtimeMode) &&
    compiledBotThinkEngine === null &&
    options.botThinkEngine === undefined
  ) {
    console.warn(
      `[bot-brain ${runtimeMode}] binary unavailable; falling back to pipeline-js`,
    );
    botThinkEngine = createBotThinkEngine();
  }
  const mode: BotThinkRuntimeMode = botThinkEngine
    ? (compiledBotThinkEngine
      ? (isDenoCompiledRuntime(runtimeMode)
        ? "pipeline-compiled-deno-shadow"
        : (runtimeMode === "pipeline-compiled-perry" ? "pipeline-compiled-perry-shadow" : "pipeline-compiled-shadow"))
      : runtimeMode === "pipeline-js-codec"
      ? "pipeline-js-codec"
      : "pipeline-js")
    : (isDenoCompiledRuntime(runtimeMode)
      ? "pipeline-compiled-deno"
      : (runtimeMode === "pipeline-compiled-perry" ? "pipeline-compiled-perry" : "pipeline-compiled"));
  console.log(`[bot-brain] runtime=${mode}`);
  return {
    botThinkEngine,
    compiledBotThinkEngine,
    mode,
    botManagerOptions: {
      thoughtEngine: botThinkEngine,
      thoughtCodecLoop: runtimeMode === "pipeline-js-codec",
      compiledThoughtEngine: compiledBotThinkEngine,
      compiledThoughtMode: options.compiledBotThinkMode ??
        (isCompiledAuthorityRuntime(runtimeMode) ? "compiled" : "shadow"),
      compiledThoughtHost: runtimeMode === "pipeline-compiled-perry"
        ? "perry"
        : (isDenoCompiledRuntime(runtimeMode) ? "deno" : "scriptc"),
    },
  };
}
