/**
 * Epic 16.3 / 16.7 — stable replay and clip ids, and the URLs those ids own.
 *
 * The integer row id stays a local key. A public id is unguessable and is the
 * only id that appears in a share path. Paths are origin-less so the same id
 * is stable across hosts.
 *
 * Watch paths (`/replay/…`, `/clip/…`) are what a person opens.
 * API paths (`/api/replays/s/…`, `/api/clips/s/…`) are what that page fetches.
 */

const PUBLIC_ID_BYTES = 16;

/** 16 bytes of base64url, no padding: 22 characters. */
export const REPLAY_PUBLIC_ID_RE = /^r_[A-Za-z0-9_-]{22}$/;
export const CLIP_PUBLIC_ID_RE = /^c_[A-Za-z0-9_-]{22}$/;

function base64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function randomPublicBody(): string {
  const bytes = new Uint8Array(PUBLIC_ID_BYTES);
  crypto.getRandomValues(bytes);
  const body = base64Url(bytes);
  if (body.length !== 22) {
    throw new Error(`replay public id body length ${body.length}`);
  }
  return body;
}

export function createReplayPublicId(): string {
  return `r_${randomPublicBody()}`;
}

export function createClipPublicId(): string {
  return `c_${randomPublicBody()}`;
}

export function isReplayPublicId(value: unknown): value is string {
  return typeof value === "string" && REPLAY_PUBLIC_ID_RE.test(value);
}

export function isClipPublicId(value: unknown): value is string {
  return typeof value === "string" && CLIP_PUBLIC_ID_RE.test(value);
}

export function replayApiPath(publicId: string): string {
  return `/api/replays/s/${publicId}`;
}

export function replayFilePath(publicId: string): string {
  return `/api/replays/s/${publicId}/file`;
}

export function clipApiPath(publicId: string): string {
  return `/api/clips/s/${publicId}`;
}

/** Human share URL for a replay. */
export function replayWatchPath(publicId: string): string {
  return `/replay/${publicId}`;
}

/** Human share URL for a clip. */
export function clipWatchPath(publicId: string): string {
  return `/clip/${publicId}`;
}

export type ReplayWatchMatch =
  | { readonly kind: "replay"; readonly publicId: string }
  | { readonly kind: "clip"; readonly publicId: string };

/** Match a share path, ignoring a trailing slash. */
export function matchReplayWatchPath(pathname: string): ReplayWatchMatch | null {
  const path = pathname.length > 1 && pathname.endsWith("/")
    ? pathname.slice(0, -1)
    : pathname;
  const replay = /^\/replay\/([^/]+)$/.exec(path);
  if (replay && isReplayPublicId(replay[1])) {
    return { kind: "replay", publicId: replay[1] };
  }
  const clip = /^\/clip\/([^/]+)$/.exec(path);
  if (clip && isClipPublicId(clip[1])) {
    return { kind: "clip", publicId: clip[1] };
  }
  return null;
}
