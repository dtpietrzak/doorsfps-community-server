/**
 * Optional HTTPS material for official / local-proof GameServer listeners.
 *
 * Community downloadables leave TLS_CERT and TLS_KEY unset and stay on HTTP.
 * Both paths must be set (and readable PEM) to enable Deno-terminated TLS.
 */

export type TlsMaterial = {
  cert: string;
  key: string;
};

export type TlsEnvPaths = {
  certPath: string;
  keyPath: string;
};

export type EnvLike = {
  get(name: string): string | undefined;
};

/** Read TLS_CERT / TLS_KEY. Null when both unset; throws if only one is set. */
export function readTlsEnvPaths(env: EnvLike = Deno.env): TlsEnvPaths | null {
  const certPath = env.get("TLS_CERT")?.trim() ?? "";
  const keyPath = env.get("TLS_KEY")?.trim() ?? "";
  if (!certPath && !keyPath) return null;
  if (!certPath || !keyPath) {
    throw new Error(
      "TLS_CERT and TLS_KEY must both be set to enable HTTPS, or both unset for HTTP",
    );
  }
  return { certPath, keyPath };
}

export function loadTlsMaterial(paths: TlsEnvPaths): TlsMaterial {
  const cert = readPem(paths.certPath, "TLS_CERT");
  const key = readPem(paths.keyPath, "TLS_KEY");
  return { cert, key };
}

/** Load from env, or null when HTTPS is off. */
export function loadTlsMaterialFromEnv(
  env: EnvLike = Deno.env,
): TlsMaterial | null {
  const paths = readTlsEnvPaths(env);
  if (!paths) return null;
  return loadTlsMaterial(paths);
}

function readPem(path: string, label: string): string {
  let text: string;
  try {
    text = Deno.readTextFileSync(path);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`${label} unreadable at ${path}: ${message}`);
  }
  if (!text.includes("-----BEGIN ")) {
    throw new Error(`${label} at ${path} is not a PEM file`);
  }
  return text;
}
