/**
 * Official runtimes honor authority /api/status during a coordinated release.
 * Scale-in `.doors-draining` is a separate host-agent signal.
 */

export type AuthorityReleaseState =
  | "ready"
  | "draining"
  | "deploying"
  | "maintenance";

export function releaseLockedFromAuthorityStatus(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const state = (value as { state?: unknown }).state;
  return state === "draining" || state === "deploying" ||
    state === "maintenance";
}

/** No rematch: hold intermission, then return remaining humans to the menu. */
export function shouldHoldMatchRestart(releaseLocked: boolean): boolean {
  return releaseLocked;
}

export function admissionLocked(
  runtimeDraining: boolean,
  releaseLocked: boolean,
): boolean {
  return runtimeDraining || releaseLocked;
}

export function authorityStatusUrl(baseUrl: string | null | undefined): string | null {
  const trimmed = baseUrl?.trim().replace(/\/$/, "") ?? "";
  return trimmed ? `${trimmed}/api/status` : null;
}

export type ReleaseLockPollIO = {
  fetch?: (input: string, init: RequestInit) => Promise<Response>;
  setInterval?: (cb: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearInterval?: (id: ReturnType<typeof setInterval>) => void;
  timeoutSignal?: (ms: number) => AbortSignal;
};

/**
 * Poll authority /api/status. First tick runs immediately, then every 5 s.
 * A failed or non-OK response leaves the last lock alone. `stop` clears the timer.
 * `io` is the test seam; production uses fetch, setInterval, and AbortSignal.timeout.
 */
export function startReleaseLockPoll(
  url: string,
  onLocked: (locked: boolean) => void,
  io?: ReleaseLockPollIO,
): () => void {
  const pollFetch = io?.fetch ??
    ((input: string, init: RequestInit) => fetch(input, init));
  const schedule = io?.setInterval ??
    ((cb: () => void, ms: number) => setInterval(cb, ms));
  const cancel = io?.clearInterval ??
    ((id: ReturnType<typeof setInterval>) => clearInterval(id));
  const timeoutSignal = io?.timeoutSignal ??
    ((ms: number) => AbortSignal.timeout(ms));
  let timer: ReturnType<typeof setInterval> | null = null;
  const tick = async () => {
    try {
      const response = await pollFetch(url, {
        cache: "no-store",
        signal: timeoutSignal(4_000),
      });
      if (!response.ok) return;
      onLocked(releaseLockedFromAuthorityStatus(await response.json()));
    } catch {
      // Keep the last observed lock; HTTP poll is best-effort.
    }
  };
  void tick();
  timer = schedule(() => {
    void tick();
  }, 5_000);
  return () => {
    if (timer == null) return;
    cancel(timer);
    timer = null;
  };
}
