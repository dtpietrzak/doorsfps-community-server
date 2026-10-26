/**
 * Progression row join: authority may omit an unknown unranked clerk, so
 * response order is not request order.
 *   cd server-community && deno test -A authority/adapter_test.ts
 */

import { assertEquals } from "jsr:@std/assert@1";
import { matchReportProgressRow } from "./adapter.ts";

Deno.test("progression rows join on echoed clerk id, not position", () => {
  const report = [
    { clerkUserId: "user_a" },
    { clerkUserId: "user_missing" },
    { clerkUserId: " user_c " },
  ];
  const rows = [
    { clerkUserId: "user_c", xpEarned: 3 },
    { clerkUserId: "user_a", xpEarned: 10 },
  ];

  assertEquals(matchReportProgressRow(report, rows, 0)?.xpEarned, 10);
  assertEquals(matchReportProgressRow(report, rows, 1), undefined);
  assertEquals(matchReportProgressRow(report, rows, 2)?.xpEarned, 3);
});

Deno.test("progression rows stay positional when authority echoes no clerk id", () => {
  const report = [
    { clerkUserId: "user_a" },
    { clerkUserId: "user_b" },
  ];
  const rows = [{ xpEarned: 1 }, { xpEarned: 2 }];

  assertEquals(matchReportProgressRow(report, rows, 0)?.xpEarned, 1);
  assertEquals(matchReportProgressRow(report, rows, 1)?.xpEarned, 2);
});
