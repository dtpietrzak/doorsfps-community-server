/**
 * Epic 15.5 — clip permissions.
 *
 * The four visibility states, and whether an audience may read a clip.
 * Audiences are inputs. This module does not look up an owner, a link,
 * or a user. Enforcement is 20.4.
 *
 * ```text
 * visibility × audience → { catalog, readable }
 * ```
 *
 * Contract (notes/replay/replay-detailed.md §15.5):
 * - States, in note order: public, unlisted, private, deleted.
 * - A new clip is private until marked.
 * - `deleted` is a state. It is not a row delete. 15.4 `deleteReplayClip`
 *   still removes the row.
 * - `catalog` is true only for public, for every audience.
 * - `readable`: deleted is never; public is always; unlisted is owner or
 *   link; private is owner only.
 * - Any state may move to any other state. There is no workflow.
 *
 * Scan-locked: no clip definition, playback, wall-clock, fs, blob, or store.
 */

import { ReplayClipError } from "./replayClip.ts";

/** Note order. This array is the only copy of the four state names. */
export const REPLAY_CLIP_VISIBILITIES = [
  "public",
  "unlisted",
  "private",
  "deleted",
] as const;

export type ReplayClipVisibility = (typeof REPLAY_CLIP_VISIBILITIES)[number];

/** Fail closed. A new clip stays private until something marks it. */
export const DEFAULT_REPLAY_CLIP_VISIBILITY: ReplayClipVisibility = "private";

/** Who is asking. Not an account, a link token, or a catalog query. */
export const REPLAY_CLIP_AUDIENCES = ["owner", "link", "catalog"] as const;

export type ReplayClipAudience = (typeof REPLAY_CLIP_AUDIENCES)[number];

export type ReplayClipPermission = {
  readonly visibility: ReplayClipVisibility;
  readonly catalog: boolean;
  /** True when this audience may read the clip. */
  readonly readable: boolean;
};

export function isReplayClipVisibility(
  value: unknown,
): value is ReplayClipVisibility {
  return (
    typeof value === "string" &&
    REPLAY_CLIP_VISIBILITIES.includes(value as ReplayClipVisibility)
  );
}

export function isReplayClipAudience(
  value: unknown,
): value is ReplayClipAudience {
  return (
    typeof value === "string" &&
    REPLAY_CLIP_AUDIENCES.includes(value as ReplayClipAudience)
  );
}

/**
 * `catalog` is whether the clip belongs in a public catalog.
 * It does not depend on the audience. `readable` is the audience check.
 * A bad visibility throws before the audience is checked.
 */
export function replayClipPermission(
  visibility: unknown,
  audience: unknown,
): ReplayClipPermission {
  if (!isReplayClipVisibility(visibility)) {
    throw new ReplayClipError(
      "replay-clip-bad-visibility",
      "clip visibility must be public, unlisted, private, or deleted",
      { detail: String(visibility) },
    );
  }
  if (!isReplayClipAudience(audience)) {
    throw new ReplayClipError(
      "replay-clip-bad-audience",
      "clip audience must be owner, link, or catalog",
      { detail: String(audience) },
    );
  }
  return {
    visibility,
    catalog: visibility === "public",
    readable: readableFor(visibility, audience),
  };
}

function readableFor(
  visibility: ReplayClipVisibility,
  audience: ReplayClipAudience,
): boolean {
  switch (visibility) {
    case "deleted":
      return false;
    case "public":
      return true;
    case "unlisted":
      return audience === "owner" || audience === "link";
    case "private":
      return audience === "owner";
  }
}
