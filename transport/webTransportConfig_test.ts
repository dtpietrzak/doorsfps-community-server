import { assertEquals } from "@std/assert";
import {
  WEBTRANSPORT_PATH,
  webTransportPathMatches,
  webTransportWanted,
} from "./webTransportConfig.ts";

function env(map: Record<string, string | undefined>) {
  return { get: (name: string) => map[name] };
}

Deno.test("webTransportWanted: HTTP never enables", () => {
  assertEquals(webTransportWanted({ tls: false }), false);
  assertEquals(
    webTransportWanted({
      tls: false,
      env: env({ WEBTRANSPORT_ENABLED: "1" }),
    }),
    false,
  );
});

Deno.test("webTransportWanted: TLS on by default", () => {
  assertEquals(webTransportWanted({ tls: true, env: env({}) }), true);
  assertEquals(
    webTransportWanted({
      tls: true,
      env: env({ WEBTRANSPORT_ENABLED: "true" }),
    }),
    true,
  );
});

Deno.test("webTransportWanted: explicit off", () => {
  for (const value of ["0", "false", "no", "off", " FALSE "]) {
    assertEquals(
      webTransportWanted({
        tls: true,
        env: env({ WEBTRANSPORT_ENABLED: value }),
      }),
      false,
      value,
    );
  }
});

Deno.test("webTransportPathMatches: /wt and query", () => {
  assertEquals(webTransportPathMatches("https://h:3001/wt"), true);
  assertEquals(webTransportPathMatches("https://h:3001/wt?x=1"), true);
  assertEquals(webTransportPathMatches("https://h:3001/"), false);
  assertEquals(webTransportPathMatches("https://h:3001/other"), false);
  assertEquals(
    webTransportPathMatches("https://h:3001/wt", WEBTRANSPORT_PATH),
    true,
  );
});
