import { assertEquals, assertThrows } from "@std/assert";
import {
  loadTlsMaterial,
  loadTlsMaterialFromEnv,
  readTlsEnvPaths,
} from "./tlsConfig.ts";
import { writeSelfSignedDevTls } from "./tlsDev.ts";

Deno.test("readTlsEnvPaths: both unset → HTTP (null)", () => {
  const env = { get: (_name: string) => undefined };
  assertEquals(readTlsEnvPaths(env), null);
});

Deno.test("readTlsEnvPaths: blank strings → HTTP (null)", () => {
  const env = {
    get: (name: string) =>
      name === "TLS_CERT" || name === "TLS_KEY" ? "  " : undefined,
  };
  assertEquals(readTlsEnvPaths(env), null);
});

Deno.test("readTlsEnvPaths: only one set → throw", () => {
  assertThrows(
    () =>
      readTlsEnvPaths({
        get: (name) => name === "TLS_CERT" ? "/tmp/c.pem" : undefined,
      }),
    Error,
    "both be set",
  );
  assertThrows(
    () =>
      readTlsEnvPaths({
        get: (name) => name === "TLS_KEY" ? "/tmp/k.pem" : undefined,
      }),
    Error,
    "both be set",
  );
});

Deno.test("loadTlsMaterialFromEnv: reads PEM pair", async () => {
  const dir = await Deno.makeTempDir({ prefix: "doors-tls-" });
  try {
    const files = await writeSelfSignedDevTls(dir);
    const env = {
      get: (name: string) => {
        if (name === "TLS_CERT") return files.certPath;
        if (name === "TLS_KEY") return files.keyPath;
        return undefined;
      },
    };
    const material = loadTlsMaterialFromEnv(env);
    assertEquals(material?.cert.includes("BEGIN CERTIFICATE"), true);
    assertEquals(material?.key.includes("BEGIN"), true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("loadTlsMaterial: missing file throws", () => {
  assertThrows(
    () =>
      loadTlsMaterial({
        certPath: "/tmp/doors-tls-missing-cert.pem",
        keyPath: "/tmp/doors-tls-missing-key.pem",
      }),
    Error,
    "TLS_CERT unreadable",
  );
});

Deno.test("loadTlsMaterial: non-PEM throws", async () => {
  const dir = await Deno.makeTempDir({ prefix: "doors-tls-bad-" });
  try {
    const certPath = `${dir}/cert.pem`;
    const keyPath = `${dir}/key.pem`;
    Deno.writeTextFileSync(certPath, "not a cert");
    Deno.writeTextFileSync(keyPath, "not a key");
    assertThrows(
      () => loadTlsMaterial({ certPath, keyPath }),
      Error,
      "not a PEM file",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
