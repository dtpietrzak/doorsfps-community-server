/** Local + public address discovery for the host startup banner. */

const PUBLIC_IP_ENDPOINTS = [
  "https://api.ipify.org",
  "https://ifconfig.me/ip",
  "https://icanhazip.com",
] as const;

const PORT_FORWARD_GUIDE = "https://portforward.com/";
const PORT_FORWARD_EXPLAIN =
  "https://www.noip.com/support/knowledgebase/general-port-forwarding-guide/";

export type HostAddresses = {
  local: string[];
  publicIp: string | null;
};

/** IPv4 addresses on this machine (LAN-facing first, skips loopback). */
export function getLocalIPv4Addresses(): string[] {
  const found = new Set<string>();

  try {
    for (const iface of Deno.networkInterfaces()) {
      if (iface.family !== "IPv4") continue;
      // Deno marks loopback as "lo" / name contains loopback; also skip 127.*
      if (iface.address.startsWith("127.")) continue;
      if (iface.address.startsWith("0.")) continue;
      // Link-local APIPA is usually not useful for hosting
      if (iface.address.startsWith("169.254.")) continue;
      found.add(iface.address);
    }
  } catch {
    // networkInterfaces may fail in restricted environments
  }

  const list = [...found];
  // Prefer private LAN ranges
  list.sort((a, b) => scorePrivate(a) - scorePrivate(b));
  return list;
}

function scorePrivate(ip: string): number {
  if (ip.startsWith("192.168.")) return 0;
  if (ip.startsWith("10.")) return 1;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)) return 2;
  return 3;
}

/** Best-effort public IP via HTTPS (needed for friends outside your network). */
export async function getPublicIP(timeoutMs = 4000): Promise<string | null> {
  for (const url of PUBLIC_IP_ENDPOINTS) {
    try {
      const ip = await fetchTextWithTimeout(url, timeoutMs);
      if (ip && isIPv4(ip)) return ip;
    } catch {
      // try next
    }
  }
  return null;
}

async function fetchTextWithTimeout(
  url: string,
  timeoutMs: number,
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "text/plain" },
    });
    if (!res.ok) return null;
    return (await res.text()).trim();
  } finally {
    clearTimeout(timer);
  }
}

function isIPv4(s: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return false;
  return m.slice(1).every((p) => {
    const n = Number(p);
    return n >= 0 && n <= 255;
  });
}

export async function resolveHostAddresses(): Promise<HostAddresses> {
  const local = getLocalIPv4Addresses();
  const publicIp = await getPublicIP();
  return { local, publicIp };
}

/** Pretty startup banner: public IP, port, and port-forwarding tip. */
export function printHostBanner(opts: {
  serverName: string;
  port: number;
  local?: string[];
  publicIp: string | null;
}): void {
  const { serverName, port, publicIp } = opts;
  const line = "─".repeat(56);

  const wanLine = publicIp
    ? `  Public IP ……………  ${publicIp}:${port}`
    : "  Public IP ……………  (could not detect — check your connection)";

  const message = [
    "",
    line,
    `  DOORS  ·  ${serverName}`,
    line,
    "  Server is running. Share your public IP with friends:",
    "",
    wanLine,
    "",
    `  Port …………………  ${port}`,
    "",
    "  ── How friends join ──────────────────────────────",
    "  • They type this exact IP:port in Find → Custom server.",
    "    Community servers are not listed in the game.",
    "  • Join password: required (from config.json). Share it with the IP.",
    "  • Over the internet → use the Public IP above,",
    `    and forward TCP port ${port} on your router to this PC.`,
    "",
    "  ── Port forwarding ─────────────────────────────",
    "  Port forwarding tells your router to send game traffic",
    "  on this port to your computer. Without it, friends",
    "  outside your network usually cannot connect.",
    "",
    `  Guides:  ${PORT_FORWARD_GUIDE}`,
    `           ${PORT_FORWARD_EXPLAIN}`,
    "",
    "  Tip: In your router, create a rule for TCP",
    `  external port ${port} → this computer, port ${port}.`,
    "",
    "  Press Ctrl+C to stop the server.",
    line,
  ].join("\n");

  // Startup banner is intentional user-facing output (not game debug logs).
  console.log(message);
}
