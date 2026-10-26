/**
 * Shared drain signal for host-agent → child runtime (S7-PR4).
 *
 * The supervisor writes `{workDir}/.doors-draining` when a slot is draining.
 * The child polls the flag (and optional DOORS_DRAINING env for tests) so
 * /api/status can advertise draining and refuse new admissions.
 */

export const RUNTIME_DRAIN_FLAG_FILENAME = ".doors-draining";

export type EnvLike = {
  get(key: string): string | undefined;
};

type DenoRuntime = {
  env?: EnvLike;
  statSync?(path: string): unknown;
};

function denoRuntime(): DenoRuntime | undefined {
  return (globalThis as typeof globalThis & { Deno?: DenoRuntime }).Deno;
}

/** True when DOORS_DRAINING is a truthy strict flag (tests / forced drain). */
export function envRequestsDraining(env: EnvLike | undefined = denoRuntime()?.env): boolean {
  const raw = env?.get("DOORS_DRAINING")?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

/**
 * True when the drain flag file exists under `cwd` (child process workdir).
 * Missing / unreadable file → not draining (fail open for local dev without agent).
 */
export function isDrainFlagPresent(cwd = "."): boolean {
  try {
    const path = cwd === "." || cwd === ""
      ? RUNTIME_DRAIN_FLAG_FILENAME
      : `${cwd.replace(/\/$/, "")}/${RUNTIME_DRAIN_FLAG_FILENAME}`;
    const statSync = denoRuntime()?.statSync;
    if (!statSync) return false;
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Combined drain check used by GameServer status + join gates. */
export function isRuntimeDraining(opts?: {
  cwd?: string;
  env?: EnvLike;
}): boolean {
  if (envRequestsDraining(opts?.env ?? denoRuntime()?.env)) return true;
  return isDrainFlagPresent(opts?.cwd ?? ".");
}
