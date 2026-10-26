import { assertEquals } from "jsr:@std/assert@1";
import {
  isModeUnlocked,
  isOfficialModeId,
  minLevelForMode,
  MODE_UNLOCK_LEVELS,
  modeUnlockMessage,
  officialModeFromServerId,
  resolveOfficialMode,
} from "./modeUnlocks.ts";

Deno.test("MODE_UNLOCK_LEVELS: easy+medium free; hard 4; ranked 6", () => {
  assertEquals(MODE_UNLOCK_LEVELS.easy, 1);
  assertEquals(MODE_UNLOCK_LEVELS.medium, 1);
  assertEquals(MODE_UNLOCK_LEVELS.hard, 4);
  assertEquals(MODE_UNLOCK_LEVELS.ranked, 6);
});

Deno.test("isOfficialModeId / officialModeFromServerId", () => {
  assertEquals(isOfficialModeId("easy"), true);
  assertEquals(isOfficialModeId("custom"), false);
  assertEquals(officialModeFromServerId("ranked"), "ranked");
  assertEquals(officialModeFromServerId("  HARD  "), "hard");
  assertEquals(officialModeFromServerId("g01/ranked"), "ranked");
  assertEquals(officialModeFromServerId("g01/ranked/2"), "ranked");
  assertEquals(officialModeFromServerId("community"), null);
  // Slot-shaped ids do not encode mode.
  assertEquals(officialModeFromServerId("g00/0"), null);
  assertEquals(officialModeFromServerId("g00/4"), null);
});

Deno.test("resolveOfficialMode prefers modeId over serverId path parse", () => {
  assertEquals(
    resolveOfficialMode({ modeId: "easy", serverId: "g00/4" }),
    "easy",
  );
  assertEquals(
    resolveOfficialMode({ modeId: "hard", serverId: "g00/easy/0" }),
    "hard",
  );
  assertEquals(
    resolveOfficialMode({ serverId: "g00/easy/0" }),
    "easy",
  );
  assertEquals(resolveOfficialMode({ serverId: "g00/4" }), null);
  assertEquals(resolveOfficialMode({ modeId: "not-a-mode", serverId: "g00/4" }), null);
  assertEquals(
    resolveOfficialMode({ modeId: "  RANKED  ", serverId: "g00/2" }),
    "ranked",
  );
  assertEquals(resolveOfficialMode({}), null);
  assertEquals(resolveOfficialMode({ modeId: null, serverId: null }), null);
});

Deno.test("isModeUnlocked respects thresholds", () => {
  assertEquals(isModeUnlocked("easy", 1), true);
  assertEquals(isModeUnlocked("medium", 1), true);
  assertEquals(isModeUnlocked("hard", 3), false);
  assertEquals(isModeUnlocked("hard", 4), true);
  assertEquals(isModeUnlocked("ranked", 5), false);
  assertEquals(isModeUnlocked("ranked", 6), true);
  assertEquals(isModeUnlocked("ranked", 20), true);
  // Unknown / community: always open
  assertEquals(isModeUnlocked(null, 1), true);
  assertEquals(isModeUnlocked("something-else", 1), true);
});

Deno.test("minLevelForMode + modeUnlockMessage", () => {
  assertEquals(minLevelForMode("easy"), 1);
  assertEquals(minLevelForMode("medium"), 1);
  assertEquals(minLevelForMode("hard"), 4);
  assertEquals(modeUnlockMessage("easy", 1), null);
  assertEquals(modeUnlockMessage("medium", 1), null);
  assertEquals(
    modeUnlockMessage("hard", 3),
    "Reach level 4 to unlock Hard. (You are level 3.)",
  );
  assertEquals(
    modeUnlockMessage("ranked", 5),
    "Reach level 6 to unlock Ranked. (You are level 5.)",
  );
  assertEquals(modeUnlockMessage("hard", 4), null);
});
