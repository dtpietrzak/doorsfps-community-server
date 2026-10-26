import type { EnvLike } from "../host/tlsConfig.ts";
import {
  WEBTRANSPORT_MAX_FRAME_BYTES,
  WEBTRANSPORT_PATH,
} from "../shared/net/index.ts";

export { WEBTRANSPORT_MAX_FRAME_BYTES, WEBTRANSPORT_PATH };

/** Close the QUIC session if auth never arrives. */
export const WEBTRANSPORT_AUTH_TIMEOUT_MS = 5_000;

export type WebTransportWantedOpts = {
  /** True when this process terminates TLS (official / smoke). */
  tls: boolean;
  env?: EnvLike;
};

function parseEnabledFlag(raw: string | undefined): boolean | null {
  if (raw == null) return null;
  switch (raw.trim().toLowerCase()) {
    case "":
      return null;
    case "0":
    case "false":
    case "no":
    case "off":
      return false;
    case "1":
    case "true":
    case "yes":
    case "on":
      return true;
    default:
      return null;
  }
}

/**
 * Official TLS hosts want a QUIC listener unless WEBTRANSPORT_ENABLED is off.
 * Community HTTP downloadables never do.
 */
export function webTransportWanted(opts: WebTransportWantedOpts): boolean {
  if (!opts.tls) return false;
  const env = opts.env ?? Deno.env;
  const flag = parseEnabledFlag(env.get("WEBTRANSPORT_ENABLED"));
  if (flag === false) return false;
  return true;
}

export function webTransportPathMatches(
  url: string,
  path: string = WEBTRANSPORT_PATH,
): boolean {
  let pathname = "";
  try {
    pathname = new URL(url).pathname;
  } catch {
    const q = url.indexOf("?");
    pathname = q >= 0 ? url.slice(0, q) : url;
  }
  const wanted = path.startsWith("/") ? path : `/${path}`;
  if (pathname === wanted) return true;
  return pathname.endsWith(wanted);
}
