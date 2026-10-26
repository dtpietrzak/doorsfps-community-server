/**
 * Bot-think keys-only guard (the keys-only note).
 *
 * Arena bots must be indistinguishable from humans once their keys enter the
 * sim, so SIM code may not read `.isBot`. Non-sim bookkeeping (AFK,
 * participation, party, lobby balance, wire snapshots, roster construction)
 * may, and is allowlisted per enclosing member below.
 *
 * `expectedSimOffenders` lists the sim branches the epic still has to
 * delete. The test asserts it exactly: a new sim read fails, and so does
 * deleting one without removing its entry — the list only shrinks.
 *
 * `.isRaidBot` (the one permitted bot *role*) is asserted separately: only the
 * raid damage drop and roster construction may read it.
 *
 * Run from server-community/:
 *   deno test -A players/sim_no_bot_identity_test.ts
 */

import { assertEquals } from "@std/assert";

type FileRules = {
  /** Enclosing member → why an `.isBot` read there is not sim. */
  readonly allow: Readonly<Record<string, string>>;
  /** Enclosing member → count of sim reads still awaiting removal. */
  readonly expectedSimOffenders: Readonly<Record<string, number>>;
  /** Enclosing member → exact `.isRaidBot` read count (omit ⇒ none allowed). */
  readonly raidBotReads?: Readonly<Record<string, number>>;
};

const NONE: FileRules = { allow: {}, expectedSimOffenders: {} };

const RULES: Readonly<Record<string, FileRules>> = {
  "players/Player.ts": {
    allow: {
      constructor: "identity flags + no socket for AI players",
      isMatchPlayer: "open-match team balance / rebalance vote policy",
      sampleParticipation: "participation metering (non-sim)",
      markConnectionIssue: "transport lifecycle",
      shouldKickForAfk: "AFK kick policy (non-sim)",
      toSnapshot: "wire-only: ack seq, hold ticks, spectate botDec",
    },
    expectedSimOffenders: {},
    // Role derivation from options (roster construction).
    raidBotReads: { constructor: 3 },
  },
  "players/PlayerManager.ts": {
    allow: {
      restoreFromCheckpoint: "roster construction + socket index",
      insertFromAuthoritativeRoster: "roster construction + socket index",
      getStatusBoard: "status API",
      getTopPlayer: "status API",
      humanTeamCounts: "lobby team balance",
      canChangeTeam: "lobby team switch",
      changeTeam: "lobby team switch",
      partyCohortOnTeam: "party grouping",
      pickGroupForRebalance: "party grouping / rebalance",
      rebalanceBotTeams: "lobby fill-bot rebalance (roster role policy)",
      findPartyMember: "party grouping",
      listPartyMembers: "party grouping",
      remove: "roster bookkeeping",
      humanCount: "roster counts",
      botCount: "roster counts",
      bots: "roster counts",
      humans: "roster counts",
      findSessionConflict: "session / transport",
      takeOverConnection: "session / transport",
      enterPrematch: "AFK activity stamp",
      beginLiveMatch: "AFK activity stamp",
      setMatchReady: "prematch ready votes",
      getPrematchState: "prematch ready votes",
      sampleParticipation: "participation metering",
      getMatchParticipation: "participation metering",
    },
    expectedSimOffenders: {},
    raidBotReads: {
      // Raid damage drop (the only sim rule keyed on a bot role).
      applyShotDamage: 1,
      handleMelee: 1,
      // Roster construction: `addBot` forwards the role option.
      addBot: 1,
    },
  },
  "combat/aimSpread.ts": NONE,
  "combat/hitscan.ts": NONE,
  "combat/lagComp.ts": NONE,
  "shared/sim/moveStep.ts": NONE,
};

const MEMBER_DECL =
  /^ {2}(?:public |private |protected )?(?:static )?(?:readonly )?(?:async )?(?:get |set )?([A-Za-z_$][\w$]*)\s*[(<]/;
const FUNCTION_DECL = /^(?:export )?(?:async )?function\s+([A-Za-z_$][\w$]*)/;
const CONTROL_WORDS = new Set(["if", "for", "while", "switch", "return", "catch"]);

/** `.isBot` reads grouped by the nearest enclosing class member / function. */
export function isBotReadsByMember(source: string): Map<string, number> {
  return propertyReadsByMember(source, /\.isBot\b/g);
}

/** `pattern` matches grouped by the nearest enclosing class member / function. */
export function propertyReadsByMember(
  source: string,
  pattern: RegExp,
): Map<string, number> {
  const lines = source.split("\n");
  const out = new Map<string, number>();
  for (let i = 0; i < lines.length; i++) {
    const hits = lines[i]!.match(pattern);
    if (!hits) continue;
    let member = "<top-level>";
    for (let j = i; j >= 0; j--) {
      const m = MEMBER_DECL.exec(lines[j]!) ?? FUNCTION_DECL.exec(lines[j]!);
      if (m && !CONTROL_WORDS.has(m[1]!)) {
        member = m[1]!;
        break;
      }
    }
    out.set(member, (out.get(member) ?? 0) + hits.length);
  }
  return out;
}

for (const [file, rules] of Object.entries(RULES)) {
  Deno.test(`sim reads no bot identity: ${file}`, async () => {
    const source = await Deno.readTextFile(new URL(`../${file}`, import.meta.url));
    const simReads: Record<string, number> = {};
    for (const [member, n] of isBotReadsByMember(source)) {
      if (member in rules.allow) continue;
      simReads[member] = n;
    }
    assertEquals(
      simReads,
      { ...rules.expectedSimOffenders },
      "sim `.isBot` reads changed — delete the branch (keys-only) or, if the " +
        "member is genuinely non-sim, allowlist it with a reason",
    );
  });

  Deno.test(`isRaidBot read only by the raid damage drop: ${file}`, async () => {
    const source = await Deno.readTextFile(new URL(`../${file}`, import.meta.url));
    assertEquals(
      Object.fromEntries(propertyReadsByMember(source, /\.isRaidBot\b/g)),
      { ...(rules.raidBotReads ?? {}) },
      "raid bots may differ from players only by the damage drop",
    );
  });
}

Deno.test("isBotReadsByMember attributes reads to the enclosing member", () => {
  const src = [
    "export function helper(p) {",
    "  return p.isBot;",
    "}",
    "class X {",
    "  public update(tick: number): void {",
    "    if (this.isBot && other.isBot) {",
    "      return;",
    "    }",
    "  }",
    "  private get kind(): string {",
    "    return this.isBot ? 'bot' : 'human';",
    "  }",
    "}",
  ].join("\n");
  assertEquals(
    Object.fromEntries(isBotReadsByMember(src)),
    { helper: 1, update: 2, kind: 1 },
  );
});
