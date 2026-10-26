/** Cross-app messages used by the map builder's embedded playtest. */
export const MAP_BUILDER_PLAYTEST_PATH = "/map-builder-play";
export const MAP_BUILDER_PLAYTEST_READY = "doors:map-builder-playtest-ready";
export const MAP_BUILDER_PLAYTEST_LOAD = "doors:map-builder-playtest-load";
export const MAP_BUILDER_PLAYTEST_EXIT = "doors:map-builder-playtest-exit";
export const MAP_BUILDER_PLAYTEST_ERROR = "doors:map-builder-playtest-error";

export type MapBuilderPlaytestLoadMessage<TMap = unknown> = {
  type: typeof MAP_BUILDER_PLAYTEST_LOAD;
  map: TMap;
};

export function isMapBuilderPlaytestLoadMessage(
  value: unknown,
): value is MapBuilderPlaytestLoadMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as { type?: unknown; map?: unknown };
  return (
    message.type === MAP_BUILDER_PLAYTEST_LOAD &&
    !!message.map &&
    typeof message.map === "object"
  );
}
