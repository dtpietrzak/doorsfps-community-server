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
