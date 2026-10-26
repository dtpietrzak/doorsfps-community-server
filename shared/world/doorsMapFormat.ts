/**
 * On-disk format version for `*.doors.json`.
 *
 * When you change the map JSON schema:
 * 1. Bump `MAP_FORMAT_VERSION`.
 * 2. Add a `migrateV{n}ToV{n+1}` step in `mapBuilder/src/migrateMap.ts`.
 * 3. Import migrates older files automatically.
 * 4. Update shipped maps under `server-community/maps/{competitive,raid,campaign}` (or run
 *    `mapBuilder/scripts/migrateDoorsMaps.ts`).
 *
 * Version history:
 *   1 — original schema (`mirrorMode` omitted / optional)
 *   2 — required `mirrorMode` (`flipY` | `flipXZ`)
 */
export const MAP_FORMAT_VERSION = 2 as const;

export type MapFormatVersion = 1 | typeof MAP_FORMAT_VERSION;

export function isSupportedMapFormatVersion(
  value: unknown,
): value is MapFormatVersion {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= MAP_FORMAT_VERSION
  );
}
