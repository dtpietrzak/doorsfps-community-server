import { assertEquals } from "jsr:@std/assert@1";
import {
  parseAdminCommandRequest,
  parseAdminConsoleLine,
  sanitizeKickName,
  sanitizeMapName,
} from "./adminCommands.ts";

Deno.test("sanitizeMapName accepts catalog-style names", () => {
  assertEquals(sanitizeMapName("ElijahMap"), "ElijahMap");
  assertEquals(sanitizeMapName("  Pillars  "), "Pillars");
  assertEquals(sanitizeMapName("Crossroads"), "Crossroads");
});

Deno.test("sanitizeMapName rejects junk", () => {
  assertEquals(sanitizeMapName(""), null);
  assertEquals(sanitizeMapName("../etc"), null);
  assertEquals(sanitizeMapName("a b"), null);
  assertEquals(sanitizeMapName(null), null);
});

Deno.test("sanitizeKickName accepts display names", () => {
  assertEquals(sanitizeKickName("Alice"), "Alice");
  assertEquals(sanitizeKickName("  MeshKick  "), "MeshKick");
  assertEquals(sanitizeKickName("bot"), "bot");
  assertEquals(sanitizeKickName("bot3"), "bot3");
});

Deno.test("sanitizeKickName rejects junk", () => {
  assertEquals(sanitizeKickName(""), null);
  assertEquals(sanitizeKickName("a".repeat(25)), null);
  assertEquals(sanitizeKickName(null), null);
});

Deno.test("parseAdminCommandRequest change_map", () => {
  const ok = parseAdminCommandRequest("change_map", { mapName: "ElijahMap" });
  assertEquals(ok.ok, true);
  if (ok.ok) {
    assertEquals(ok.command, "change_map");
    assertEquals(ok.args, { mapName: "ElijahMap" });
  }

  const bad = parseAdminCommandRequest("change_map", {});
  assertEquals(bad.ok, false);
});

Deno.test("parseAdminCommandRequest kick", () => {
  const ok = parseAdminCommandRequest("kick", { name: "MeshKick" });
  assertEquals(ok.ok, true);
  if (ok.ok) {
    assertEquals(ok.command, "kick");
    assertEquals(ok.args, { name: "MeshKick" });
  }

  const bad = parseAdminCommandRequest("kick", {});
  assertEquals(bad.ok, false);

  const unknown = parseAdminCommandRequest("ban", { name: "x" });
  assertEquals(unknown.ok, false);
});

Deno.test("parseAdminConsoleLine", () => {
  const line = parseAdminConsoleLine("change_map ElijahMap");
  assertEquals(line?.ok, true);
  if (line?.ok) {
    assertEquals(line.args.mapName, "ElijahMap");
  }
  assertEquals(parseAdminConsoleLine("help"), null);
  const missing = parseAdminConsoleLine("change_map");
  // Known command with bad args → ok:false (not null)
  assertEquals(missing?.ok, false);

  const kick = parseAdminConsoleLine("kick MeshKick");
  assertEquals(kick?.ok, true);
  if (kick?.ok) {
    assertEquals(kick.args.name, "MeshKick");
  }
  const kickMissing = parseAdminConsoleLine("kick");
  assertEquals(kickMissing?.ok, false);

  const track = parseAdminConsoleLine("track_bots");
  assertEquals(track?.ok, true);
  if (track?.ok) {
    assertEquals(track.command, "track_bots");
    assertEquals(track.args, {});
  }
});

Deno.test("parseAdminCommandRequest track_bots", () => {
  const ok = parseAdminCommandRequest("track_bots", {});
  assertEquals(ok.ok, true);
  if (ok.ok) {
    assertEquals(ok.command, "track_bots");
  }
});

Deno.test("parseAdminCommandRequest force_doors", () => {
  const toggle = parseAdminCommandRequest("force_doors", {});
  assertEquals(toggle.ok, true);
  if (toggle.ok) {
    assertEquals(toggle.command, "force_doors");
    assertEquals(toggle.args, {});
  }
  const on = parseAdminCommandRequest("force_doors", { enabled: true });
  assertEquals(on.ok, true);
  if (on.ok) {
    assertEquals(on.args, { enabled: true });
  }
  const off = parseAdminCommandRequest("force_doors", { enabled: false });
  assertEquals(off.ok, true);
  if (off.ok) {
    assertEquals(off.args, { enabled: false });
  }
  const bad = parseAdminCommandRequest("force_doors", { enabled: "yes" });
  assertEquals(bad.ok, false);
});

Deno.test("parseAdminConsoleLine force_doors", () => {
  const toggle = parseAdminConsoleLine("force_doors");
  assertEquals(toggle?.ok, true);
  if (toggle?.ok) {
    assertEquals(toggle.args, {});
  }
  const on = parseAdminConsoleLine("force_doors on");
  assertEquals(on?.ok, true);
  if (on?.ok) {
    assertEquals(on.args, { enabled: true });
  }
  const off = parseAdminConsoleLine("force_doors off");
  assertEquals(off?.ok, true);
  if (off?.ok) {
    assertEquals(off.args, { enabled: false });
  }
  const bad = parseAdminConsoleLine("force_doors maybe");
  assertEquals(bad?.ok, false);
});

Deno.test("parseAdminCommandRequest spectate", () => {
  const ok = parseAdminCommandRequest("spectate", {});
  assertEquals(ok.ok, true);
  if (ok.ok) {
    assertEquals(ok.command, "spectate");
    assertEquals(ok.args, {});
  }
});

Deno.test("parseAdminCommandRequest unlock", () => {
  const ok = parseAdminCommandRequest("unlock", { target: "raids" });
  assertEquals(ok.ok, true);
  if (ok.ok) {
    assertEquals(ok.command, "unlock");
    assertEquals(ok.args, { target: "raids" });
  }

  const normalized = parseAdminCommandRequest("unlock", { target: "  Raids " });
  assertEquals(normalized.ok, true);

  const missing = parseAdminCommandRequest("unlock", {});
  assertEquals(missing.ok, false);

  const unknown = parseAdminCommandRequest("unlock", { target: "everything" });
  assertEquals(unknown.ok, false);
});

Deno.test("parseAdminConsoleLine unlock", () => {
  const ok = parseAdminConsoleLine("unlock raids");
  assertEquals(ok?.ok, true);
  if (ok?.ok) {
    assertEquals(ok.command, "unlock");
    assertEquals(ok.args, { target: "raids" });
  }
  assertEquals(parseAdminConsoleLine("UNLOCK RAIDS")?.ok, true);
  assertEquals(parseAdminConsoleLine("unlock")?.ok, false);
  assertEquals(parseAdminConsoleLine("unlock everything")?.ok, false);
});

Deno.test("parseAdminConsoleLine spectate is client-local (null)", () => {
  // Spectate joins a server from the console; not a mid-match AdminCommand emit.
  assertEquals(parseAdminConsoleLine("spectate breezeway"), null);
  assertEquals(parseAdminConsoleLine("spectate"), null);
});

Deno.test("parseAdminConsoleLine test_map is client-local (null)", () => {
  // Local map sandbox — never a remote AdminCommand emit.
  assertEquals(parseAdminConsoleLine("test_map ElijahMap"), null);
  assertEquals(parseAdminConsoleLine("test_map"), null);
});
