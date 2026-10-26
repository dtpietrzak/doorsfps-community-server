/** Itest/loadlab user ids are minted as `itest_<label>_<suffix>` (see mintActor). */
export const SYNTHETIC_USER_ID_PREFIX = "itest_";

/**
 * SQL `LIKE` pattern for `clerk_user_id`. Bind with `ESCAPE '\\'` —
 * the underscore in the prefix is a LIKE wildcard unless escaped.
 */
export const SYNTHETIC_USER_ID_LIKE = "itest\\_%";

export function isSyntheticUserId(
  userId: string | null | undefined,
): boolean {
  return typeof userId === "string" &&
    userId.startsWith(SYNTHETIC_USER_ID_PREFIX);
}

/** Loadlab sim usernames: LL_<tag><seq>. Display only — never trust for policy. */
export const LOADLAB_USERNAME_PREFIX = "LL_";
