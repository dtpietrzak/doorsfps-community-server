/**
 * Public protocol surface for the built-in brain: the pipeline codec only.
 * The private look-host protocol stays in `bot-official`.
 */
export * from "./pipeline.ts";

/** Reported by the in-process engine and the command-brain test stub. */
export const BOT_THINK_ENGINE_VERSION = "0.6.0";
