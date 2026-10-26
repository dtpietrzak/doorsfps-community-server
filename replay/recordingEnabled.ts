/**
 * Epic 8.1 kill switch for match replay recording.
 *
 * Enabled by default. Disable with REPLAY_RECORDING_ENABLED=0|false|off|no
 * (case-insensitive). When disabled: no sink attach, no lifecycle rows, zero
 * per-tick payload construction (7.5 no-sink fast path).
 */

const DISABLE_VALUES = new Set(["0", "false", "off", "no"]);

export function isReplayRecordingEnabled(
  env: { get(key: string): string | undefined } = Deno.env,
): boolean {
  const raw = env.get("REPLAY_RECORDING_ENABLED")?.trim().toLowerCase();
  if (!raw) return true;
  return !DISABLE_VALUES.has(raw);
}
