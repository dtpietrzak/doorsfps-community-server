/**
 * Admin console command allowlist + arg parsing.
 *
 * Authority validates args before signing AdminActionTokens.
 * Game runtimes re-parse/normalize after verifying the token (defense in depth).
 * Client uses the same shapes for console → authorize body.
 */

export const ADMIN_ACTION_TYP = "admin_action" as const;

export type AdminActionClaims = {
  typ: typeof ADMIN_ACTION_TYP;
  /** Clerk user id. */
  sub: string;
  /** Allowlisted command name (lowercase). */
  cmd: string;
  /** Structured args (never a raw shell string). */
  args: Record<string, unknown>;
  /** Unix seconds expiry. */
  exp: number;
  /** Unique id for anti-replay. */
  jti: string;
  /** Optional authentic server id bind (ranked / easy / hard). */
  serverId?: string;
};

/** Known admin commands (extend here when adding more). */
export const ADMIN_COMMANDS = [
  "change_map",
  "kick",
  "track_bots",
  /**
   * Force doors always open (bot / yaw-dot testing). Optional `enabled` bool;
   * omit to toggle. Sticky across matches until toggled off.
   */
  "force_doors",
  /**
   * Connect as a non-playing spectator (admin console / status).
   * Token is consumed on Socket.IO handshake — not a mid-match AdminCommand.
   */
  "spectate",
  /**
   * Testing bypasses handled client-side (admin console) and re-verified by
   * each backend. `target` names what to unlock; add new targets here as
   * more unlockables land (e.g. `unlock raids`).
   */
  "unlock",
] as const;
export type AdminCommandName = (typeof ADMIN_COMMANDS)[number];

export function isAdminCommandName(cmd: string): cmd is AdminCommandName {
  return (ADMIN_COMMANDS as readonly string[]).includes(cmd);
}

export type ChangeMapArgs = {
  mapName: string;
};

export type KickArgs = {
  /** Display name (human, fill bot, or pool bot). Case-insensitive match. */
  name: string;
};

/** Unlockable targets for the `unlock` command. Extend as more land. */
export const UNLOCK_TARGETS = [
  /**
   * All raid catalog entries selectable without prior completions, plus
   * solo (1-player) raid parties for testing.
   */
  "raids",
] as const;
export type UnlockTarget = (typeof UNLOCK_TARGETS)[number];

export function isUnlockTarget(value: unknown): value is UnlockTarget {
  return typeof value === "string" &&
    (UNLOCK_TARGETS as readonly string[]).includes(value.trim().toLowerCase());
}

export type UnlockArgs = {
  target: UnlockTarget;
};

export function sanitizeUnlockTarget(raw: unknown): UnlockTarget | null {
  if (typeof raw !== "string") return null;
  const target = raw.trim().toLowerCase();
  return isUnlockTarget(target) ? target : null;
}

const MAP_NAME_MAX = 64;
const MAP_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** Kick target display name length (matches PLAYER_NAME_MAX). */
const KICK_NAME_MAX = 24;

export function sanitizeMapName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.trim();
  if (!name || name.length > MAP_NAME_MAX) return null;
  if (!MAP_NAME_RE.test(name)) return null;
  return name;
}

/**
 * Sanitize a kick target display name (human, fill bot, or pool bot).
 * Does not apply full name-moderation — server matches existing roster only.
 */
export function sanitizeKickName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.trim();
  if (!name || name.length > KICK_NAME_MAX) return null;
  // Reject control chars / path-ish junk; allow typical catalog names.
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return null;
  }
  return name;
}

export type ParseAdminCommandResult =
  | { ok: true; command: AdminCommandName; args: Record<string, unknown> }
  | { ok: false; error: string };

/**
 * Validate a structured command request (HTTP body or token claims).
 */
export function parseAdminCommandRequest(
  command: unknown,
  args: unknown,
): ParseAdminCommandResult {
  if (typeof command !== "string" || !command.trim()) {
    return { ok: false, error: "Missing command name." };
  }
  const cmd = command.trim().toLowerCase();
  if (!isAdminCommandName(cmd)) {
    return { ok: false, error: `Unknown admin command: ${cmd}` };
  }

  const bag =
    args && typeof args === "object" && !Array.isArray(args)
      ? (args as Record<string, unknown>)
      : {};

  if (cmd === "change_map") {
    const mapName = sanitizeMapName(bag.mapName);
    if (!mapName) {
      return {
        ok: false,
        error:
          "change_map requires a valid mapName (letters, numbers, . _ -; max 64).",
      };
    }
    return { ok: true, command: cmd, args: { mapName } };
  }

  if (cmd === "kick") {
    const name = sanitizeKickName(bag.name);
    if (!name) {
      return {
        ok: false,
        error: "kick requires a player name (max 24 characters).",
      };
    }
    return { ok: true, command: cmd, args: { name } };
  }

  if (cmd === "track_bots") {
    // Toggle bot heatmap collection for this match (no args).
    return { ok: true, command: cmd, args: {} };
  }

  if (cmd === "force_doors") {
    // Optional enabled: set explicitly; omit → server toggles.
    if ("enabled" in bag) {
      if (typeof bag.enabled !== "boolean") {
        return {
          ok: false,
          error: "force_doors enabled must be a boolean.",
        };
      }
      return { ok: true, command: cmd, args: { enabled: bag.enabled } };
    }
    return { ok: true, command: cmd, args: {} };
  }

  if (cmd === "spectate") {
    // Optional serverName is client-side lookup only; token carries serverId bind.
    return { ok: true, command: cmd, args: {} };
  }

  if (cmd === "unlock") {
    const target = sanitizeUnlockTarget(bag.target);
    if (!target) {
      return {
        ok: false,
        error: `unlock requires a target (${UNLOCK_TARGETS.join(", ")}).`,
      };
    }
    return { ok: true, command: cmd, args: { target } };
  }

  return { ok: false, error: `Unhandled admin command: ${cmd}` };
}

/**
 * Parse a console line into a remote admin command request.
 * Returns null when the line is not a known remote admin command
 * (caller should try local commands first).
 */
export function parseAdminConsoleLine(
  line: string,
): ParseAdminCommandResult | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(/\s+/);
  const cmd = parts[0]!.toLowerCase();
  if (!isAdminCommandName(cmd)) return null;

  if (cmd === "change_map") {
    const mapName = parts.slice(1).join(" ").trim();
    return parseAdminCommandRequest(cmd, { mapName });
  }

  if (cmd === "kick") {
    const name = parts.slice(1).join(" ").trim();
    return parseAdminCommandRequest(cmd, { name });
  }

  if (cmd === "track_bots") {
    return parseAdminCommandRequest(cmd, {});
  }

  if (cmd === "force_doors") {
    const arg = parts[1]?.toLowerCase();
    if (!arg) return parseAdminCommandRequest(cmd, {});
    if (arg === "on" || arg === "true" || arg === "1") {
      return parseAdminCommandRequest(cmd, { enabled: true });
    }
    if (arg === "off" || arg === "false" || arg === "0") {
      return parseAdminCommandRequest(cmd, { enabled: false });
    }
    return {
      ok: false,
      error: "force_doors accepts on/off (or no args to toggle).",
    };
  }

  if (cmd === "spectate") {
    // Client handles server name lookup; line is not a remote AdminCommand emit.
    return null;
  }

  if (cmd === "unlock") {
    // Unlock toggles are client-local testing state (admin console); parse
    // here so the shared shape stays the source of truth for targets.
    const target = parts.slice(1).join(" ").trim();
    return parseAdminCommandRequest(cmd, { target });
  }

  return parseAdminCommandRequest(cmd, {});
}
