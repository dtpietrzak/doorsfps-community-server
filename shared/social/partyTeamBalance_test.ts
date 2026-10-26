/**
 * Pure group-aware team balancing (S9-PR2).
 */
import { assertEquals } from "jsr:@std/assert";
import {
  assignGroupsToTeams,
  compareRebalanceGroupPreference,
  isPartyLimitWithinRuntimeCapability,
  movingGroupImprovesBalance,
  pickTeamForGroupSize,
  RUNTIME_PARTY_SIZE_ABSOLUTE_MAX,
  runtimeMaxPartySize,
} from "./partyTeamBalance.ts";

Deno.test("runtimeMaxPartySize: clamps to capacity and absolute max", () => {
  assertEquals(runtimeMaxPartySize(8), 8);
  assertEquals(runtimeMaxPartySize(4), 4);
  assertEquals(runtimeMaxPartySize(16), RUNTIME_PARTY_SIZE_ABSOLUTE_MAX);
  assertEquals(runtimeMaxPartySize(0), 0);
  assertEquals(runtimeMaxPartySize(-3), 0);
  assertEquals(runtimeMaxPartySize(3.9), 3);
});

Deno.test("isPartyLimitWithinRuntimeCapability", () => {
  assertEquals(isPartyLimitWithinRuntimeCapability(4, 8), true);
  assertEquals(isPartyLimitWithinRuntimeCapability(8, 8), true);
  assertEquals(isPartyLimitWithinRuntimeCapability(9, 8), false);
  assertEquals(isPartyLimitWithinRuntimeCapability(4, 3), false);
  assertEquals(isPartyLimitWithinRuntimeCapability(0, 8), false);
  assertEquals(isPartyLimitWithinRuntimeCapability(4, 0), false);
});

Deno.test("pickTeamForGroupSize: parties 1 through max, empty and uneven seeds", () => {
  // Empty → A
  assertEquals(pickTeamForGroupSize(1, { A: 0, B: 0 }), "A");
  assertEquals(pickTeamForGroupSize(4, { A: 0, B: 0 }), "A");

  // A has 1 → party of 2 prefers B (1–2 better than 3–0)
  assertEquals(pickTeamForGroupSize(2, { A: 1, B: 0 }), "B");

  // A has 2 → party of 1 → B
  assertEquals(pickTeamForGroupSize(1, { A: 2, B: 0 }), "B");

  // Even → A
  assertEquals(pickTeamForGroupSize(1, { A: 2, B: 2 }), "A");

  // Size 3 with A=1 B=0 → A yields 4–0 (diff4), B yields 1–3 (diff2) → B
  assertEquals(pickTeamForGroupSize(3, { A: 1, B: 0 }), "B");

  // Size 4 with A=0 B=0 → A
  assertEquals(pickTeamForGroupSize(4, { A: 0, B: 0 }), "A");
});

Deno.test("pickTeamForGroupSize: tie-break prefers lighter then A", () => {
  // A=2 B=1, size 1: A→3–1 diff2, B→2–2 diff0 → B
  assertEquals(pickTeamForGroupSize(1, { A: 2, B: 1 }), "B");
  // Equal imbalance both ways: A=1 B=1 size 2 → 3–1 or 1–3, both diff 2 → A
  assertEquals(pickTeamForGroupSize(2, { A: 1, B: 1 }), "A");
});

Deno.test("assignGroupsToTeams: multiple parties and solos, deterministic", () => {
  const r = assignGroupsToTeams([
    { id: "solo_z", size: 1 },
    { id: "pty_big", size: 3 },
    { id: "pty_med", size: 2 },
    { id: "solo_a", size: 1 },
  ]);
  assertEquals(r.ok, true);
  if (!r.ok) return;

  // Process order: size 3, size 2, then solos by id.
  // pty_big → A (empty)
  // pty_med → B (minimizes)
  // solo_a → A or B depending on 3–2
  // solo_z → other
  const byId = Object.fromEntries(
    r.assignments.map((a) => [a.groupId, a.team]),
  );
  assertEquals(byId.pty_big, "A");
  assertEquals(byId.pty_med, "B");
  // After 3–2, solos of 1 prefer B then A to even: first solo_a → B (3–3), solo_z → A (4–3)
  assertEquals(byId.solo_a, "B");
  assertEquals(byId.solo_z, "A");
  assertEquals(r.teamCounts, { A: 4, B: 3 });
});

Deno.test("assignGroupsToTeams: locked groups and uneven existing seeds", () => {
  const r = assignGroupsToTeams(
    [
      { id: "already", size: 2, lockedTeam: "A" },
      { id: "incoming", size: 2 },
    ],
    { A: 1, B: 0 }, // seed already on A
  );
  assertEquals(r.ok, true);
  if (!r.ok) return;
  // Base A=1 + locked 2 → A=3; incoming 2 → B
  const byId = Object.fromEntries(
    r.assignments.map((a) => [a.groupId, a.team]),
  );
  assertEquals(byId.already, "A");
  assertEquals(byId.incoming, "B");
  assertEquals(r.teamCounts, { A: 3, B: 2 });
});

Deno.test("assignGroupsToTeams: impossible under maxTeamSize", () => {
  const r = assignGroupsToTeams(
    [{ id: "huge", size: 5 }],
    { A: 0, B: 0 },
    { maxTeamSize: 4 },
  );
  assertEquals(r.ok, false);
  if (r.ok) return;
  assertEquals(r.reason, "impossible");
});

Deno.test("assignGroupsToTeams: invalid group rejected", () => {
  const r = assignGroupsToTeams([{ id: "", size: 2 }]);
  assertEquals(r.ok, false);
  if (r.ok) return;
  assertEquals(r.reason, "invalid_group");

  const r2 = assignGroupsToTeams([{ id: "x", size: 0 }]);
  assertEquals(r2.ok, false);
});

Deno.test("movingGroupImprovesBalance: only when |diff| shrinks", () => {
  // 4v1 move 1 from A → 3v2 improves
  assertEquals(movingGroupImprovesBalance(1, "A", { A: 4, B: 1 }), true);
  // 4v1 move 2 from A → 2v3 improves
  assertEquals(movingGroupImprovesBalance(2, "A", { A: 4, B: 1 }), true);
  // 3v1 move 2 from A → 1v3 same |diff|=2, not better
  assertEquals(movingGroupImprovesBalance(2, "A", { A: 3, B: 1 }), false);
  // 3v1 move 3 from A → 0v4 worse
  assertEquals(movingGroupImprovesBalance(3, "A", { A: 3, B: 1 }), false);
  // 2v2 move anything does not improve
  assertEquals(movingGroupImprovesBalance(1, "A", { A: 2, B: 2 }), false);
  // cannot move more than on side
  assertEquals(movingGroupImprovesBalance(3, "B", { A: 4, B: 1 }), false);
});

Deno.test("compareRebalanceGroupPreference: solos before parties, AFK, rating", () => {
  assertEquals(
    compareRebalanceGroupPreference(
      { size: 1, anchorRating: 5, anchorAfk: false, id: "a" },
      { size: 2, anchorRating: 0, anchorAfk: true, id: "b" },
    ) < 0,
    true,
  );
  assertEquals(
    compareRebalanceGroupPreference(
      { size: 1, anchorRating: 1, anchorAfk: true, id: "afk" },
      { size: 1, anchorRating: 0, anchorAfk: false, id: "weak" },
    ) < 0,
    true,
  );
  assertEquals(
    compareRebalanceGroupPreference(
      { size: 1, anchorRating: 1, anchorAfk: false, id: "a" },
      { size: 1, anchorRating: 2, anchorAfk: false, id: "b" },
    ) < 0,
    true,
  );
});
