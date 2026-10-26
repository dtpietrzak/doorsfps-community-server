/**
 * Self-signed localhost certs for TLS tests and httpsSmoke.
 * Not used by production / community downloadables.
 */

export type DevTlsFiles = {
  dir: string;
  certPath: string;
  keyPath: string;
  derPath: string;
  cert: string;
  key: string;
  der: Uint8Array;
};

/** Write a short-lived localhost cert+key under `dir` via openssl. */
export async function writeSelfSignedDevTls(dir: string): Promise<DevTlsFiles> {
  Deno.mkdirSync(dir, { recursive: true });
  const certPath = `${dir}/cert.pem`;
  const keyPath = `${dir}/key.pem`;
  const cmd = new Deno.Command("openssl", {
    args: [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "2",
      "-nodes",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
      "-addext",
      "basicConstraints=critical,CA:FALSE",
    ],
    stdout: "piped",
    stderr: "piped",
  });
  const out = await cmd.output();
  if (!out.success) {
    const stderr = new TextDecoder().decode(out.stderr).trim();
    throw new Error(
      `openssl failed to create a self-signed cert (exit ${out.code}): ${stderr}`,
    );
  }
  const derPath = `${dir}/cert.der`;
  const derOut = await new Deno.Command("openssl", {
    args: ["x509", "-in", certPath, "-outform", "der", "-out", derPath],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!derOut.success) {
    const stderr = new TextDecoder().decode(derOut.stderr).trim();
    throw new Error(
      `openssl failed to write DER cert (exit ${derOut.code}): ${stderr}`,
    );
  }
  return {
    dir,
    certPath,
    keyPath,
    derPath,
    cert: Deno.readTextFileSync(certPath),
    key: Deno.readTextFileSync(keyPath),
    der: Deno.readFileSync(derPath),
  };
}

/** SHA-256 of a DER certificate for WebTransport `serverCertificateHashes`. */
export async function certificateSha256(
  der: Uint8Array,
): Promise<ArrayBuffer> {
  const copy = Uint8Array.from(der);
  return await crypto.subtle.digest("SHA-256", copy);
}
